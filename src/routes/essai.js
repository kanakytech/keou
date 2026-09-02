/**
 * Essai communautaire — génération anonyme BYOK + galerie publique
 *
 * POST   /api/essai/generer      filtre de prompt → job mis en file
 * GET    /api/essai/statut/:id   statut + position dans la file (polling)
 * GET    /api/essai/galerie      galerie publique paginée (récentes d'abord)
 * POST   /api/essai/signaler/:id signalement (auto-masquage à 3 signalements)
 * GET    /api/essai/image/:id    streaming protégé (inline, Range/206, ?v=1 → vignette)
 * DELETE /api/essai/admin/:id    suppression admin (auth existante requireAdmin)
 *
 * Studio anonyme (« Launch Keou » sans compte — mêmes règles de sortie) :
 * POST   /api/essai/upload            image source (R2 essai/uploads/, éphémère)
 * POST   /api/essai/studio/generate   visuel produit (img→img, brief studio)
 * POST   /api/essai/studio/polish     retouche pro d'un résultat anonyme
 * POST   /api/essai/studio/remix      ré-imagination (prompt visiteur filtré)
 * POST   /api/essai/studio/adapt      adaptation de ratio
 * POST   /api/essai/studio/video      animation d'une image (img→vidéo)
 * POST   /api/essai/studio/upscale    agrandissement Topaz d'une image
 * POST   /api/essai/studio/tts        voix de synthèse (texte visiteur filtré)
 * POST   /api/essai/studio/sfx        bruitage (texte visiteur filtré)
 * GET    /api/essai/studio/status/:id statut au format attendu par studio.html
 *                                     ({ ready, resultUrl, state, failed, media })
 *
 * Ordonnancement : la file ne se sert plus en FIFO strict mais au tour par tour
 * entre adresses IP (src/lib/essai-queue.js). L'en-tête annonçait « file FIFO »
 * bien après le changement : la position rendue au client est un rang d'arrivée,
 * pas une promesse d'ordre de service. Ne pas la présenter autrement.
 *
 * Sécurité :
 *   - La clé du visiteur arrive via X-Provider-Key (même mécanisme BYOK que
 *     le studio — requestContext), n'est jamais persistée ni loggée.
 *   - ids UUID v4 : non séquentiels, non devinables.
 *   - Le RÉSULTAT est servi par proxy : aucune URL R2 ni provider du média
 *     produit n'atteint le client. Une seule URL R2 lui revient, et c'est la
 *     sienne : POST /upload rend l'adresse de la source qu'il vient de
 *     déposer, dont le studio a besoin pour enchaîner. L'affirmation absolue
 *     d'avant (« aucune URL R2 n'atteint le client ») décrivait le fichier tel
 *     qu'il était AVANT le studio anonyme.
 *   - Une clé d'idempotence facultative (idempotencyKey) déduplique les
 *     lancements — sans elle, un double-clic partait deux fois sur la clé
 *     KIE.AI du visiteur, donc sur son argent. Voir « Idempotence » plus bas.
 *   - Toute sortie anonyme est publiée dans la galerie — c'est la modération
 *     par transparence. Elle est aussi enregistrable : le filigrane est ce qui
 *     protège le travail, pas un bouton absent. Il couvre l'image (sharp) et la
 *     vidéo (ffmpeg, depuis le 25/08) ; le son n'en porte aucun, faute de
 *     pouvoir marquer une piste sonore sans l'abîmer. On l'annonce au visiteur.
 */

import { Router } from 'express';
import { randomUUID, randomBytes, createHash } from 'crypto';
import multer from 'multer';
import sharp from 'sharp';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config.js';
import { query, queryOne, queryAll } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { clientIp } from '../middleware/rateLimit.js';
import { getRequestProviderKey } from '../utils/requestContext.js';
import { checkPrompt } from '../lib/prompt-filter.js';
import { enqueue, positionOf, queueStats, mediaForKind } from '../lib/essai-queue.js';
// r2Client (l'export par défaut de r2.js) sert UNIQUEMENT à demander un
// intervalle d'octets : voir getObjectRange plus bas. Tout le reste passe par
// les fonctions nommées du module.
import r2Client, { getObjectStream, deleteFromR2, uploadToR2, getPresignedUrl, storageConfigured, STORAGE_MISSING } from '../lib/r2.js';
import { assertSafeUrl } from '../utils/safeUrl.js';

const router = Router();

// L'essai n'existe que sur l'édition communautaire hébergée — une instance
// white-label (enterprise) ou self-host (opensource) ne doit pas exposer un
// mur public. Même convention que requireEnterprise : 404, pas 403.
router.use((req, res, next) => {
  if (config.edition !== 'community') return res.status(404).json({ error: 'Not found' });
  next();
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Whitelist stricte — mêmes ratios que jarvis.js (nano-banana-pro les accepte tous).
const VALID_FORMATS = ['1:1', '16:9', '9:16', '3:4', '4:3', '3:2', '2:3'];
// Modes de rendu vidéo, réunion des vocabulaires du catalogue : kling parle en
// std/pro, grok en fun/normal. Chaque modèle ignore ce qui ne le concerne pas ;
// la liste ne sert qu'à ne pas relayer une valeur inventée par le client.
const VIDEO_MODES = ['std', 'pro', 'fun', 'normal'];
// Déclinaisons veo3 acceptées par le fournisseur.
const VEO_VARIANTS = ['veo3', 'veo3_fast', 'veo3_lite'];
const PAGE_SIZE = 24;
const MAX_REPORTS_BEFORE_HIDE = 3;

// La galerie affiche le texte d'une voix ou d'un bruitage comme n'importe quel
// prompt — et c'est le SEUL endroit où un humain pourra un jour le relire.
const GALLERY_TEXT_EXCERPT = 500;

// Bornes des outils créatifs. Elles étaient reprises telles quelles des routes
// d'un compte (src/routes/tools.js : 5000 caractères pour la voix), mais un
// compte est identifié et sa sortie reste privée, alors que TOUT ce qui sort
// d'ici est publié et modéré par la seule transparence. Avec 5000 caractères
// acceptés pour 500 publiés, on pouvait faire prononcer 4500 caractères que
// personne ne relirait jamais : le filtre automatique voyait bien le texte
// entier, mais un modérateur humain n'en voyait que le début. La voix anonyme
// est donc bornée à ce que la galerie publie. Le jour où quelqu'un remonte
// MAX_TTS_CHARS, la publication suivra (aucun slice à l'appel), ce qui est le
// mauvais choix qui échoue du bon côté.
const MAX_TTS_CHARS = GALLERY_TEXT_EXCERPT;
const MAX_SFX_CHARS = 450; // déjà sous l'extrait : le bruitage est publié en entier

// ─── Vignettes de galerie ───
// Une création pèse ~2,2 Mo : quatre cases de 300 px faisaient télécharger
// 8,75 Mo, et la galerie ne s'affichait pas sur une connexion mobile. 640 px
// couvre la case en écran Retina sans servir l'original.
const THUMB_MAX_PX = 640;
const THUMB_QUALITY = 72;
// Un média est identifié par un UUID et n'est jamais réécrit : le no-store
// d'origine faisait retélécharger l'objet entier à chaque affichage. Mais le
// drapeau `hidden` existe — une création signalée trois fois est masquée, et un
// cache long la garderait vivante dans les navigateurs qui l'ont déjà vue.
// Cinq minutes est le compromis : la galerie et le lecteur vidéo cessent de
// retélécharger, et un contenu masqué disparaît en quelques minutes au pire.
const MEDIA_CACHE_SECONDS = 300;

// ─── Idempotence ───
//
// Côté compte, une clé d'idempotence déduplique les lancements (findIdempotent
// dans src/lib/keou-actions.js, appliquée par src/routes/generate.js et
// src/routes/tools.js). Les routes anonymes ne la lisaient pas du tout : un
// double-clic, ou un réessai après une réponse perdue en route, partait DEUX
// fois. Sur un compte, un doublon coûte des crédits que la plateforme peut
// rembourser ; ici il coûte au visiteur, sur SA clé KIE.AI, et rien ne le lui
// rendra. C'est le pire endroit du produit pour ne pas dédupliquer.
//
// Ce qui est écrit en base n'est PAS la clé du client mais sha256(ip + clé) :
//   - la clé brute d'un visiteur anonyme serait un identifiant durable de plus
//     dans une table qui, par construction, n'en porte aucun ; une empreinte
//     n'en est pas un et ne se relit pas ;
//   - elle lie la clé à l'IP, ce qui est la règle demandée (« même clé, même
//     IP ») et ferme au passage la porte évidente : sans ce lien, envoyer une
//     clé devinée rendrait la tâche d'un autre visiteur.
//
// 200 caractères, parce que c'est EXACTEMENT la borne que l'adaptateur anonyme
// applique avant d'envoyer (public/shared/anon.js). Une borne serveur plus
// basse rejetterait en 400 une clé que le client tient pour valable : la
// protection contre la double facturation deviendrait une panne.
const MAX_IDEMPOTENCY_KEY = 200;

// La colonne idempotency_key peut manquer : src/migrate.js n'appartient pas à
// ce lot, et un déploiement peut précéder sa migration. Sans ce sondage, une
// colonne absente ferait échouer CHAQUE génération anonyme (42703
// undefined_column) — infiniment pire que le double-clic qu'on répare. On sonde
// une fois par processus, puis on s'en souvient ; sans la colonne, la
// déduplication est simplement inactive et tout le reste fonctionne.
let colonneIdempotence = null;
async function idempotenceDisponible() {
  if (colonneIdempotence === null) {
    try {
      /* On vérifie la colonne ET l'index — pas seulement la colonne.
       *
       * `ON CONFLICT` exige une contrainte unique. Une migration à moitié
       * appliquée (colonne posée, index oublié) faisait donc échouer CHAQUE
       * génération anonyme en 42P10, et studio.html réessayait trois fois : le
       * studio public tombait entier. Sonder la colonne seule laissait croire
       * que tout allait bien. */
      const trouvee = await queryOne(
        `SELECT
           (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'essai_generations' AND column_name = 'idempotency_key') AS colonne,
           (SELECT 1 FROM pg_indexes
             WHERE tablename = 'essai_generations' AND indexname = 'idx_essai_idempotency') AS index`
      );
      colonneIdempotence = Boolean(trouvee && trouvee.colonne && trouvee.index);
      if (!colonneIdempotence) {
        const manque = !trouvee?.colonne ? 'colonne' : 'index unique';
        console.warn(`[ESSAI] ${manque} idempotency_key absent — deduplication anonyme inactive (sans danger)`);
      }
    } catch (err) {
      console.error('[ESSAI sonde idempotence]', err.message);
      colonneIdempotence = false;
    }
  }
  return colonneIdempotence;
}

/**
 * Empreinte d'idempotence du couple (IP, clé fournie par le client).
 *
 * Rend { empreinte: null } quand le client n'en fournit pas — c'est le cas
 * normal aujourd'hui. Rend { error } quand la clé est inexploitable, plutôt que
 * de l'ignorer en silence : une clé ignorée, c'est la garantie de
 * non-double-facturation qui disparaît sans que personne s'en aperçoive.
 *
 * @param {import('express').Request} req
 * @param {unknown} brut  req.body.idempotencyKey, tel qu'il arrive
 * @returns {{ empreinte: string|null } | { error: string }}
 */
function empreinteIdempotence(req, brut) {
  if (brut === undefined || brut === null || brut === '') return { empreinte: null };
  if (typeof brut !== 'string') return { error: 'idempotencyKey must be a string' };
  const cle = brut.trim();
  if (!cle) return { empreinte: null };
  if (cle.length > MAX_IDEMPOTENCY_KEY) {
    return { error: `idempotencyKey must be ${MAX_IDEMPOTENCY_KEY} characters or less` };
  }
  // Le saut de ligne sépare les deux champs : sans lui, ('1.2.3.4', '5abc') et
  // ('1.2.3.45', 'abc') donneraient la même empreinte, donc la tâche de l'un
  // rendue à l'autre.
  return { empreinte: createHash('sha256').update(`${clientIp(req)}\n${cle}`).digest('hex') };
}

/**
 * La tâche déjà lancée sous cette empreinte, ou null.
 *
 * Deux bornes, et chacune évite un piège :
 *
 *  - on ignore les tâches ÉCHOUÉES. Sans ça, la relance automatique du studio
 *    après un 500 recevait l'échec précédent au lieu de repartir : un raté
 *    passager du fournisseur devenait définitif, et le bouton « réessayer »
 *    ne pouvait plus rien réessayer.
 *  - on ne remonte pas au-delà d'une heure. L'empreinte tient compte de
 *    l'adresse et de la clé fournies par le client ; sans limite de temps, une
 *    clé réutilisée le lendemain rendrait la création de la veille au lieu
 *    d'en lancer une neuve.
 *
 * La fenêtre couvre largement le seul cas qu'on veut attraper : le double-clic
 * et la relance après une réponse perdue, qui se comptent en secondes.
 */
function tacheParEmpreinte(empreinte) {
  return queryOne(
    `SELECT id, status, media, kind FROM essai_generations
      WHERE idempotency_key = $1
        AND status <> 'failed'
        AND created_at > NOW() - INTERVAL '1 hour'`,
    [empreinte]
  );
}

/**
 * Réponse rendue quand une clé d'idempotence désigne une tâche déjà lancée.
 * `deduped` porte le même nom que sur le chemin d'un compte (generate.js) :
 * un client qui sait le lire n'a pas deux vocabulaires à apprendre.
 *
 * @param {boolean} studio  format attendu par studio.html (taskId/generationId)
 */
function rendreTacheExistante(res, ligne, studio) {
  const base = { id: ligne.id, position: positionOf(ligne.id), status: ligne.status, deduped: true };
  if (!studio) return res.json(base);
  return res.json({
    ...base,
    taskId: ligne.id,
    generationId: ligne.id,
    type: ligne.kind,
    // Même résolution du média que partout ailleurs : la colonne fait foi, la
    // table des kinds ne sert que de repli pour les lignes qui la précèdent.
    media: ligne.media || mediaForKind(ligne.kind).media,
  });
}

/**
 * Insère la ligne de génération EN RÉSERVANT l'empreinte d'idempotence.
 *
 * La réservation se fait dans l'INSERT, pas par une lecture préalable : entre
 * un SELECT et un INSERT, node rend la main, et deux requêtes jumelles (le
 * double-clic, précisément) passent toutes les deux le SELECT avant que l'une
 * ait inséré. C'est l'index unique qui tranche, pas nous.
 *
 * @returns {Promise<boolean>} false si l'empreinte était déjà prise — l'appelant
 *   rend alors la tâche existante au lieu d'en mettre une seconde en file.
 */
async function reserverGeneration({ id, prompt, format, kind, media, empreinte }) {
  if (empreinte) {
    const ligne = await queryOne(
      `INSERT INTO essai_generations (id, prompt, status, format, kind, media, idempotency_key)
            VALUES ($1, $2, 'queued', $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING id`,
      [id, prompt, format, kind, media, empreinte]
    );
    return Boolean(ligne);
  }
  await query(
    `INSERT INTO essai_generations (id, prompt, status, format, kind, media) VALUES ($1, $2, 'queued', $3, $4, $5)`,
    [id, prompt, format, kind, media]
  );
  return true;
}

// ─── Générer ───
router.post('/generer', async (req, res) => {
  try {
    // Clé BYOK : uniquement depuis le header (jamais depuis le body → jamais
    // dans un log de body ni un dump de requête).
    const apiKey = getRequestProviderKey();
    if (!apiKey) {
      return res.status(400).json({ error: 'API key required — paste your KIE.AI key (it stays in your browser)' });
    }

    const { prompt, format, consent, idempotencyKey } = req.body || {};
    if (consent !== true) {
      return res.status(400).json({ error: 'Consent required: everything created here is public' });
    }
    const cleanPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (cleanPrompt.length < 3) return res.status(400).json({ error: 'Prompt too short (3 characters minimum)' });
    if (cleanPrompt.length > 500) return res.status(400).json({ error: 'Prompt too long (500 characters maximum)' });

    // Filtre de modération en amont — refus poli, aucune tâche créée
    const check = checkPrompt(cleanPrompt);
    if (check.blocked) return res.status(422).json({ error: check.message, category: check.category });

    const cleanFormat = VALID_FORMATS.includes(format) ? format : '1:1';

    const idem = empreinteIdempotence(req, idempotencyKey);
    if (idem.error) return res.status(400).json({ error: idem.error });
    const empreinte = idem.empreinte && (await idempotenceDisponible()) ? idem.empreinte : null;
    if (empreinte) {
      const deja = await tacheParEmpreinte(empreinte);
      if (deja) return rendreTacheExistante(res, deja, false);
    }

    const id = randomUUID();

    // kind et media étaient laissés aux valeurs par défaut de la table
    // ('text' et 'image') ; on les écrit maintenant explicitement, parce que
    // l'insertion est partagée avec le studio anonyme. Les valeurs sont
    // exactement celles que la base posait — aucune ligne ne change de nature.
    const reserve = await reserverGeneration({
      id, prompt: cleanPrompt, format: cleanFormat, kind: 'text', media: 'image', empreinte,
    });
    if (!reserve) {
      // Course perdue contre une requête jumelle : c'est le double-clic. On rend
      // SA tâche plutôt que d'en facturer une seconde au visiteur.
      const deja = await tacheParEmpreinte(empreinte);
      if (deja) return rendreTacheExistante(res, deja, false);
      return res.status(409).json({ error: 'Duplicate request — generation already in progress' });
    }

    const q = enqueue({ id, prompt: cleanPrompt, format: cleanFormat, apiKey, ip: clientIp(req) });
    if (!q.ok) {
      await query(`DELETE FROM essai_generations WHERE id = $1`, [id]).catch(() => {});
      return res.status(q.code).json({ error: q.error });
    }

    res.json({ id, position: q.position, status: 'queued' });
  } catch (e) {
    console.error('[ESSAI generer]', e.message);
    res.status(500).json({ error: 'Could not start the generation — try again' });
  }
});

// ─── Statut (polling client) ───
router.get('/statut/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Not found' });

    const row = await queryOne(
      `SELECT status, error, media, kind FROM essai_generations WHERE id = $1`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });

    const payload = { id, status: row.status };
    if (row.status === 'queued') payload.position = positionOf(id);
    if (row.status === 'completed') {
      payload.imageUrl = `/api/essai/image/${id}`;
      // Sans le média, le client ne sait pas quelle balise ouvrir et posait un
      // MP4 dans un <img>. La colonne fait foi ; pour les lignes antérieures à
      // son arrivée, on retombe sur la table des kinds — jamais sur une
      // deuxième table écrite ici, qui divergerait au premier ajout.
      payload.media = row.media || mediaForKind(row.kind).media;
    }
    // Le repli s'écrit en anglais comme tout texte d'interface du dépôt — la
    // traduction vit dans i18n/fr.json, qui porte déjà cette phrase exacte. En
    // dur en français, un visiteur anglophone lisait du français, et le
    // dictionnaire, qui apparie la chaîne anglaise EXACTE, n'avait aucune prise
    // dessus. row.error vient de la file, qui parle anglais elle aussi
    // (src/lib/essai-queue.js) — les deux moitiés de ce `||` sont enfin dans la
    // même langue.
    if (row.status === 'failed') payload.error = row.error || 'The generation failed';
    res.json(payload);
  } catch (e) {
    console.error('[ESSAI statut]', e.message);
    res.status(500).json({ error: 'Status unavailable' });
  }
});

// ─── Galerie publique (paginée, récentes d'abord) ───
router.get('/galerie', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const offset = (page - 1) * PAGE_SIZE;

    const rows = await queryAll(
      `SELECT id, prompt, created_at, media, kind FROM essai_generations
        WHERE status = 'completed' AND hidden = FALSE
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2`,
      [PAGE_SIZE + 1, offset]
    );

    const hasMore = rows.length > PAGE_SIZE;
    // Le mur communautaire accueille les trois médias : chaque entrée dit
    // lequel, faute de quoi la galerie tenterait d'afficher un MP4 dans une
    // balise <img>. imageUrl garde son nom — l'URL est déjà publique.
    const items = rows.slice(0, PAGE_SIZE).map((r) => ({
      id: r.id,
      prompt: r.prompt,
      imageUrl: `/api/essai/image/${r.id}`,
      // Repli par la table des kinds, pas par un 'image' écrit en dur ici :
      // une deuxième table finirait par diverger de MEDIA_BY_KIND.
      media: r.media || mediaForKind(r.kind).media,
      createdAt: r.created_at,
    }));

    res.json({ items, page, hasMore, queue: queueStats() });
  } catch (e) {
    console.error('[ESSAI galerie]', e.message);
    res.status(500).json({ error: 'Gallery unavailable' });
  }
});

/**
 * Lit un objet R2 en autorisant un intervalle d'octets.
 *
 * getObjectStream() (src/lib/r2.js) ne transmet aucun Range : elle rend
 * toujours l'objet entier, ce qui interdisait la réponse 206 dont Safari a
 * besoin pour DÉMARRER une vidéo. r2.js est partagé par d'autres surfaces et
 * n'appartient pas à ce lot, donc on reprend ici le client S3 qu'il exporte
 * déjà par défaut — même bucket, mêmes identifiants, aucune dépendance
 * nouvelle. Le jour où r2.js acceptera un intervalle, cette fonction disparaît.
 *
 * @param {string} key
 * @param {string} range en-tête Range brut ('bytes=0-1023'), ou null
 * @returns {Promise<{ body: import('stream').Readable, contentLength?: number, contentRange?: string }>}
 */
async function getObjectRange(key, range) {
  const out = await r2Client.send(new GetObjectCommand({
    Bucket: config.r2.bucket,
    Key: key,
    Range: range || undefined,
  }));
  return { body: out.Body, contentLength: out.ContentLength, contentRange: out.ContentRange };
}

/**
 * Taille exacte d'un objet R2, ou null si elle ne peut pas être lue.
 *
 * Sert au seul Content-Range d'une réponse 416 — c'est la seule information qui
 * permette au lecteur de redemander un intervalle valable au lieu de réessayer
 * le même. HeadObject ne rapatrie aucun corps : le coût est une requête, et
 * uniquement dans le cas rare d'un intervalle hors bornes.
 *
 * @param {string} key
 * @returns {Promise<number|null>}
 */
async function tailleObjet(key) {
  try {
    const out = await r2Client.send(new HeadObjectCommand({
      Bucket: config.r2.bucket,
      Key: key,
    }));
    return typeof out.ContentLength === 'number' ? out.ContentLength : null;
  } catch (err) {
    // Jamais de détail au client (pas de fuite de clé d'objet) : on rend null
    // et le 416 partira sans Content-Range.
    console.error('[ESSAI taille objet]', err.name || err.message);
    return null;
  }
}

/**
 * En-têtes communs à toute sortie média de l'essai.
 * `ranges` : n'annoncer Accept-Ranges que sur les réponses qu'on sait vraiment
 * découper — l'annoncer sur une vignette servie depuis un Buffer serait une
 * promesse qu'on ne tient pas.
 */
function setMediaHeaders(res, { mime, ext, ranges }) {
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', `public, max-age=${MEDIA_CACHE_SECONDS}`);
  res.setHeader('Content-Disposition', `inline; filename="keou-essai.${ext}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Anti-hotlinking : le média ne peut être ni encadré (iframe) ni embarqué
  // par un autre site — il ne vit que dans la galerie de l'essai.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; default-src 'none'");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (ranges) res.setHeader('Accept-Ranges', 'bytes');
}

/** Un flux R2 → Buffer (sharp travaille en mémoire, pas en flux). */
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Clé R2 de la vignette. Deux formats = deux objets, jamais mélangés. */
function thumbKeyFor(id, webp) {
  return `essai/${id}-v1.${webp ? 'webp' : 'jpg'}`;
}

/**
 * Sert la vignette de galerie (?v=1) d'une image.
 *
 * Elle est calculée une seule fois puis déposée sur R2 : la galerie est la page
 * la plus visitée de l'essai, recalculer 2,2 Mo avec sharp à chaque vignette
 * coûterait plus cher que l'octet économisé. Si deux requêtes arrivent avant le
 * premier dépôt, elles produisent le même objet sous la même clé — le doublon
 * est sans effet. Un échec d'écriture R2 n'est pas une erreur pour le visiteur :
 * on lui sert quand même les octets, on recalculera à la prochaine visite.
 */
async function serveThumbnail(res, id, r2Key, wantsWebp) {
  const key = thumbKeyFor(id, wantsWebp);
  const mime = wantsWebp ? 'image/webp' : 'image/jpeg';
  const ext = wantsWebp ? 'webp' : 'jpg';

  // Les en-têtes ne sont posés qu'une fois R2 acquis : une erreur de lecture
  // doit pouvoir répondre 404 sans traîner un Content-Type d'image.
  let cached = null;
  try { cached = await getObjectStream(key); }
  catch { /* pas encore de vignette (NoSuchKey) — on la fabrique plus bas */ }

  if (cached) {
    setMediaHeaders(res, { mime, ext, ranges: false });
    // La vignette est négociée sur l'en-tête Accept : sans Vary, un cache
    // partagé servirait du WebP à un client qui n'en veut pas.
    res.setHeader('Vary', 'Accept');
    if (cached.contentLength) res.setHeader('Content-Length', cached.contentLength);
    cached.body.on('error', (err) => {
      console.error('[ESSAI thumb stream]', err.message);
      if (!res.headersSent) res.status(502).end(); else res.destroy();
    });
    return cached.body.pipe(res);
  }

  const src = await getObjectStream(r2Key);
  const raw = await streamToBuffer(src.body);
  const pipeline = sharp(raw).rotate().resize({
    width: THUMB_MAX_PX,
    height: THUMB_MAX_PX,
    fit: 'inside',
    withoutEnlargement: true,
  });
  const buf = await (wantsWebp
    ? pipeline.webp({ quality: THUMB_QUALITY })
    : pipeline.jpeg({ quality: THUMB_QUALITY, mozjpeg: true })).toBuffer();

  if (storageConfigured()) {
    await uploadToR2(buf, key, mime).catch((err) => {
      console.error('[ESSAI thumb upload]', err.message);
    });
  }

  setMediaHeaders(res, { mime, ext, ranges: false });
  res.setHeader('Vary', 'Accept');
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
}

// ─── Média protégé (streaming proxy — image, vidéo ou son) ───
// L'URL garde son nom historique (/image/:id) : elle est déjà publiée dans la
// galerie et citée par l'adaptateur anonyme. Elle sert désormais les trois
// médias, le type étant lu dans la même table que celle qui a écrit l'objet.
//
// ?v=1 rend la vignette de galerie (images seules). Une vidéo ou un son
// ignorent le paramètre : il n'y a rien à réduire, et la galerie ne charge
// d'eux que les métadonnées.
router.get('/image/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).end();

    const row = await queryOne(
      `SELECT r2_key, hidden, status, kind, media FROM essai_generations WHERE id = $1`,
      [id]
    );
    if (!row || row.status !== 'completed' || row.hidden || !row.r2_key) return res.status(404).end();

    // Type et extension viennent de la table des médias — celle-là même qui a
    // décidé sous quelle forme la file a déposé l'objet sur R2. Avec nosniff
    // plus bas, un MP4 annoncé en image/png ne se lirait nulle part : le
    // navigateur s'interdit de rattraper une déclaration fausse.
    let out = mediaForKind(row.kind);
    // Cette route lisait le média par le SEUL kind, alors que /statut, /galerie
    // et /studio/status lisent d'abord la colonne. Une ligne dont le kind ne
    // serait pas (ou plus) dans la table retombe sur 'text', donc sur 'image' :
    // c'est ici que sharp aurait reçu un MP4. La colonne fait foi, comme
    // partout ailleurs ; le mime et l'extension, eux, n'existent que dans la
    // table des kinds, d'où les deux lectures.
    const media = row.media || out.media;

    /* Le type servi suit le FICHIER, pas la table.
     *
     * La table des kinds fige mp3 / audio/mpeg pour le son. Or le moteur de voix
     * rend du WAV : le fichier était donc annoncé sous un type qu'il n'avait pas,
     * et avec le nosniff posé plus bas, un navigateur qui prend l'en-tête au mot
     * refuse de lire. La voix aurait été produite, facturée, et muette.
     * La clé R2 porte la vraie extension — c'est elle qui décide. */
    const extReelle = (String(row.r2_key).match(/\.([a-z0-9]{2,5})$/i) || [])[1];
    const mimeParExtension = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
      mp4: 'video/mp4', webm: 'video/webm',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg',
      flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
    };
    if (extReelle && mimeParExtension[extReelle.toLowerCase()]) {
      out = { ...out, ext: extReelle.toLowerCase(), mime: mimeParExtension[extReelle.toLowerCase()] };
    }

    if (req.query.v === '1' && media === 'image') {
      const wantsWebp = /image\/webp/i.test(req.headers.accept || '');
      return await serveThumbnail(res, id, row.r2_key, wantsWebp);
    }

    // Safari EXIGE une réponse 206 pour lire une vidéo : sans elle la lecture
    // ne démarre pas du tout. Partout ailleurs, c'est ce qui rend le
    // déplacement dans la timeline possible et évite de retélécharger le
    // fichier entier à chaque relecture. On ne traite que l'intervalle simple
    // ('bytes=a-b', 'bytes=a-', 'bytes=-n') : un Range multiple est rare et la
    // norme autorise à le servir en 200 complet plutôt que de le mal découper.
    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range.trim() : '';
    if (/^bytes=\d*-\d*$/.test(rangeHeader) && rangeHeader !== 'bytes=-') {
      let part = null;
      try {
        part = await getObjectRange(row.r2_key, rangeHeader);
      } catch (err) {
        // Intervalle hors bornes. On répondait alors l'objet ENTIER en 200 : un
        // lecteur qui demandait 'bytes=99999999-' recevait donc plusieurs
        // mégaoctets qu'il jetait aussitôt — sur la clé du visiteur c'est de la
        // bande passante, et côté client le bug restait invisible. RFC 9110
        // §15.4.17 demande un 416 qui DIT la taille réelle ; le prétexte
        // d'alors (« on ne saurait pas remplir le Content-Range sans un HEAD »)
        // décrivait exactement la solution : HeadObject rend la taille en une
        // requête sans corps, et seulement dans ce cas rare.
        //
        // R2 n'est pas S3 : selon la version du SDK l'erreur arrive tantôt
        // nommée InvalidRange, tantôt seulement en 416. On reconnaît les deux,
        // faute de quoi le cas retombait dans le throw et sortait en 404.
        const horsBornes = err?.name === 'InvalidRange'
          || err?.Code === 'InvalidRange'
          || err?.$metadata?.httpStatusCode === 416;
        if (!horsBornes) throw err;
        const taille = await tailleObjet(row.r2_key);
        setMediaHeaders(res, { mime: out.mime, ext: out.ext, ranges: true });
        // Sans la taille, on rend quand même 416 : la norme ne fait qu'y
        // RECOMMANDER le Content-Range, et refuser franchement vaut mieux que
        // servir un fichier entier que personne n'a demandé.
        if (taille !== null) res.setHeader('Content-Range', `bytes */${taille}`);
        return res.status(416).end();
      }
      if (part) {
        setMediaHeaders(res, { mime: out.mime, ext: out.ext, ranges: true });
        res.status(206);
        if (part.contentRange) res.setHeader('Content-Range', part.contentRange);
        if (part.contentLength !== undefined) res.setHeader('Content-Length', part.contentLength);
        part.body.on('error', (err) => {
          console.error('[ESSAI image range]', err.message);
          if (!res.headersSent) res.status(502).end(); else res.destroy();
        });
        return part.body.pipe(res);
      }
    }

    const obj = await getObjectStream(row.r2_key);
    setMediaHeaders(res, { mime: out.mime, ext: out.ext, ranges: true });
    if (obj.contentLength) res.setHeader('Content-Length', obj.contentLength);

    obj.body.on('error', (err) => {
      console.error('[ESSAI image stream]', err.message);
      if (!res.headersSent) res.status(502).end();
      else res.destroy();
    });
    obj.body.pipe(res);
  } catch (e) {
    // NoSuchKey ou erreur R2 — jamais de détail (pas de fuite de clé d'objet)
    console.error('[ESSAI image]', e.name || e.message);
    if (!res.headersSent) res.status(404).end();
  }
});

// ─── Signaler ───
router.post('/signaler/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Not found' });

    const updated = await queryOne(
      `UPDATE essai_generations
          SET report_count = report_count + 1,
              hidden = (report_count + 1 >= $2)
        WHERE id = $1 AND status = 'completed'
        RETURNING hidden`,
      [id, MAX_REPORTS_BEFORE_HIDE]
    );
    if (!updated) return res.status(404).json({ error: 'Not found' });

    res.json({ ok: true, hidden: updated.hidden });
  } catch (e) {
    console.error('[ESSAI signaler]', e.message);
    res.status(500).json({ error: 'Could not report' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// STUDIO ANONYME — le studio complet (studio.html) sans compte, BYOK.
// Chaque opération passe par la même file essai : filigrane serveur, image
// stockée sur R2, publication dans la galerie communautaire, clé en RAM only.
// ═══════════════════════════════════════════════════════════════════════

const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
const ALLOWED_IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
/* L'agrandissement vidéo part d'une vidéo EXTERNE à la plateforme : c'est tout
 * son intérêt. On accepte donc aussi un fichier vidéo, avec sa propre limite —
 * 20 Mo suffisent à une photo, pas à un clip. */
const ALLOWED_VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

// ─── Upload anonyme (image source de génération, jamais publiée) ───
router.post('/upload', uploadImage.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const estVideo = !!ALLOWED_VIDEO_TYPES[req.file.mimetype];
    const ext = ALLOWED_IMAGE_TYPES[req.file.mimetype] || ALLOWED_VIDEO_TYPES[req.file.mimetype];
    if (!ext) return res.status(400).json({ error: 'Unsupported format. Use JPEG, PNG, WebP, GIF, MP4, WebM or MOV.' });
    const plafond = estVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (req.file.size > plafond) {
      return res.status(400).json({ error: estVideo ? 'Video too large (max 200MB)' : 'Image too large (max 20MB)' });
    }

    const key = `essai/uploads/${Date.now()}_${randomBytes(6).toString('hex')}.${ext}`;
    // Chemin d'upload du studio anonyme — le plus exposé d'un build public.
    if (!storageConfigured()) return res.status(503).json({ error: STORAGE_MISSING });

    const url = await uploadToR2(req.file.buffer, key, req.file.mimetype);
    res.json({ url });
  } catch (e) {
    console.error('[ESSAI upload]', e.message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

/**
 * Résout l'image source d'une opération studio anonyme.
 * - sourceId (uuid essai) : résultat anonyme précédent → URL R2 présignée
 *   fraîche (l'image filigranée stockée), jamais l'URL provider.
 * - imageUrl : upload R2 de /api/essai/upload (ou toute URL https publique) —
 *   contrôlée par assertSafeUrl (anti-SSRF), transmise au provider uniquement.
 *
 * Toutes les opérations à source du studio anonyme partent d'une IMAGE, y
 * compris la vidéo (image → vidéo) et l'agrandissement. Depuis que la même
 * table porte aussi des vidéos et des sons, un sourceId peut désigner un MP4 :
 * on le refuse ici, sinon le visiteur paierait de ses crédits un appel que le
 * modèle d'image rejetterait de toute façon.
 */
async function resolveStudioSource({ sourceId, imageUrl }) {
  if (sourceId) {
    if (!UUID_RE.test(sourceId)) return { error: 'Source not found' };
    const row = await queryOne(
      `SELECT r2_key, status, media, hidden FROM essai_generations WHERE id = $1`,
      [sourceId]
    );
    // `hidden` était lu par /image/:id mais pas ici : une création masquée
    // après trois signalements — donc jugée abusive — pouvait encore servir de
    // source à un remix, un agrandissement ou une vidéo, et revenir dans la
    // galerie sous un nouvel uuid. Le masquage doit couper la chaîne entière.
    if (!row || row.status !== 'completed' || row.hidden || !row.r2_key) return { error: 'Source not found' };
    if (row.media && row.media !== 'image') {
      return { error: 'This operation starts from an image — the source you picked is not one' };
    }
    return { url: await getPresignedUrl(row.r2_key, 3600) };
  }
  if (imageUrl) {
    try { assertSafeUrl(imageUrl); } catch { return { error: 'Invalid image URL' }; }
    return { url: imageUrl };
  }
  return { error: 'Source image required' };
}

/**
 * Nombre borné venu du client, ou null s'il n'y a rien d'exploitable.
 * Le null est important : `Number('abc')` vaut NaN, que JSON.stringify écrit
 * `null` — le réglage partirait donc quand même chez le fournisseur, vidé de
 * son sens. Mieux vaut ne pas l'envoyer et laisser le défaut du modèle jouer.
 */
function boundedNumber(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/**
 * Tronc commun des opérations studio anonymes : clé BYOK + consentement
 * obligatoires, filtre de prompt sur tout texte visiteur, insertion en base
 * puis mise en file. Répond au format du studio ({ taskId, generationId })
 * pour que studio.html fonctionne sans réécrire sa logique de batch.
 *
 * `params` porte les réglages propres à l'opération (vidéo, voix, bruitage,
 * agrandissement). Ils sont déjà bornés par la route appelante et portent le
 * nom qu'attend enqueue() — ce tronc commun n'a donc rien à en connaître.
 */
async function launchStudioJob(req, res, { kind, galleryPrompt, userText, format, imageUrl, creativeDirection, params = {} }) {
  const apiKey = getRequestProviderKey();
  if (!apiKey) {
    return res.status(400).json({ error: 'API key required — paste your KIE.AI key (it stays in your browser)' });
  }
  if (req.body?.consent !== true) {
    return res.status(400).json({ error: 'Consent required: everything created here is public' });
  }
  // Tout texte fourni par le visiteur passe le filtre de modération
  if (userText) {
    const check = checkPrompt(userText);
    if (check.blocked) return res.status(422).json({ error: check.message, category: check.category });
  }

  // Clé d'idempotence : lue ici et non dans chacune des huit routes — un seul
  // endroit à tenir, et aucune route ne peut être oubliée le jour où on en
  // ajoute une neuvième.
  const idem = empreinteIdempotence(req, req.body?.idempotencyKey);
  if (idem.error) return res.status(400).json({ error: idem.error });
  const empreinte = idem.empreinte && (await idempotenceDisponible()) ? idem.empreinte : null;
  if (empreinte) {
    const deja = await tacheParEmpreinte(empreinte);
    if (deja) return rendreTacheExistante(res, deja, true);
  }

  const cleanFormat = VALID_FORMATS.includes(format) ? format : '1:1';
  const id = randomUUID();
  const out = mediaForKind(kind);

  // media est écrit dès l'insertion, et pas seulement quand la file démarre le
  // job : derrière une file chargée, un job attend parfois plusieurs minutes en
  // 'queued', et le client qui sonde doit savoir tout de suite s'il prépare une
  // image, une vidéo ou un son.
  const reserve = await reserverGeneration({
    id, prompt: galleryPrompt, format: cleanFormat, kind, media: out.media, empreinte,
  });
  if (!reserve) {
    // Course perdue contre une requête jumelle — le double-clic exactement.
    const deja = await tacheParEmpreinte(empreinte);
    if (deja) return rendreTacheExistante(res, deja, true);
    return res.status(409).json({ error: 'Duplicate request — generation already in progress' });
  }

  const q = enqueue({ id, prompt: galleryPrompt, format: cleanFormat, apiKey, ip: clientIp(req), kind, imageUrl, creativeDirection, ...params });
  if (!q.ok) {
    await query(`DELETE FROM essai_generations WHERE id = $1`, [id]).catch(() => {});
    return res.status(q.code).json({ error: q.error });
  }

  // taskId = generationId = uuid essai : studio.html les réinjecte tels quels
  // dans son polling, que l'adaptateur anonyme redirige vers /studio/status.
  res.json({ id, taskId: id, generationId: id, position: q.position, status: 'queued', type: kind, media: out.media });
}

// ─── Studio : visuel produit (équivalent anonyme de POST /api/generate) ───
router.post('/studio/generate', async (req, res) => {
  try {
    // sourceId était absent de cette route alors que l'adaptateur anonyme
    // (public/shared/anon.js) l'envoie dès que la source est un rendu
    // précédent : enchaîner un visuel produit sur sa propre création répondait
    // « Source image required ». Les trois autres routes le lisaient déjà.
    const { sourceId, imageUrl, format, creativeDirection } = req.body || {};
    const cd = typeof creativeDirection === 'string' ? creativeDirection.trim().slice(0, 500) : '';
    const source = await resolveStudioSource({ sourceId, imageUrl });
    if (source.error) return res.status(400).json({ error: source.error });

    await launchStudioJob(req, res, {
      kind: 'image',
      // Ces libellés de galerie sont eux aussi du texte d'interface : le mur
      // public les affiche mot pour mot à la place du prompt, et ils étaient
      // écrits en français dans un source anglais. Ils ne partent PAS chez le
      // fournisseur (createProviderTask construit son propre prompt pour ce
      // kind) : les traduire ne change rien à ce qui est généré.
      galleryPrompt: cd || 'Product visual — anonymous studio',
      userText: cd || null,
      format,
      imageUrl: source.url,
      creativeDirection: cd || null,
    });
  } catch (e) {
    console.error('[ESSAI studio generate]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the generation — try again' });
  }
});

// ─── Studio : polish (retouche pro d'un résultat anonyme) ───
router.post('/studio/polish', async (req, res) => {
  try {
    const { sourceId, imageUrl, format } = req.body || {};
    const source = await resolveStudioSource({ sourceId, imageUrl });
    if (source.error) return res.status(400).json({ error: source.error });

    await launchStudioJob(req, res, {
      kind: 'polish',
      galleryPrompt: 'Studio retouch (polish) — anonymous studio',
      userText: null,
      format,
      imageUrl: source.url,
    });
  } catch (e) {
    console.error('[ESSAI studio polish]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the polish — try again' });
  }
});

// ─── Studio : remix (prompt visiteur, filtré) ───
router.post('/studio/remix', async (req, res) => {
  try {
    const { sourceId, imageUrl, format, remixPrompt } = req.body || {};
    const cleanPrompt = typeof remixPrompt === 'string' ? remixPrompt.trim() : '';
    if (cleanPrompt.length < 3) return res.status(400).json({ error: 'Prompt too short (3 characters minimum)' });
    if (cleanPrompt.length > 500) return res.status(400).json({ error: 'Prompt too long (500 characters maximum)' });
    const source = await resolveStudioSource({ sourceId, imageUrl });
    if (source.error) return res.status(400).json({ error: source.error });

    await launchStudioJob(req, res, {
      kind: 'remix',
      galleryPrompt: cleanPrompt,
      userText: cleanPrompt,
      format,
      imageUrl: source.url,
    });
  } catch (e) {
    console.error('[ESSAI studio remix]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the remix — try again' });
  }
});

// ─── Studio : adaptation de format ───
router.post('/studio/adapt', async (req, res) => {
  try {
    const { sourceId, imageUrl, format } = req.body || {};
    if (!VALID_FORMATS.includes(format)) {
      return res.status(400).json({ error: `Invalid format. Accepted formats: ${VALID_FORMATS.join(', ')}` });
    }
    const source = await resolveStudioSource({ sourceId, imageUrl });
    if (source.error) return res.status(400).json({ error: source.error });

    await launchStudioJob(req, res, {
      kind: 'adapt',
      galleryPrompt: `Format adaptation ${format} — anonymous studio`,
      userText: null,
      format,
      imageUrl: source.url,
    });
  } catch (e) {
    console.error('[ESSAI studio adapt]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the format adaptation — try again' });
  }
});

// ─── Studio : vidéo (équivalent anonyme de POST /api/video) ───
router.post('/studio/video', async (req, res) => {
  try {
    const { sourceId, imageUrl, format, aspectRatio, creativeDirection,
            videoModel, duration, resolution, mode, sound, generateAudio, variant } = req.body || {};
    const cd = typeof creativeDirection === 'string' ? creativeDirection.trim().slice(0, 500) : '';
    const source = await resolveStudioSource({ sourceId, imageUrl });
    if (source.error) return res.status(400).json({ error: source.error });

    // Chaque modèle reborne ensuite la durée à ce qu'il accepte (4-15 s, 3-15 s
    // ou 6-30 s selon le catalogue). La borne posée ici est celle du plus
    // permissif : elle ne remplace pas la leur, elle empêche qu'un client
    // envoie 10 000 ou « abc ».
    const secs = boundedNumber(duration, 3, 30);

    await launchStudioJob(req, res, {
      kind: 'video',
      galleryPrompt: cd || 'Video — anonymous studio',
      userText: cd || null,
      format,
      imageUrl: source.url,
      creativeDirection: cd || null,
      params: {
        // Le modèle n'est pas rejeté quand il est inconnu : la file retombe
        // d'elle-même sur le moins cher du catalogue, ce qui coûte moins au
        // visiteur qu'une erreur.
        videoModel: typeof videoModel === 'string' ? videoModel : null,
        // Transmise en TEXTE : kling-2.6 choisit ses 5 secondes par une
        // comparaison stricte avec la chaîne '5' — un nombre lui ferait rendre
        // 10 secondes en silence, et les autres modèles convertissent de toute
        // façon ce qu'ils reçoivent.
        duration: secs === null ? null : String(secs),
        resolution: ['480p', '720p'].includes(resolution) ? resolution : null,
        mode: VIDEO_MODES.includes(mode) ? mode : null,
        sound: sound === true,
        aspectRatio: VALID_FORMATS.includes(aspectRatio) ? aspectRatio : null,
        generateAudio: generateAudio === true,
        variant: VEO_VARIANTS.includes(variant) ? variant : null,
      },
    });
  } catch (e) {
    console.error('[ESSAI studio video]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the video — try again' });
  }
});

// ─── Studio : agrandissement Topaz (image uniquement) ───
router.post('/studio/upscale', async (req, res) => {
  try {
    const { sourceId, imageUrl, videoUrl, upscaleFactor } = req.body || {};
    // Le bouton 4K du studio raisonne en vidéo et envoie donc `videoUrl`, alors
    // que la file anonyme n'agrandit que des images. On accepte le nom du champ
    // sans rien supposer du média : resolveStudioSource refusera la source si
    // elle n'est pas une image.
    const source = await resolveStudioSource({ sourceId, imageUrl: imageUrl || videoUrl });
    if (source.error) return res.status(400).json({ error: source.error });

    // Mêmes facteurs qu'un compte (POST /api/tools/image-upscale).
    /* Topaz n'agrandit que d'un facteur 1, 2 ou 4 — le « 8x » n'existe pas chez
     * le fournisseur. Avant, la tâche partait et ÉCHOUAIT : visible, donc
     * remboursable. Puis on s'est mis à la rabattre sur 4 en silence, et elle
     * réussissait, facturée au tarif du 8x, sans que personne ne dise au client
     * qu'il recevait la moitié. On avait remplacé une panne par un mensonge.
     * On refuse, en nommant la raison. */
    const demande = String(upscaleFactor ?? '4');
    if (!['1', '2', '4'].includes(demande)) {
      return res.status(400).json({ error: 'Upscale factor must be 2 or 4 — the provider does not do more' });
    }
    const factor = demande;

    await launchStudioJob(req, res, {
      kind: 'upscale',
      galleryPrompt: `Resolution ×${factor} — anonymous studio`,
      userText: null,
      format: null,
      imageUrl: source.url,
      params: { upscaleFactor: factor },
    });
  } catch (e) {
    console.error('[ESSAI studio upscale]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the upscale — try again' });
  }
});

// ─── Studio : agrandissement vidéo (Topaz Video, source = une vidéo) ───
router.post('/studio/video-upscale', async (req, res) => {
  try {
    const { sourceId, videoUrl, upscaleFactor } = req.body || {};
    // La source doit être une VIDÉO — une image générée ne se sur-échantillonne
    // pas ici. On résout à la main (resolveStudioSource impose l'image).
    let url = null;
    if (sourceId) {
      if (!UUID_RE.test(sourceId)) return res.status(400).json({ error: 'Source not found' });
      const row = await queryOne(
        `SELECT r2_key, status, media, hidden FROM essai_generations WHERE id = $1`,
        [sourceId]
      );
      if (!row || row.status !== 'completed' || row.hidden || !row.r2_key) return res.status(400).json({ error: 'Source not found' });
      if (row.media !== 'video') return res.status(400).json({ error: 'Video upscaling starts from a video — the source you picked is not one' });
      url = await getPresignedUrl(row.r2_key, 3600);
    } else if (videoUrl) {
      try { assertSafeUrl(videoUrl); } catch { return res.status(400).json({ error: 'Invalid video URL' }); }
      url = videoUrl;
    } else {
      return res.status(400).json({ error: 'Source video required' });
    }

    // Topaz Video : facteurs 2 ou 4, comme POST /api/tools/video-upscale.
    const demande = String(upscaleFactor ?? '2');
    if (!['2', '4'].includes(demande)) {
      return res.status(400).json({ error: 'Upscale factor must be 2 or 4' });
    }

    await launchStudioJob(req, res, {
      kind: 'vid-upscale',
      galleryPrompt: `Video resolution ×${demande} — anonymous studio`,
      userText: null,
      format: null,
      imageUrl: url,            // le tronc commun insère la source ; runJob lit videoUrl||imageUrl
      params: { videoUrl: url, upscaleFactor: demande },
    });
  } catch (e) {
    console.error('[ESSAI studio video-upscale]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the video upscale — try again' });
  }
});

// ─── Studio : voix de synthèse (texte visiteur, filtré) ───
router.post('/studio/tts', async (req, res) => {
  try {
    const { text, voice, voiceModel, stability, similarity_boost, style, speed } = req.body || {};
    const cleanText = typeof text === 'string' ? text.trim() : '';
    if (!cleanText) return res.status(400).json({ error: 'text is required' });
    if (cleanText.length > MAX_TTS_CHARS) {
      return res.status(400).json({ error: `text must be ${MAX_TTS_CHARS} characters or less` });
    }

    await launchStudioJob(req, res, {
      kind: 'tts',
      // Publié EN ENTIER, sans découpe : la longueur acceptée est désormais
      // celle de la galerie (voir MAX_TTS_CHARS), donc ce qui est prononcé est
      // exactement ce qu'un modérateur humain pourra relire.
      galleryPrompt: cleanText,
      userText: cleanText,
      format: null,
      params: {
        text: cleanText,
        // `voice` part telle quelle chez le fournisseur, et c'est assumé : le
        // visiteur travaille sur SA propre clé KIE.AI, il ne peut donc désigner
        // que les voix de son propre compte ElevenLabs ou de la bibliothèque
        // publique — une liste blanche maintenue ici ne le protégerait de rien
        // et lui interdirait ses propres voix. La chaîne est du JSON encodé
        // (aucune injection possible) et bornée à 64 caractères pour ne pas
        // relayer un champ arbitrairement long. Une valeur inconnue rend une
        // erreur du fournisseur, pas une facture.
        voice: typeof voice === 'string' && voice.trim() ? voice.trim().slice(0, 64) : null,
        stability: boundedNumber(stability, 0, 1),
        similarity_boost: boundedNumber(similarity_boost, 0, 1),
        style: boundedNumber(style, 0, 1),
        speed: boundedNumber(speed, 0.5, 2),
      },
    });
  } catch (e) {
    console.error('[ESSAI studio tts]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the voice — try again' });
  }
});

// ─── Studio : bruitage (texte visiteur, filtré) ───
router.post('/studio/sfx', async (req, res) => {
  try {
    const { text, duration_seconds } = req.body || {};
    const cleanText = typeof text === 'string' ? text.trim() : '';
    if (!cleanText) return res.status(400).json({ error: 'text is required' });
    if (cleanText.length > MAX_SFX_CHARS) {
      return res.status(400).json({ error: `text must be ${MAX_SFX_CHARS} characters or less` });
    }

    await launchStudioJob(req, res, {
      kind: 'sfx',
      // 450 caractères au plus, donc sous l'extrait publié : le mur montre le
      // texte entier, celui-là même qui est passé au fournisseur.
      galleryPrompt: cleanText,
      userText: cleanText,
      format: null,
      params: {
        // `text` manquait ici alors qu'il était validé juste au-dessus : la
        // file retombait sur son défaut (null) et le fournisseur recevait
        // {"text":null} — chaque bruitage échouait, en consommant l'appel.
        // /studio/tts, elle, le transmettait bien.
        text: cleanText,
        // Mêmes bornes qu'un compte (POST /api/tools/sfx) : 0,5 à 22 secondes.
        duration_seconds: boundedNumber(duration_seconds, 0.5, 22),
      },
    });
  } catch (e) {
    console.error('[ESSAI studio sfx]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the sound effect — try again' });
  }
});

// ─── Studio : statut au format studio.html ({ ready, resultUrl, state }) ───
router.get('/studio/status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Not found' });

    const row = await queryOne(
      `SELECT status, error, media, kind FROM essai_generations WHERE id = $1`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });

    // Le média accompagne CHAQUE réponse, y compris pendant l'attente : sans
    // lui, le client ne sait pas s'il prépare une image, un lecteur vidéo ou un
    // lecteur audio. Pour les lignes antérieures à la colonne, le repli passe
    // par la table des kinds — jamais par un 'image' écrit en dur ici.
    const media = row.media || mediaForKind(row.kind).media;

    if (row.status === 'completed') {
      return res.json({ ready: true, resultUrl: `/api/essai/image/${id}`, state: 'completed', media });
    }
    if (row.status === 'failed') {
      return res.json({ ready: false, failed: true, state: 'failed', media, error: row.error || 'The generation failed' });
    }
    const payload = { ready: false, state: row.status, media };
    if (row.status === 'queued') payload.position = positionOf(id);
    res.json(payload);
  } catch (e) {
    console.error('[ESSAI studio status]', e.message);
    res.status(500).json({ error: 'Status unavailable' });
  }
});

// ─── Suppression admin (réutilise l'auth existante) ───
router.delete('/admin/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Not found' });

    const row = await queryOne(`SELECT r2_key FROM essai_generations WHERE id = $1`, [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });

    if (row.r2_key) {
      try { await deleteFromR2(row.r2_key); }
      catch (err) { console.error('[ESSAI admin delete R2]', err.message); }
    }
    // Les vignettes de galerie (?v=1) sont des objets R2 à part entière : les
    // oublier laisserait sur le bucket la miniature d'une création supprimée
    // par un administrateur. Un objet absent n'est pas une erreur ici.
    for (const webp of [true, false]) {
      try { await deleteFromR2(thumbKeyFor(id, webp)); }
      catch (err) { console.error('[ESSAI admin delete thumb]', err.message); }
    }
    await query(`DELETE FROM essai_generations WHERE id = $1`, [id]);

    res.json({ ok: true });
  } catch (e) {
    console.error('[ESSAI admin delete]', e.message);
    res.status(500).json({ error: 'Could not delete' });
  }
});

export default router;

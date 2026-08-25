/**
 * Essai communautaire — génération anonyme BYOK + galerie publique
 *
 * POST   /api/essai/generer      filtre de prompt → job en file FIFO
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
 * Sécurité :
 *   - La clé du visiteur arrive via X-Provider-Key (même mécanisme BYOK que
 *     le studio — requestContext), n'est jamais persistée ni loggée.
 *   - ids UUID v4 : non séquentiels, non devinables.
 *   - Le média est servi par proxy : aucune URL R2/provider n'atteint le client.
 *   - Toute sortie anonyme est publiée dans la galerie, sans téléchargement —
 *     c'est la modération par transparence. Le filigrane, lui, ne couvre que
 *     les images : le conteneur n'embarque que sharp (pas de ffmpeg), donc
 *     marquer un MP4 ou un MP3 est hors de portée ici. On l'annonce au
 *     visiteur plutôt que de laisser croire à une protection inexistante.
 */

import { Router } from 'express';
import { randomUUID, randomBytes } from 'crypto';
import multer from 'multer';
import sharp from 'sharp';
import { GetObjectCommand } from '@aws-sdk/client-s3';
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

// ─── Générer ───
router.post('/generer', async (req, res) => {
  try {
    // Clé BYOK : uniquement depuis le header (jamais depuis le body → jamais
    // dans un log de body ni un dump de requête).
    const apiKey = getRequestProviderKey();
    if (!apiKey) {
      return res.status(400).json({ error: 'API key required — paste your KIE.AI key (it stays in your browser)' });
    }

    const { prompt, format, consent } = req.body || {};
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
    const id = randomUUID();

    await query(
      `INSERT INTO essai_generations (id, prompt, status, format) VALUES ($1, $2, 'queued', $3)`,
      [id, cleanPrompt, cleanFormat]
    );

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
    if (row.status === 'failed') payload.error = row.error || 'La generation a echoue';
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
    res.status(500).json({ error: 'Galerie indisponible' });
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
      `SELECT r2_key, hidden, status, kind FROM essai_generations WHERE id = $1`,
      [id]
    );
    if (!row || row.status !== 'completed' || row.hidden || !row.r2_key) return res.status(404).end();

    // Type et extension viennent de la table des médias — celle-là même qui a
    // décidé sous quelle forme la file a déposé l'objet sur R2. Avec nosniff
    // plus bas, un MP4 annoncé en image/png ne se lirait nulle part : le
    // navigateur s'interdit de rattraper une déclaration fausse.
    const out = mediaForKind(row.kind);

    if (req.query.v === '1' && out.media === 'image') {
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
        // Intervalle hors bornes (InvalidRange) : la norme permet d'ignorer un
        // Range et de rendre l'objet entier. C'est plus sûr qu'un 416 dont on
        // ne saurait pas remplir le Content-Range sans un HEAD supplémentaire.
        if (err?.name !== 'InvalidRange') throw err;
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

const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const ALLOWED_IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

// ─── Upload anonyme (image source de génération, jamais publiée) ───
router.post('/upload', uploadImage.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const ext = ALLOWED_IMAGE_TYPES[req.file.mimetype];
    if (!ext) return res.status(400).json({ error: 'Unsupported format. Use JPEG, PNG, WebP or GIF.' });

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
      return { error: 'Cette operation part d\'une image — la source choisie n\'en est pas une' };
    }
    return { url: await getPresignedUrl(row.r2_key, 3600) };
  }
  if (imageUrl) {
    try { assertSafeUrl(imageUrl); } catch { return { error: 'URL d\'image invalide' }; }
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

  const cleanFormat = VALID_FORMATS.includes(format) ? format : '1:1';
  const id = randomUUID();
  const out = mediaForKind(kind);

  // media est écrit dès l'insertion, et pas seulement quand la file démarre le
  // job : derrière une file chargée, un job attend parfois plusieurs minutes en
  // 'queued', et le client qui sonde doit savoir tout de suite s'il prépare une
  // image, une vidéo ou un son.
  await query(
    `INSERT INTO essai_generations (id, prompt, status, format, kind, media) VALUES ($1, $2, 'queued', $3, $4, $5)`,
    [id, galleryPrompt, cleanFormat, kind, out.media]
  );

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
      galleryPrompt: cd || 'Visuel produit — studio anonyme',
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
      galleryPrompt: 'Retouche studio (polish) — studio anonyme',
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
      return res.status(400).json({ error: `Format invalide. Formats acceptes : ${VALID_FORMATS.join(', ')}` });
    }
    const source = await resolveStudioSource({ sourceId, imageUrl });
    if (source.error) return res.status(400).json({ error: source.error });

    await launchStudioJob(req, res, {
      kind: 'adapt',
      galleryPrompt: `Adaptation de format ${format} — studio anonyme`,
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
      galleryPrompt: cd || 'Vidéo — studio anonyme',
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
    const factor = ['4', '8'].includes(String(upscaleFactor)) ? String(upscaleFactor) : '4';

    await launchStudioJob(req, res, {
      kind: 'upscale',
      galleryPrompt: `Agrandissement x${factor} — studio anonyme`,
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

// ─── Studio : voix de synthèse (texte visiteur, filtré) ───
router.post('/studio/tts', async (req, res) => {
  try {
    const { text, voice, stability, similarity_boost, style, speed } = req.body || {};
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
      return res.json({ ready: false, failed: true, state: 'failed', media, error: row.error || 'La generation a echoue' });
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

/**
 * Essai Queue — file en mémoire, équitable, pour les générations anonymes (BYOK)
 *
 * Sert deux surfaces anonymes, avec le MÊME contrat de sortie :
 *   - l'essai simple (/api/essai/generer, texte → image), kind 'text'
 *   - le studio anonyme (/api/essai/studio/*), kinds 'image' (img→img avec
 *     brief produit), 'polish', 'remix', 'adapt', 'upscale', 'video', 'tts',
 *     'sfx'
 *
 * Contrat de sécurité (non négociable) :
 *   - La clé API du visiteur vit UNIQUEMENT dans l'objet job en RAM, le temps
 *     du job. Jamais en DB, jamais dans un log, jamais dans un message
 *     d'erreur. Elle est effacée (job.apiKey = null) dès l'état terminal.
 *   - L'URL temporaire du provider n'est JAMAIS stockée : le résultat est
 *     relu par nous, filigrané quand le média s'y prête, poussé sur R2
 *     (essai/<uuid>.<ext>), et seule la clé R2 est écrite en DB. « Relu » et
 *     non « téléchargé » : ce qui ne reçoit pas de filigrane passe de la
 *     source à R2 en flux, sans jamais tenir en mémoire (persistProviderResult).
 *   - Les erreurs provider sont mappées vers des messages sûrs — jamais de
 *     texte brut du provider en DB ni vers le client.
 *
 * Ordonnancement : la file n'est plus servie en FIFO strict mais au tour par
 * tour entre adresses IP. Le FIFO strict avait un défaut de fond : le lot
 * entier d'un visiteur passait avant la première demande du suivant, et la
 * seule protection contre cela était un plafond par IP qui REFUSAIT au lieu de
 * faire attendre. Un visiteur qui demandait cinq variantes n'en voyait partir
 * que trois, sans qu'aucun message ne le lui dise. On sert donc, parmi les
 * jobs en attente, celui dont l'IP a le moins de jobs déjà en cours ; à
 * égalité, le plus ancien. Deux visiteurs de dix variantes se servent en
 * alternance, personne n'attend derrière le lot entier de l'autre.
 *
 * Concurrence : ESSAI_CONCURRENCY (3 par défaut, 8 max). Un job est presque
 * entièrement de l'attente réseau chez le fournisseur — le seul vrai travail
 * processeur est le filigrane. ESSAI_MAX_PER_IP (défaut 20) vaut la taille du
 * plus grand lot que propose l'interface (public/studio.html, data-variants) :
 * un lot que le studio offre ne doit jamais être tronqué en silence.
 *
 * Résolution : 2K pour TOUTE image, quel que soit le kind. Le détail du
 * raisonnement est au-dessus de createProviderTask() — l'essentiel tient en une
 * phrase : le studio est fait pour enchaîner, et une première image en 1K
 * n'économisait rien puisque le geste suivant repartait en 2K depuis elle.
 */

import sharp from 'sharp';
import { query } from '../db.js';
import { uploadToR2, persistFromUrl } from './r2.js';
import { assertSafeUrl } from '../utils/safeUrl.js';
import * as kie from './providers/kie.js';
import { buildImagePrompt, POLISH_PROMPT, ADAPT_PROMPT, VIDEO_PROMPT } from './studio-prompts.js';
import { watermarkVideo } from './watermark-video.js';

const CONCURRENCY = Math.min(8, Math.max(1, parseInt(process.env.ESSAI_CONCURRENCY) || 3));
const MAX_QUEUE = 60;               // trois lots de 20 : le troisième visiteur n'est plus refusé
// Le plus grand lot que propose l'interface. À 2, aucun préréglage social (5 ou
// 10 variantes) ne partait entier. Le plafond ne peut pas dépasser la file
// globale — au-dessus, il ne voudrait plus rien dire.
const MAX_PER_IP = Math.min(MAX_QUEUE, Math.max(1, parseInt(process.env.ESSAI_MAX_PER_IP) || 20));
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 4 * 60_000; // images et sons : 4 min puis échec
// Une vidéo rend rarement sous 4 minutes (veo3 dépasse couramment 5) : garder
// le délai des images ici reviendrait à abandonner des jobs qui allaient
// aboutir, en facturant quand même les crédits du visiteur.
const POLL_TIMEOUT_VIDEO_MS = 10 * 60_000;

const queue = [];                   // jobs en attente, dans l'ordre d'arrivée

// Les jobs en cours, et pas seulement leur nombre : l'ordonnancement équitable
// a besoin de savoir À QUI ils appartiennent. Un simple compteur `running`
// faisait aussi mentir le plafond par IP, qui ne comptait que la file — le job
// que pump() venait d'en sortir n'était compté nulle part, et un lot de cinq
// partait à trois.
const active = new Set();

/** Jobs de cette IP, en file ET en cours — le plafond compte les deux. */
function countForIp(ip) {
  let n = 0;
  for (const j of queue) if (j.ip === ip) n++;
  for (const j of active) if (j.ip === ip) n++;
  return n;
}

/**
 * Durée moyenne observée d'un job, en millisecondes.
 *
 * Un refus doit annoncer une attente, et une constante écrite en dur mentirait
 * dès que le catalogue bouge : une vidéo veo3 ne coûte pas le temps d'une
 * image. On tient donc une moyenne glissante des jobs réellement terminés,
 * amorcée à 90 s — l'ordre de grandeur d'une image, le cas le plus fréquent.
 * (L'amorce n'a plus à être révisée à chaque changement de résolution : c'est
 * précisément le point d'une moyenne mesurée plutôt que devinée. Le passage de
 * l'essai 1K au 2K la corrige tout seul, après quelques jobs.)
 */
let avgJobMs = 90_000;

function recordJobDuration(ms) {
  // Un échec instantané (clé invalide, refus du fournisseur) n'a occupé aucune
  // voie : le compter ferait chuter la moyenne et promettrait quelques
  // secondes d'attente à des visiteurs qui en attendront deux minutes.
  if (!Number.isFinite(ms) || ms < POLL_INTERVAL_MS) return;
  avgJobMs = Math.round(avgJobMs * 0.8 + ms * 0.2);
}

/** Attente estimée, en minutes, pour que `jobsAhead` jobs soient passés. */
function waitMinutes(jobsAhead) {
  const cycles = Math.ceil(Math.max(1, jobsAhead) / CONCURRENCY);
  return Math.max(1, Math.round((cycles * avgJobMs) / 60_000));
}

// ─── Table des médias : ce que chaque opération produit ───

/**
 * Une seule table décrit la sortie de chaque kind : le média (ce que le client
 * devra afficher), l'extension et le type MIME du fichier poussé sur R2, et
 * s'il faut y poser un filigrane. runJob() n'a plus alors aucune connaissance
 * du format — ajouter une opération, c'est ajouter une ligne ici.
 *
 * Ce que porte le filigrane : l'image (sharp) ET la vidéo (ffmpeg, installé par
 * le Dockerfile depuis le 25/08 — voir src/lib/watermark-video.js). Le son n'en
 * porte aucun, et c'est un choix : rien ne s'inscrit dans une piste sonore sans
 * abîmer précisément ce que le visiteur est venu chercher. Le consentement du
 * studio anonyme dit exactement cela — ne jamais laisser ces trois textes
 * diverger, ils décrivent la seule protection réelle du travail publié.
 *
 * `watermark` dit ce que MÉRITE un kind en général ; c'est shouldWatermark()
 * qui tranche pour un job donné. La table ignore en effet d'où vient la
 * source, et un agrandissement anonyme part d'une image qui en porte déjà un.
 */
export const MEDIA_BY_KIND = Object.freeze({
  text:    Object.freeze({ media: 'image', ext: 'png', mime: 'image/png',  watermark: true }),
  image:   Object.freeze({ media: 'image', ext: 'png', mime: 'image/png',  watermark: true }),
  polish:  Object.freeze({ media: 'image', ext: 'png', mime: 'image/png',  watermark: true }),
  remix:   Object.freeze({ media: 'image', ext: 'png', mime: 'image/png',  watermark: true }),
  adapt:   Object.freeze({ media: 'image', ext: 'png', mime: 'image/png',  watermark: true }),
  upscale: Object.freeze({ media: 'image', ext: 'png', mime: 'image/png',  watermark: true }),
  video:   Object.freeze({ media: 'video', ext: 'mp4', mime: 'video/mp4',  watermark: true }),
  // Agrandissement vidéo (Topaz Video) : la source EST une vidéo, la sortie
  // aussi — distinct de `upscale` (image) pour que MEDIA_BY_KIND serve le bon
  // type et pose le filigrane ffmpeg, pas sharp.
  'vid-upscale': Object.freeze({ media: 'video', ext: 'mp4', mime: 'video/mp4', watermark: true }),
  tts:     Object.freeze({ media: 'audio', ext: 'mp3', mime: 'audio/mpeg', watermark: false }),
  sfx:     Object.freeze({ media: 'audio', ext: 'mp3', mime: 'audio/mpeg', watermark: false }),
});

/**
 * Sortie attendue pour un kind. Un kind inconnu retombe sur l'image : c'est le
 * cas des lignes écrites avant l'arrivée de la colonne media, et le seul repli
 * qui ne trompe pas le client.
 * @param {string} kind
 * @returns {{ media: string, ext: string, mime: string, watermark: boolean }}
 */
export function mediaForKind(kind) {
  return MEDIA_BY_KIND[kind] || MEDIA_BY_KIND.text;
}

// ─── Filigrane serveur ───

/**
 * Compose un filigrane discret « studio.kanaky.xyz » en bas à droite.
 * Taille relative à la largeur de l'image, opacité modérée + liseré sombre
 * pour rester lisible sur fond clair comme sombre.
 */
export async function watermarkImage(buffer) {
  const img = sharp(buffer);
  const meta = await img.metadata();
  const w = meta.width || 1024;
  // L'adresse canonique du studio depuis le 13/08. « keou.studio » n'a
  // jamais existé : chaque création publique portait un domaine mort, sur
  // le seul support qui nous fait de la publicité gratuite.
  const text = 'studio.kanaky.xyz';
  // Le bandeau doit TENIR dans l'image. Avec un corps de 16 px plancher il
  // mesure ~200 px de large : sharp refuse de composer plus grand que le
  // support (« Image to composite must have same dimensions or smaller ») et
  // c'est le job entier qui échouait, pour un badge. Le catalogue rend du 2K,
  // donc aucun cas réel n'approche cette borne — mais un rendu étroit ne doit
  // pas coûter la création elle-même. On rétrécit le corps jusqu'à ce qu'il
  // rentre. Ce n'est pas de la paranoïa gratuite : le seul kind dont la taille
  // ne vient pas de notre catalogue est l'agrandissement, qui part de ce que le
  // visiteur lui a donné.
  const band = (f) => ({
    w: Math.round(text.length * f * 0.64) + Math.round(f * 0.9) * 2,
    h: f + Math.round(f * 0.9) * 2,
  });
  let fontSize = Math.max(16, Math.round(w * 0.024));
  while (fontSize > 8 && band(fontSize).w > w) fontSize -= 1;
  if (band(fontSize).w > w || band(fontSize).h > (meta.height || w)) {
    // Trop étroit même au minimum lisible : mieux vaut l'image nue qu'un échec.
    console.warn(`[ESSAI] image ${w}px : trop etroite pour le filigrane, deposee sans`);
    return img.png().toBuffer();
  }
  const pad = Math.round(fontSize * 0.9);
  const svgW = band(fontSize).w;
  const svgH = band(fontSize).h;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">` +
    `<text x="${svgW - pad}" y="${svgH - pad}" text-anchor="end" ` +
    `font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="600" ` +
    `fill="#ffffff" fill-opacity="0.5" stroke="#000000" stroke-opacity="0.28" stroke-width="1.2" ` +
    `paint-order="stroke">${text}</text></svg>`
  );
  return img.composite([{ input: svg, gravity: 'southeast' }]).png().toBuffer();
}

// ─── Messages d'erreur sûrs (jamais le texte brut du provider) ───

/**
 * Traduit une erreur — la nôtre ou celle du fournisseur — en message sûr.
 *
 * Trois choses ont été corrigées ici, dans cet ordre :
 *
 * 1. Nos deux sentinelles (ESSAI_TOO_LARGE, ESSAI_TIMEOUT) passent EN PREMIER,
 *    sur le message brut. Elles étaient testées après les motifs du
 *    fournisseur : aucune ne se faisait happer aujourd'hui, mais il suffisait
 *    d'un futur code sentinelle contenant « invalid » ou « 429 » pour que le
 *    visiteur reçoive un diagnostic sans rapport. Ce qui nous appartient se
 *    reconnaît avant ce qu'on devine.
 *
 * 2. La reconnaissance se fait en minuscules. Un fournisseur qui répond
 *    « Unauthorized » ou « Insufficient credits » — capitalisé, comme la
 *    plupart le font — tombait dans le message générique « réessayez » : le
 *    visiteur cherchait une panne de notre côté alors qu'il avait une clé morte
 *    ou un solde à zéro.
 *
 * 3. « invalid » seul ne conclut plus à une clé. « invalid prompt », « invalid
 *    aspect_ratio » ou « invalid parameter » envoyaient le visiteur vérifier
 *    une clé parfaitement bonne, et il n'avait aucun moyen de s'en apercevoir.
 *    On exige désormais que la clé soit nommée.
 *
 * Les libellés sont en anglais : c'est la langue source du produit, et
 * public/shared/i18n.js les rend en français depuis i18n/fr.json — y compris
 * quand un script de page les injecte après coup.
 */
function safeErrorMessage(err) {
  const raw = err?.message || '';
  if (raw === 'ESSAI_TOO_LARGE') {
    return 'The provider returned a file too large to process — try a smaller format';
  }
  /* Une panne du fournisseur, nommée par son code.
   *
   * « La génération a échoué, réessayez » envoyait le visiteur recommencer — et
   * repayer — alors que le problème n'est ni chez lui ni chez nous. Un 524 dit
   * que leur serveur n'a pas répondu : le seul geste utile est d'attendre, pas
   * de relancer. On le dit. */
  const amont = raw.match(/^ESSAI_AMONT_(\d{3})$/);
  if (amont) {
    const code = amont[1];
    if (code === '524' || code === '504' || code === '522' || code === '520') {
      return `The provider stopped responding (HTTP ${code}) — their side, not yours. Wait a few minutes before trying again.`;
    }
    if (code === '429') return 'Provider rate limit reached — wait a minute and try again';
    return `The provider is unavailable (HTTP ${code}) — try again in a few minutes.`;
  }

  if (raw === 'ESSAI_TIMEOUT') {
    // Le délai dépend du média (4 min pour une image, 10 pour une vidéo) : le
    // message ne cite plus de durée, il mentirait une fois sur deux.
    return 'Generation timed out and was abandoned — please try again';
  }
  const msg = raw.toLowerCase();
  if (msg.includes('401') || msg.includes('unauthorized')
      || msg.includes('api key') || msg.includes('api_key') || msg.includes('apikey')) {
    return 'Invalid or unauthorized API key — check your KIE.AI key';
  }
  if (msg.includes('402') || msg.includes('insufficient') || msg.includes('exhausted')) {
    return 'Your KIE.AI credits are exhausted — top up on kie.ai and try again';
  }
  if (msg.includes('429') || msg.includes('rate limit')) {
    return 'Provider rate limit reached — wait a minute and try again';
  }
  /* Le message du fournisseur, quand on peut le montrer sans rien trahir.
   *
   * Tout ce qui n'entrait pas dans les cas ci-dessus devenait « la génération a
   * échoué, réessayez » — une phrase qui ne dit rien et n'aide personne. Un
   * bruitage refusé pour un modèle inconnu, une image refusée par la modération
   * du fournisseur et une panne réseau rendaient exactement le même texte. Le
   * visiteur ne pouvait ni comprendre ni corriger, et nous non plus.
   *
   * On rend donc ce que le fournisseur a dit, à trois conditions : rien qui
   * ressemble à une clé ou à un jeton, aucune URL (les liens signés portent des
   * secrets), et une longueur bornée. Faute de quoi on retombe sur le message
   * générique — un diagnostic ne vaut jamais une fuite. */
  const propre = raw.trim();
  const suspect = /https?:\/\/|[A-Za-z0-9_-]{28,}|bearer|token|secret/i.test(propre);
  if (propre && propre.length <= 160 && !suspect) {
    /* « Refusé » et « en panne » ne se disent pas pareil. Un refus vient de la
     * demande (modération, format, crédit) et le visiteur peut agir dessus ;
     * une panne amont ne lui doit rien — il a déjà été réessayé une fois par
     * la file, et l'accuser d'un refus l'enverrait corriger un texte qui n'a
     * rien à se reprocher. */
    if (estPassagere(propre)) {
      return `The model provider is having trouble right now (${propre}) — we already retried once. Try again in a few minutes.`;
    }
    /* Le refus le plus fréquent de l'agrandissement : le résultat dépasserait
     * 20 000 px de côté (typiquement en ré-agrandissant une image déjà
     * agrandie). Le code 422 brut ne dit pas quoi faire ; ceci le dit. */
    if (/exceeds the limit after scaling/i.test(propre)) {
      return 'The result would exceed the provider\'s 20,000 px limit on the longest side — pick ×2 instead of ×4, or start from a smaller image.';
    }
    if (/max size|too large|exceeds.*(size|MB)/i.test(propre)) {
      return 'The source file is heavier than the 10 MB the provider accepts — start from a lighter file.';
    }
    return `Provider refused the request: ${propre}`;
  }
  return 'Generation failed — please try again in a moment';
}

// ─── Worker ───

// Mêmes modèles que POST /api/video pour un compte — la liste est copiée à
// l'identique de src/lib/keou-actions.js, repli compris. (Le chemin écrit ici
// était « /api/generate/video » : il n'existe pas. src/routes/generate.js est
// monté sur /api dans server.js, pas sur /api/generate, et c'est bien vers
// /api/video que le studio poste.) Un modèle inconnu retombe sur le moins cher
// plutôt que d'échouer chez le fournisseur.
const VIDEO_MODELS = ['grok-imagine', 'kling-2.6', 'kling-3.0', 'veo3', 'seedance-2', 'wan-3.0'];

function videoModelOf(job) {
  return VIDEO_MODELS.includes(job.videoModel) ? job.videoModel : 'grok-imagine';
}

/** Prompt vidéo du studio, augmenté de la direction créative du visiteur. */
function buildVideoPrompt(creativeDirection) {
  if (!creativeDirection) return VIDEO_PROMPT;
  return `${VIDEO_PROMPT} ADDITIONAL CREATIVE DIRECTION: ${creativeDirection}. Integrate this into camera, lighting, atmosphere while keeping product locked.`;
}

/**
 * Crée la tâche provider selon le kind du job. La forme du résultat (image,
 * vidéo ou son) n'est PAS déduite ici : elle vient de MEDIA_BY_KIND, seule
 * source de vérité de la chaîne aval.
 *
 * ─── Résolution : 2K partout, et c'est un choix ───
 *
 * L'essai simple ('text') et le visuel produit ('image') partaient en 1K, sous
 * un commentaire qui annonçait qu'on ménageait les crédits du visiteur.
 * L'économie n'existait pas. Polish et remix partent en 2K, et adapt est câblé
 * en 2K chez le fournisseur (src/lib/providers/kie.js) : dès le deuxième geste
 * — et le studio est fait pour enchaîner, chaque opération repart du rendu
 * précédent — le visiteur payait le plein tarif. Pire, il le payait sur une
 * source 1K que flux-2 devait étirer en 2K : plein tarif pour un rendu mou,
 * pendant que le commentaire lui promettait le contraire.
 *
 * Le 1K partout était l'autre option défendable, et on l'écarte pour deux
 * raisons vérifiables dans ce dépôt :
 *   - adapt ne sait pas descendre. Sa résolution est en dur dans kie.adapt(),
 *     qui n'accepte même pas le paramètre : la cohérence « tout en 1K » serait
 *     donc fausse dès la première adaptation de format.
 *   - la surface d'un compte génère en 2K (src/lib/keou-actions.js). Faire
 *     essayer le produit en 1K, c'est montrer au visiteur une qualité
 *     inférieure à celle qu'on lui vend ensuite.
 *
 * Conséquence assumée : la première génération coûte plus cher au visiteur
 * qu'avant. On ne l'annonce simplement plus comme une économie — c'est sa clé
 * et son budget, il a droit à un compte juste.
 */
/* Libellé humain du modèle qui va produire la création — ce que la galerie
 * affiche sous chaque rendu. Miroir de createProviderTask : si un cas y
 * change de modèle, il change ici. */
function modelLabel(job) {
  switch (job.kind) {
    case 'text': case 'image': case 'adapt': return 'Nano Banana Pro';
    case 'polish': case 'remix': return 'FLUX.2 Pro';
    case 'upscale': return 'Topaz Image';
    case 'vid-upscale': return 'Topaz Video';
    case 'video': {
      const m = VIDEO_MODELS.includes(job.videoModel) ? job.videoModel : 'grok-imagine';
      if (m === 'veo3') return job.variant === 'veo3_fast' ? 'Veo 3.1 fast' : job.variant === 'veo3_lite' ? 'Veo 3.1 lite' : 'Veo 3.1';
      return { 'kling-2.6': 'Kling 2.6', 'kling-3.0': 'Kling 3.0', 'seedance-2': 'Seedance 2', 'wan-3.0': 'Wan 3.0', 'grok-imagine': 'Grok Imagine' }[m] || m;
    }
    case 'tts': { const v = String(job.voiceModel || ''); return /eleven/i.test(v) ? 'ElevenLabs' : 'Gemini TTS'; }
    case 'sfx': return 'ElevenLabs SFX';
    default: return null;
  }
}

async function createProviderTask(job) {
  switch (job.kind) {
    case 'image': // studio anonyme : visuel produit depuis une image source
      return kie.generateImage(job.apiKey, {
        prompt: buildImagePrompt(job.creativeDirection),
        imageUrls: [job.imageUrl],
        aspectRatio: job.format,
        outputFormat: 'png',
        resolution: '2K',
      });
    case 'polish': // flux-2 : '2K' est la seule résolution éprouvée en prod
      return kie.polish(job.apiKey, {
        prompt: POLISH_PROMPT,
        imageUrl: job.imageUrl,
        aspectRatio: job.format,
        resolution: '2K',
      });
    case 'remix': // le prompt visiteur (déjà filtré) EST le prompt de remix
      return kie.remix(job.apiKey, {
        prompt: job.prompt,
        imageUrl: job.imageUrl,
        aspectRatio: job.format,
        resolution: '2K',
      });
    case 'adapt':
      return kie.adapt(job.apiKey, {
        prompt: ADAPT_PROMPT,
        imageUrl: job.imageUrl,
        aspectRatio: job.format,
      });
    case 'video':
      return kie.generateVideo(job.apiKey, {
        model: videoModelOf(job),
        prompt: buildVideoPrompt(job.creativeDirection),
        imageUrl: job.imageUrl,
        duration: job.duration,
        resolution: job.resolution,
        mode: job.mode,
        sound: job.sound,
        // Le cadrage vient d'`aspectRatio`, JAMAIS de `job.format`.
        //
        // Le commentaire d'avant affirmait déjà cela ; le code, lui, lisait
        // encore `job.aspectRatio || job.format || '16:9'`. Or la route pose
        // toujours un format — VALID_FORMATS sinon '1:1' (src/routes/essai.js,
        // launchStudioJob) — donc `job.format` n'était jamais vide, le repli
        // 16:9 était inatteignable, et toute vidéo dont le ratio n'avait pas
        // été explicitement choisi sortait carrée là où un compte obtenait du
        // 16:9, sans un mot pour le dire. Le bug que le commentaire décrivait
        // comme réglé ne l'était pas.
        //
        // `format` sert le cadrage des images et la colonne du même nom en
        // base ; il ne dit rien de celui d'une vidéo. En le retirant de la
        // chaîne, le repli redevient atteignable — c'est-à-dire réel.
        //
        // 16:9 est le format natif des modèles vidéo (c'est déjà le défaut de
        // src/lib/providers/kie.js) ; le carré se demande, il ne se subit pas.
        // public/studio.html envoie bien `aspectRatio` aujourd'hui : le repli
        // couvre les clients qui ne le font pas, et les valeurs hors
        // VALID_FORMATS que la route remet à null.
        aspectRatio: job.aspectRatio || '16:9',
        generateAudio: job.generateAudio,
        variant: job.variant,
      });
    case 'upscale':
      // Un seul kind d'agrandissement IMAGE : le visiteur anonyme agrandit ce
      // qu'il vient de créer. La vidéo a son propre kind ci-dessous.
      return kie.upscaleImage(job.apiKey, {
        imageUrl: job.imageUrl,
        /* Le facteur DEMANDÉ, et seulement lui. La ligne d'avant ne connaissait
         * que « 8 ou 4 » : un visiteur qui choisissait ×2 recevait — et
         * payait — un ×4, et le contrôle des 20 000 px côté studio raisonnait
         * sur un facteur que le serveur n'envoyait pas. Vu le 03/09/2026 :
         * 640 px demandé en ×2, 2 560 px rendus. facteurTopaz() borne à 1/2/4. */
        upscaleFactor: ['1', '2', '4'].includes(String(job.upscaleFactor)) ? String(job.upscaleFactor) : '4',
      });
    case 'vid-upscale':
      // Topaz Video sur KIE : mêmes facteurs que le compte
      // (POST /api/tools/video-upscale). La source vient d'une vidéo générée
      // dans la session ou fournie par le visiteur.
      return kie.upscaleVideo(job.apiKey, {
        videoUrl: job.videoUrl || job.imageUrl,
        upscaleFactor: job.upscaleFactor === '2' ? '2' : '4',
      });
    case 'tts': {
      /* Pas de voix imposée : le fournisseur a la sienne, et « Rachel » est un
       * NOM de l'ancienne API ElevenLabs. Depuis, KIE ne parle plus que
       * d'identifiants — d'où l'échec de TOUTE génération de voix, sans motif
       * et la clé du visiteur débitée. Voir src/lib/providers/kie.js. */
      const input = { text: job.text };
      if (typeof job.voice === 'string' && job.voice.trim()) input.voice = job.voice.trim();
      // Le moteur choisi par la requête, s'il fait partie de la liste connue.
      if (job.voiceModel) input.voiceModel = job.voiceModel;
      // kie.tts recopie tout réglage « défini » : un null partirait tel quel
      // chez le fournisseur. On ne transmet donc que ceux réellement fournis.
      for (const k of ['stability', 'similarity_boost', 'style', 'speed']) {
        if (job[k] !== null && job[k] !== undefined) input[k] = job[k];
      }
      return kie.tts(job.apiKey, input);
    }
    case 'sfx':
      return kie.sfx(job.apiKey, {
        text: job.text,
        duration_seconds: job.duration_seconds || undefined,
      });
    default: // 'text' — essai simple existant
      return kie.textToImage(job.apiKey, {
        prompt: job.prompt,
        aspectRatio: job.format,
        outputFormat: 'png',
        // Explicite, alors que kie.textToImage retomberait sur 1K faute de
        // valeur : un rendu d'essai peut servir de source à tout le studio
        // (resolveStudioSource accepte n'importe quelle création terminée),
        // il n'a donc aucune raison de naître plus mou que les autres.
        resolution: '2K',
      });
  }
}

// ─── Récupération du rendu : plafonnée, contrôlée, jamais tamponnée pour rien ───

/**
 * Plafonds de téléchargement, par média.
 *
 * Avant, `Buffer.from(await dl.arrayBuffer())` avalait n'importe quoi : une
 * vidéo de 400 Mo tenait entière en mémoire, et rien n'empêchait trois d'entre
 * elles d'y tenir en même temps — le risque grandit avec la concurrence qu'on
 * vient d'augmenter. Les valeurs sont larges devant ce que rend le catalogue
 * (une image 2K ~5 Mo, une vidéo 720p de 15 s ~30 Mo) et étroites devant la
 * mémoire d'un conteneur. Au-delà, le job échoue avec un message — ce qui vaut
 * mieux que d'étouffer le serveur pour tous les autres visiteurs.
 */
const MAX_BYTES = Object.freeze({
  image: 64 * 1024 * 1024,
  video: 96 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
});

/** Taille annoncée par la source, ou null quand elle ne la déclare pas. */
async function announcedSize(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    if (!r.ok) return null;
    const n = Number(r.headers.get('content-length'));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null; // HEAD refusé ou réseau : on comptera nous-mêmes, au fil de l'eau
  }
}

/** Télécharge en comptant les octets, et coupe DÈS le dépassement. */
async function downloadCapped(url, maxBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const announced = Number(res.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > maxBytes) throw new Error('ESSAI_TOO_LARGE');
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('ESSAI_TOO_LARGE');
    return buf;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    // Sortir de la boucle annule le flux. Attendre la fin du corps pour
    // constater le dépassement reviendrait à accepter en mémoire exactement ce
    // qu'on prétend refuser.
    if (total > maxBytes) throw new Error('ESSAI_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Un objet R2 `essai/<uuid>.<ext>` est une création d'essai — donc DÉJÀ
 * filigranée. L'upload anonyme, lui, vit sous `essai/uploads/` et ne l'a jamais
 * été : le motif exige un uuid, pas n'importe quel chemin sous essai/.
 */
const TRIAL_RESULT_KEY_RE =
  /(^|\/)essai\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;

function isTrialResultUrl(url) {
  if (!url) return false;
  try { return TRIAL_RESULT_KEY_RE.test(decodeURIComponent(new URL(String(url)).pathname)); }
  catch { return false; }
}

/**
 * Appose le filigrane qui convient au média.
 *
 * L'image passe par sharp, la vidéo par ffmpeg. Le son n'en reçoit aucun : rien
 * ne s'inscrit dans une piste sonore sans l'abîmer, et une annonce parlée
 * détruirait précisément ce que le visiteur est venu chercher. La table des
 * médias le dit déjà (watermark: false pour tts et sfx) ; ce commentaire est là
 * pour que personne ne prenne cette absence pour un oubli.
 *
 * watermarkVideo ne jette jamais : ffmpeg absent, fichier illisible ou trop gros
 * rendent la vidéo d'origine. On préfère une vidéo nue à une génération perdue
 * après une minute d'attente et des crédits déjà dépensés chez le fournisseur.
 */
async function apposerFiligrane(raw, out) {
  if (out.media === 'video') return watermarkVideo(raw);
  if (out.media === 'image') return watermarkImage(raw);
  return raw;
}

/**
 * Faut-il poser un filigrane sur CE job ?
 *
 * (Ce bloc documentait déjà shouldWatermark, mais il était posé au-dessus
 * d'apposerFiligrane : deux docblocs empilés, le premier décrivant une fonction
 * écrite trente lignes plus bas. Un lecteur pressé attribuait la règle de
 * l'agrandissement à la mauvaise fonction.)
 *
 * La table dit ce qu'un kind produit ; elle ignore d'où vient la source. Un
 * agrandissement anonyme part presque toujours d'une création d'essai —
 * essai/<uuid>.png, filigrane compris. Topaz l'étirait x4 ou x8, le filigrane
 * d'origine avec lui, et on en reposait un second par-dessus : deux adresses
 * empilées sur la même image, dont une énorme et floue. Celle qui est déjà
 * dans les pixels suffit.
 */
function shouldWatermark(job, out) {
  if (!out.watermark) return false;
  // Même règle pour l'agrandissement VIDÉO : la seule source que le studio
  // propose est une vidéo de session, déjà filigranée — un second filigrane
  // se superposerait au premier, étiré ×2/×4 par Topaz.
  if ((job.kind === 'upscale' || job.kind === 'vid-upscale')
      && isTrialResultUrl(job.videoUrl || job.imageUrl)) return false;
  return true;
}

const MPEG_EXT_RE = /^\.(mp3|mpeg|mpga)$/i;

/**
 * Le son est déposé en .mp3 et servi en audio/mpeg parce que la table le fige,
 * et la route de service (src/routes/essai.js) relit ce type depuis le kind et
 * non depuis l'objet : le délier ici seul ne suffirait pas.
 *
 * C'est juste aujourd'hui — elevenlabs/text-to-speech-turbo-2-5 et
 * sound-effect-v2 ne rendent que du MPEG, et pollTask ne remonte de toute façon
 * aucun format. Ce qui le casserait : un modèle rendant du WAV ou de l'OPUS.
 * L'objet partirait sous .mp3, annoncé audio/mpeg, et avec le nosniff de la
 * route le navigateur refuserait tout net de le lire. On le crie donc dans les
 * logs au premier écart, plutôt que de l'apprendre par un visiteur.
 */
/* Le son est servi dans le format que le fournisseur a REELLEMENT rendu.
 *
 * La table des médias figeait mp3 / audio/mpeg. Or Gemini rend du WAV (PCM
 * 24 kHz mono, constaté le 26/08) : le fichier était déposé en « .mp3 » et servi
 * en « audio/mpeg », c'est-à-dire annoncé sous un type qu'il n'a pas. Avec le
 * nosniff que la route pose, un navigateur qui prend l'en-tête au mot refuse de
 * lire — la voix aurait été produite, facturée, et muette.
 *
 * On lit donc l'extension du rendu et on sert ce qui correspond. Inconnue ou
 * absente : on garde le défaut de la table plutôt que d'inventer.
 */
const FORMATS_AUDIO = Object.freeze({
  '.mp3':  { ext: 'mp3',  mime: 'audio/mpeg' },
  '.mpeg': { ext: 'mp3',  mime: 'audio/mpeg' },
  '.mpga': { ext: 'mp3',  mime: 'audio/mpeg' },
  '.wav':  { ext: 'wav',  mime: 'audio/wav' },
  '.ogg':  { ext: 'ogg',  mime: 'audio/ogg' },
  '.opus': { ext: 'opus', mime: 'audio/ogg' },
  '.flac': { ext: 'flac', mime: 'audio/flac' },
  '.m4a':  { ext: 'm4a',  mime: 'audio/mp4' },
  '.aac':  { ext: 'aac',  mime: 'audio/aac' },
});

/** Le format réellement rendu, ou null si l'URL ne le dit pas. */
function formatAudioRendu(url) {
  try {
    const ext = (new URL(String(url)).pathname.match(/\.[a-z0-9]{2,5}$/i) || [''])[0].toLowerCase();
    return FORMATS_AUDIO[ext] || null;
  } catch {
    return null;
  }
}

/**
 * Dépose le rendu du fournisseur sur R2 sous `key`.
 *
 * L'URL vient de la réponse du fournisseur et non du client — mais c'est NOTRE
 * serveur qui la lit, donc exactement le vecteur que assertSafeUrl ferme pour
 * les URL du visiteur (src/routes/essai.js). Une réponse détournée ne doit pas
 * pouvoir nous faire lire 169.254.169.254.
 *
 * Deux chemins, choisis par le filigrane :
 *   - rien à écrire dans le fichier → persistFromUrl (r2.js) fait passer les
 *     octets de la source à R2 sans les tamponner. Il lui manque seulement une
 *     borne : on lit la taille annoncée avant de le laisser partir. Il inscrit
 *     sur l'objet le Content-Type de la source, sans conséquence — la route de
 *     service réaffirme le type depuis le kind avant d'envoyer au navigateur.
 *   - filigrane à poser → sharp exige le fichier entier, on tamponne, sous
 *     plafond et en coupant dès le dépassement.
 */
async function persistProviderResult(resultUrl, key, out, job) {
  assertSafeUrl(resultUrl);
  const cap = MAX_BYTES[out.media] || MAX_BYTES.image;
  const marquer = shouldWatermark(job, out);

  if (!marquer) {
    const size = await announcedSize(resultUrl);
    if (size !== null) {
      if (size > cap) throw new Error('ESSAI_TOO_LARGE');
      await persistFromUrl(resultUrl, key);
      return;
    }
    // Source muette sur sa taille : la borner suppose de compter, et compter
    // suppose de lire. On retombe donc sur le chemin tamponné, sous le même
    // plafond.
  }

  const raw = await downloadCapped(resultUrl, cap);
  await uploadToR2(marquer ? await apposerFiligrane(raw, out) : raw, key, out.mime);
}

/* ─── Terminaisons annoncées ───
 * Le studio ne redemandait le statut que toutes les 6 à 15 secondes : la
 * galerie, qui lit la base à l'ouverture, montrait le rendu AVANT le studio
 * qui l'avait produit. Plutôt que sonder plus vite (plus de requêtes pour la
 * même attente), la route de statut peut RETENIR sa réponse jusqu'à ce que
 * la file annonce la fin du travail — c'est ici qu'elle l'annonce. */
import { EventEmitter } from 'node:events';
const terminaisons = new EventEmitter();
terminaisons.setMaxListeners(0);
function annoncerFin(id, etat) { terminaisons.emit(id, etat); }
/**
 * Se résout dès que le job `id` se termine (completed/failed), ou après `ms`.
 * @returns {Promise<string|null>} l'état annoncé, ou null si le délai est passé
 */
export function attendreFin(id, ms) {
  return new Promise((resolve) => {
    let t;
    const sur = (etat) => { clearTimeout(t); resolve(etat); };
    terminaisons.once(id, sur);
    t = setTimeout(() => { terminaisons.off(id, sur); resolve(null); }, ms);
  });
}

/* Certaines pannes du fournisseur sont PASSAGÈRES, et il le dit lui-même :
 * « Internal Error, Please try again later. ». Vérifié le 02/09/2026 sur le
 * modèle de bruitage — trois demandes identiques dans la minute, deux échecs
 * et une réussite. Sans reprise, le visiteur voyait « ça ne marche pas » pour
 * une secousse d'en face. On reprend UNE fois, et seulement sur ces messages :
 * un refus de modération, une clé morte ou un crédit épuisé ne se réessaient
 * pas — ils se disent. */
const ERREURS_PASSAGERES = [
  'internal error',
  'please try again',
  'try again later',
  'timeout',
  'temporarily unavailable',
  'service unavailable',
];
function estPassagere(message) {
  const m = String(message || '').toLowerCase();
  return ERREURS_PASSAGERES.some((e) => m.includes(e));
}

/**
 * La partie utile d'un job : soumission au fournisseur, sondage, filigrane,
 * écriture du résultat. Extraite de runJob pour pouvoir être RELANCÉE telle
 * quelle après une panne passagère, sans rejouer la comptabilité de file
 * (`active`, durées, pump) que porte le `finally` de runJob.
 */
async function executerJob(job) {
  // Calculé DANS le try, et pas au-dessus : tout ce qui précède le try est du
  // code dont un jet ne rendrait jamais sa voie — `active` garderait le job
  // pour toujours et la file perdrait une place à chaque fois. Rien ici ne
  // jette aujourd'hui ; la garantie « une voie prise est une voie rendue » ne
  // doit pas dépendre de cette lecture-là.
  let out = mediaForKind(job.kind);

  // media est réaffirmé ici, et pas seulement à l'insertion : la file est la
  // seule à connaître la table des médias, le client saura donc toujours ce
  // qu'il reçoit même si la route appelante ne l'a pas renseigné.
  await query(`UPDATE essai_generations SET status = 'processing', media = $2 WHERE id = $1`, [job.id, out.media]);

  // 1. Création de la tâche provider (clé du visiteur, RAM only)
  const task = await createProviderTask(job);
    // Le modèle en clair, pour la galerie et la page de partage.
    query(`UPDATE essai_generations SET model = $1 WHERE id = $2`, [modelLabel(job), job.id]).catch(() => {});

  // veo3 se sonde sur un autre point d'entrée que le reste du catalogue :
  // pollTask a besoin du modèle pour choisir la bonne URL.
  const pollMetadata = job.kind === 'video'
    ? JSON.stringify({ videoModel: videoModelOf(job) })
    : '{}';

  // 2. Polling jusqu'à état terminal ou timeout
  const deadline = Date.now() + (out.media === 'video' ? POLL_TIMEOUT_VIDEO_MS : POLL_TIMEOUT_MS);
  let resultUrl = null;
  /* Une panne installée chez le fournisseur s'annonce, elle ne s'attend pas.
   *
   * Le sondage ne distinguait pas « la génération travaille » de « le serveur
   * d'en face ne répond plus ». Un 524 — le code Cloudflare d'une origine
   * muette — se traversait donc quatre minutes durant, pour finir en « délai
   * dépassé » sans motif, alors que le fournisseur criait depuis la première
   * seconde. Constaté le 27/08 sur une génération d'image.
   *
   * Quelques secousses se traversent : un réseau hoquette, un service
   * redémarre. Au-delà d'une minute d'échecs D'AFFILÉE, ce n'est plus une
   * secousse, et le visiteur a le droit de savoir sur quoi il attend. */
  const MAX_PANNES_AMONT = Math.max(4, Math.round(60_000 / POLL_INTERVAL_MS));
  let pannes = 0;
  let dernierePanne = null;

  for (;;) {
    if (Date.now() > deadline) throw new Error('ESSAI_TIMEOUT');
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const st = await kie.pollTask(job.apiKey, { taskId: task.taskId, recordId: task.recordId, metadata: pollMetadata });
    if (st.status === 'failed') throw new Error(st.error || 'provider failed');
    if (st.status === 'completed' && st.resultUrl) { resultUrl = st.resultUrl; break; }

    if (st.panneAmont) {
      pannes++;
      dernierePanne = st.panneAmont;
      if (pannes >= MAX_PANNES_AMONT) throw new Error(`ESSAI_AMONT_${dernierePanne}`);
    } else {
      pannes = 0;   // une seule réponse saine efface la série
    }
  }

  // 3. Relecture du rendu (en flux ou tamponnée selon le filigrane) + R2 —
  //    l'URL du fournisseur ne sort jamais d'ici, ni vers la base ni vers le client
  // Le son prend le format réellement rendu — voir formatAudioRendu.
  if (out.media === 'audio') {
    const reel = formatAudioRendu(resultUrl);
    if (reel && reel.ext !== out.ext) {
      console.warn(`[ESSAI] job ${job.id}: le fournisseur rend du "${reel.ext}", servi comme tel`);
      out = Object.freeze({ ...out, ext: reel.ext, mime: reel.mime });
    }
  }
  const r2Key = `essai/${job.id}.${out.ext}`;
  await persistProviderResult(resultUrl, r2Key, out, job);

  await query(
    `UPDATE essai_generations SET status = 'completed', r2_key = $1, completed_at = NOW()
      WHERE id = $2 AND status IN ('queued','processing')`,
    [r2Key, job.id]
  );
    annoncerFin(job.id, 'completed');
}

async function runJob(job) {
  const startedAt = Date.now();
  try {
    await executerJob(job);
  } catch (err) {
    /* Reprise UNIQUE sur une panne que le fournisseur déclare passagère.
     * Elle est posée ici et pas chez l'appelant : runJob attrape lui-même et
     * écrit « failed », si bien qu'une reprise en amont serait du code mort.
     * La 2e tentative repart de zéro (nouveau taskId), ce qui est exactement
     * ce que « please try again later » demande. `_repris` interdit la boucle,
     * et le `finally` ci-dessous ne joue qu'une fois puisqu'on ne rappelle pas
     * runJob mais sa partie utile. */
    if (!job._repris && estPassagere(err?.message)) {
      job._repris = true;
      console.warn(`[ESSAI] job ${job.id} : panne passagère amont, reprise unique —`, (err?.message || '').slice(0, 120));
      await new Promise((r) => setTimeout(r, 3000));
      try {
        await executerJob(job);
        return; // réussi à la reprise : le `finally` fait le ménage
      } catch (err2) {
        console.error(`[ESSAI] job ${job.id} failed après reprise:`, (err2?.message || 'unknown').slice(0, 200));
        await query(
          `UPDATE essai_generations SET status = 'failed', error = $1
            WHERE id = $2 AND status IN ('queued','processing')`,
          [safeErrorMessage(err2), job.id]
        ).catch(() => {});
    annoncerFin(job.id, 'failed');
        return;
      }
    }
    // Log générique côté serveur — jamais la clé, jamais l'URL signée
    console.error(`[ESSAI] job ${job.id} failed:`, (err?.message || 'unknown').slice(0, 200));
    await query(
      `UPDATE essai_generations SET status = 'failed', error = $1
        WHERE id = $2 AND status IN ('queued','processing')`,
      [safeErrorMessage(err), job.id]
    ).catch(() => {});
    annoncerFin(job.id, 'failed');
  } finally {
    job.apiKey = null; // la clé ne survit pas au job
    active.delete(job);
    // On mesure l'occupation réelle d'une voie, succès comme échec : c'est
    // elle, pas le succès, qui détermine l'attente annoncée à un refus.
    recordJobDuration(Date.now() - startedAt);
    setImmediate(pump);
  }
}

/**
 * Prochain job à servir, choisi équitablement entre adresses IP.
 *
 * queue.shift() servait le plus ancien, point : le lot de vingt du premier
 * visiteur passait entièrement avant la première variante du second, qui
 * attendait derrière une heure durant. On prend donc, parmi les jobs en
 * attente, celui dont l'IP a le moins de jobs DÉJÀ en cours. L'ordre d'arrivée
 * reste le départ et tranche les égalités, puisqu'on parcourt la file dans cet
 * ordre avec une comparaison stricte.
 * @returns {number} index dans `queue`, ou -1 si la file est vide
 */
function pickNextIndex() {
  const charge = new Map();
  for (const j of active) charge.set(j.ip, (charge.get(j.ip) || 0) + 1);
  let best = -1;
  let bestCharge = Infinity;
  for (let i = 0; i < queue.length; i++) {
    const c = charge.get(queue[i].ip) || 0;
    if (c < bestCharge) { bestCharge = c; best = i; }
    if (bestCharge === 0) break; // rien de mieux qu'une IP inactive, et c'est la plus ancienne
  }
  return best;
}

function pump() {
  while (active.size < CONCURRENCY && queue.length > 0) {
    const idx = pickNextIndex();
    // Inatteignable tant que la file n'est pas vide — mais splice(-1, 1)
    // retirerait le DERNIER job, ce qui serait un bug silencieux.
    if (idx < 0) break;
    const job = queue.splice(idx, 1)[0];
    active.add(job);
    // La promesse de runJob n'est pas attendue — c'est tout l'intérêt de la
    // file — mais un rejet non rattrapé tue le processus sous Node 20, dont le
    // mode par défaut est `--unhandled-rejections=throw`. runJob rattrape déjà
    // tout ce qu'il sait nommer ; ce filet couvre le reste, par exemple une
    // base injoignable au moment même où l'on écrit l'échec. Le job a de toute
    // façon rendu sa voie dans son `finally` : il ne reste ici qu'à ne pas
    // emporter les autres visiteurs avec lui.
    runJob(job).catch((e) => {
      console.error('[ESSAI] file: rejet non rattrape —', (e?.message || 'unknown').slice(0, 200));
    });
  }
}

// ─── API publique du module ───

/**
 * Enfile une génération. La clé n'est référencée que par l'objet job.
 * kind : 'text' (défaut) | 'image' | 'polish' | 'remix' | 'adapt' | 'upscale'
 *        | 'video' | 'tts' | 'sfx'.
 *
 * Les paramètres propres à une opération portent EXACTEMENT le nom qu'ils ont
 * dans les routes d'un compte (POST /api/video, /api/tools/tts, /api/tools/sfx,
 * /api/tools/image-upscale) : la route anonyme n'a rien à traduire, et les deux
 * surfaces dérivent moins facilement.
 *   - vidéo        : videoModel, duration, resolution, mode, sound,
 *                    aspectRatio, generateAudio, variant, creativeDirection
 *   - voix         : text, voice, stability, similarity_boost, style, speed
 *   - bruitage     : text, duration_seconds
 *   - agrandissement : imageUrl, upscaleFactor
 * @returns {{ ok: true, position: number } | { ok: false, code: number, error: string }}
 */
export function enqueue({
  id, prompt, format, apiKey, ip,
  kind = 'text',
  imageUrl = null,
  creativeDirection = null,
  // vidéo
  videoModel = null, duration = null, resolution = null, mode = null,
  sound = null, aspectRatio = null, generateAudio = null, variant = null,
  // voix et bruitage
  text = null, voice = null, voiceModel = null, stability = null, similarity_boost = null,
  style = null, speed = null, duration_seconds = null,
  // agrandissement
  upscaleFactor = null,
  // agrandissement vidéo (Topaz Video) : source vidéo distincte de l'image
  videoUrl = null,
}) {
  // Les deux refus nomment la limite qui a joué et chiffrent l'attente. Un refus
  // muet est ce qui a fait perdre une heure à un visiteur persuadé que son lot
  // de cinq était parti : trois seulement l'étaient.
  if (queue.length >= MAX_QUEUE) {
    return {
      ok: false, code: 429,
      // « Community queue », pas « Trial queue » : le studio anonyme est présenté
      // partout comme l'édition community — « trial » sonnait comme une démo bridée.
      error: `Community queue is full (${queue.length} waiting) — try again in about ${waitMinutes(queue.length)} min`,
    };
  }
  // File ET en cours : le plafond ne comptait que la file, et mentait donc sur
  // ce qu'il comptait dès que pump() avait sorti un job pour l'exécuter.
  const mine = countForIp(ip);
  if (mine >= MAX_PER_IP) {
    // L'attente annoncée est celle de SA plus ancienne génération encore en
    // file : c'est elle qui libérera la place. Toutes en cours ? un cycle.
    const firstMine = queue.findIndex((j) => j.ip === ip);
    const ahead = firstMine === -1 ? 1 : firstMine + 1;
    return {
      ok: false, code: 429,
      error: `You already have ${mine} generations queued or running (limit ${MAX_PER_IP}) — try again in about ${waitMinutes(ahead)} min`,
    };
  }
  queue.push({
    id, prompt, format, apiKey, ip, kind, imageUrl, creativeDirection,
    videoModel, duration, resolution, mode, sound, aspectRatio, generateAudio, variant,
    text, voice, voiceModel, stability, similarity_boost, style, speed, duration_seconds,
    upscaleFactor, videoUrl,
  });
  // Rang d'arrivée, pas ordre de service : depuis que la file se sert au tour
  // par tour, ce nombre est une estimation haute pour l'UI, pas une promesse.
  const position = queue.length + active.size;
  setImmediate(pump);
  return { ok: true, position };
}

/** Position 1-based d'un job encore en file (0 = en cours ou absent de la file). */
export function positionOf(id) {
  const idx = queue.findIndex((j) => j.id === id);
  return idx === -1 ? 0 : idx + 1 + active.size;
}

/** État instantané pour l'UI. */
export function queueStats() {
  return { waiting: queue.length, running: active.size, concurrency: CONCURRENCY };
}

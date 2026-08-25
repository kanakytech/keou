/**
 * KIE.AI Provider — Raw API calls
 *
 * Each function takes an API key + normalized params,
 * returns { taskId, recordId } for async polling.
 * No DB logic here — that stays in keou-actions.js.
 */

import { config } from '../../config.js';

export const name = 'kie';

const KIE = config.kie.baseUrl;
const VEO_BASE = 'https://api.kie.ai/api/v1/veo';
const FETCH_TIMEOUT = 60_000; // 60s — KIE can be slow under batch load

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try { return await fetch(url, { ...opts, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function safeJson(r) {
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`KIE API ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  // KIE répond HTTP 200 avec l'erreur dans le body ({code:401/402,...})
  const code = Number(data?.code);
  if (code === 401) throw new Error('KIE API 401: invalid or unauthorized API key');
  if (code === 402) throw new Error('KIE API 402: insufficient KIE.AI credits');
  if (code && code >= 400) throw new Error(`KIE API ${code}: ${String(data?.msg || '').slice(0, 160)}`);
  return data;
}

function kieHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

/* ─── Garde-fous de catalogue ───────────────────────────────────────────────
 *
 * Chaque modèle KIE valide ses entrées contre une énumération FERMÉE : une
 * valeur hors liste ne se fait pas ignorer poliment, elle fait échouer la
 * création de tâche. Or le studio envoie le format du VISUEL — 1:1, 3:4, 9:16
 * ou 16:9 (public/studio.html) — et les routes en acceptent trois de plus
 * (4:3, 3:2, 2:3). Ces valeurs partaient telles quelles : un visuel carré
 * envoyé à Veo, qui ne connaît que 16:9, 9:16 et Auto, ne rendait jamais de
 * vidéo, et le visiteur ne l'apprenait qu'au bout du délai de sondage.
 *
 * Les listes ci-dessous sont relevées dans les schémas publics du fournisseur
 * (docs.kie.ai, section `input` de chaque modèle), le 26/08/2026. Quand le
 * modèle offre lui-même un repli « d'après l'image source » (Veo : Auto ;
 * Seedance : adaptive) on le préfère : on ne fabrique pas un cadrage que
 * personne n'a demandé tant que le modèle peut retomber sur l'image. */

const RATIOS_PORTRAIT = new Set(['9:16', '3:4', '2:3', '4:5']);
const RATIOS_PAYSAGE = new Set(['16:9', '4:3', '3:2', '5:4', '21:9']);

/** Veo 3.1 : '16:9' | '9:16' | 'Auto' (défaut 16:9). */
function ratioVeo(ratio) {
  if (ratio === '16:9' || ratio === '9:16') return ratio;
  // « Auto » est prévu pour exactement ce cas : le fournisseur recadre au
  // centre selon que l'image source penche vers le 16:9 ou le 9:16.
  return 'Auto';
}

/** Kling 3.0 : '16:9' | '9:16' | '1:1'. Pas de mode automatique ici. */
function ratioKling3(ratio) {
  if (ratio === '16:9' || ratio === '9:16' || ratio === '1:1') return ratio;
  if (RATIOS_PORTRAIT.has(ratio)) return '9:16';
  if (RATIOS_PAYSAGE.has(ratio)) return '16:9';
  return '1:1';
}

/** Seedance 2 : 1:1, 4:3, 3:4, 16:9, 9:16, 21:9 — ou 'adaptive'. */
const RATIOS_SEEDANCE = new Set(['1:1', '4:3', '3:4', '16:9', '9:16', '21:9']);
function ratioSeedance(ratio) {
  // 3:2 et 2:3, que les routes acceptent, n'existent pas chez ce modèle.
  return RATIOS_SEEDANCE.has(ratio) ? ratio : 'adaptive';
}

/* Topaz n'agrandit que d'un facteur 1, 2 ou 4. Le « 8x » proposé par
 * l'interface n'existe pas chez le fournisseur : la tâche partait, échouait, et
 * le visiteur avait payé un agrandissement qu'il ne recevrait jamais. On rend
 * le plus grand facteur RÉEL plutôt qu'une erreur — et l'interface devrait
 * cesser d'annoncer un 8x (signalé hors de ce fichier). */
const FACTEURS_TOPAZ = new Set(['1', '2', '4']);
function facteurTopaz(facteur) {
  const v = String(facteur ?? '');
  return FACTEURS_TOPAZ.has(v) ? v : '4';
}

/* Un réglage numérique hors bornes fait échouer la tâche, et un NaN part en
 * JSON comme `null` — même résultat, message d'erreur en moins. On ne transmet
 * donc qu'un nombre fini, ramené dans la plage du fournisseur. */
function nombreBorne(valeur, min, max) {
  const n = Number(valeur);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

// ─── Image Gen (nano-banana-pro) ───

export async function generateImage(apiKey, { prompt, imageUrls, aspectRatio, outputFormat, resolution }) {
  const r = await fetchWithTimeout(`${KIE}/createTask`, {
    method: 'POST',
    headers: kieHeaders(apiKey),
    body: JSON.stringify({
      input: JSON.stringify({ image_input: imageUrls, aspect_ratio: aspectRatio || '1:1', output_format: outputFormat || 'png', prompt, resolution: resolution || '2K' }),
      model: 'nano-banana-pro',
    }),
  });
  const data = await safeJson(r);
  if (!data.data?.taskId) throw new Error('No taskId returned');
  return { taskId: data.data.taskId, recordId: data.data.recordId || null };
}

// ─── Text-to-Image (nano-banana-pro, no reference image) ───
// Used by the community trial: the visitor types a prompt, no product shot.

export async function textToImage(apiKey, { prompt, aspectRatio, outputFormat, resolution }) {
  const r = await fetchWithTimeout(`${KIE}/createTask`, {
    method: 'POST',
    headers: kieHeaders(apiKey),
    body: JSON.stringify({
      input: JSON.stringify({ aspect_ratio: aspectRatio || '1:1', output_format: outputFormat || 'png', prompt, resolution: resolution || '1K' }),
      model: 'nano-banana-pro',
    }),
  });
  const data = await safeJson(r);
  if (!data.data?.taskId) throw new Error('No taskId returned');
  return { taskId: data.data.taskId, recordId: data.data.recordId || null };
}

// ─── Polish (flux-2 image-to-image) ───

export async function polish(apiKey, { prompt, imageUrl, aspectRatio, resolution }) {
  const r = await fetchWithTimeout(`${KIE}/createTask`, {
    method: 'POST',
    headers: kieHeaders(apiKey),
    body: JSON.stringify({ model: 'flux-2/pro-image-to-image', input: { input_urls: [imageUrl], prompt, aspect_ratio: aspectRatio || '1:1', resolution: resolution || '2K' } }),
  });
  const data = await safeJson(r);
  if (!data.data?.taskId) throw new Error('Polish task failed');
  return { taskId: data.data.taskId, recordId: data.data.recordId || null };
}

// ─── Remix (flux-2 image-to-image with custom prompt) ───

export async function remix(apiKey, { prompt, imageUrl, aspectRatio, resolution }) {
  const r = await fetchWithTimeout(`${KIE}/createTask`, {
    method: 'POST',
    headers: kieHeaders(apiKey),
    body: JSON.stringify({ model: 'flux-2/pro-image-to-image', input: { input_urls: [imageUrl], prompt, aspect_ratio: aspectRatio || '1:1', resolution: resolution || '2K' } }),
  });
  const data = await safeJson(r);
  if (!data.data?.taskId) throw new Error('Remix task failed');
  return { taskId: data.data.taskId, recordId: data.data.recordId || null };
}

// ─── Adapt Format (nano-banana-pro with ratio change) ───

export async function adapt(apiKey, { prompt, imageUrl, aspectRatio }) {
  const r = await fetchWithTimeout(`${KIE}/createTask`, {
    method: 'POST',
    headers: kieHeaders(apiKey),
    body: JSON.stringify({ input: JSON.stringify({ image_input: [imageUrl], aspect_ratio: aspectRatio, output_format: 'png', prompt, resolution: '2K' }), model: 'nano-banana-pro' }),
  });
  const data = await safeJson(r);
  if (!data.data?.taskId) throw new Error('Adapt task failed');
  return { taskId: data.data.taskId, recordId: data.data.recordId || null };
}

// ─── Video Gen (multi-model) ───

/* Ce que chaque modèle reçoit ici et ce qu'il sait vraiment en faire.
 * (Schémas publics du fournisseur relevés le 26/08/2026 ; un paramètre reçu
 * mais absent du schéma est écrit ci-dessous plutôt que transmis « au cas où »,
 * pour que personne ne rebranche plus tard un réglage mort.)
 *
 *   grok-imagine  mode · duration · resolution · prompt transmis.
 *                 aspectRatio NON : « Image ratio selection only applies to
 *                 multi-image generation mode. In single-image mode, the video
 *                 width and height are referenced to the image width and
 *                 height. » Le format du studio est donc déjà porté par
 *                 l'image source. sound/generateAudio n'existent pas.
 *   kling-2.6     prompt · image_urls (1 max) · sound · duration. RIEN
 *                 d'autre : ni cadrage, ni résolution, ni mode.
 *   kling-3.0     + aspect_ratio (16:9 | 9:16 | 1:1) et mode (std | pro | 4K).
 *                 resolution NON : c'est le mode qui la fixe (std 720p,
 *                 pro 1080p, 4K 2160p).
 *   seedance-2    + resolution et aspect_ratio. mode et sound NON : le son
 *                 s'y appelle generate_audio, déjà transmis.
 *   veo3          + duration (4, 6 ou 8) et resolution (720p, 1080p, 4k),
 *                 qui n'étaient JAMAIS transmis. mode/sound/generateAudio
 *                 n'existent pas : Veo livre toujours une piste audio.
 */
export async function generateVideo(apiKey, { model, prompt, imageUrl, duration, resolution, mode, sound, aspectRatio, generateAudio, variant }) {
  const headers = kieHeaders(apiKey);
  let r;

  if (model === 'seedance-2') {
    // Durée : entier de 4 à 15 s. Arrondi parce que le fournisseur compte en
    // secondes entières — un 7,5 reçu d'un client API partait tel quel.
    r = await fetchWithTimeout(`${KIE}/createTask`, { method: 'POST', headers, body: JSON.stringify({ model: 'bytedance/seedance-2', input: { prompt, first_frame_url: imageUrl, generate_audio: generateAudio === true, resolution: resolution === '480p' ? '480p' : '720p', aspect_ratio: ratioSeedance(aspectRatio), duration: Math.round(Math.min(15, Math.max(4, Number(duration) || 10))), web_search: false } }) });
  } else if (model === 'veo3') {
    /* Le mode « première et dernière image » N'EST PAS une erreur avec une
     * seule image — c'était le principal soupçon, le schéma du fournisseur le
     * lève : « FIRST_AND_LAST_FRAMES_2_VIDEO … 1 image: Generate video based
     * on the provided image ; 2 images: first image as first frame, second as
     * last frame ». imageUrls accepte 1 OU 2 images sous ce même mode.
     * Ce qui était faux, en revanche : le mode partait même sans aucune image
     * (`imageUrls: [imageUrl]` valait alors `[undefined]`), et le cadrage du
     * studio (1:1, 3:4…) partait hors énumération. On déduit donc le mode du
     * nombre d'images réellement fournies, et on borne le cadrage.
     * À observer au premier essai réel : si createTask revient en 422 en
     * citant generationType, c'est le champ à RETIRER, pas à changer — « If
     * not specified, the system will automatically determine the generation
     * mode based on whether imageUrls are provided ». */
    const images = [imageUrl].filter(Boolean);
    const corps = {
      prompt,
      model: ['veo3', 'veo3_fast', 'veo3_lite'].includes(variant) ? variant : 'veo3',
      generationType: images.length ? 'FIRST_AND_LAST_FRAMES_2_VIDEO' : 'TEXT_2_VIDEO',
      aspect_ratio: ratioVeo(aspectRatio),
    };
    if (images.length) corps.imageUrls = images;
    // Durée et résolution n'étaient pas transmises : l'interface annonçait
    // « la durée n'est pas envoyée » et le visiteur payait 8 s quoi qu'il
    // demande. On ne transmet que les valeurs du catalogue (4, 6, 8 s ;
    // 720p, 1080p, 4k) — sinon on laisse le défaut du fournisseur (8 s,
    // 720p) plutôt que d'inventer une valeur à sa place.
    const dureeVeo = Number(duration);
    if ([4, 6, 8].includes(dureeVeo)) corps.duration = dureeVeo;
    if (['720p', '1080p', '4k'].includes(resolution)) corps.resolution = resolution;
    r = await fetchWithTimeout(`${VEO_BASE}/generate`, { method: 'POST', headers, body: JSON.stringify(corps) });
  } else if (model === 'kling-3.0') {
    // Durée : chaîne, de '3' à '15'. Arrondi pour la même raison que Seedance.
    r = await fetchWithTimeout(`${KIE}/createTask`, { method: 'POST', headers, body: JSON.stringify({ model: 'kling-3.0/video', input: { prompt, image_urls: [imageUrl], sound: sound === true, duration: String(Math.round(Math.min(15, Math.max(3, Number(duration) || 8)))), aspect_ratio: ratioKling3(aspectRatio), mode: mode === 'std' ? 'std' : 'pro', multi_shots: false } }) });
  } else if (model === 'kling-2.6') {
    /* La durée se compare ici à du TEXTE ('5' ou '10' chez le fournisseur).
     * La comparaison était stricte : le studio, lui, envoie un NOMBRE
     * (public/studio.html → `body.duration = 5`), qui n'a jamais été égal à
     * '5' — toute vidéo Kling 2.6 demandée à 5 secondes partait donc en 10,
     * facturée au double, sans un mot. String() referme le trou. */
    r = await fetchWithTimeout(`${KIE}/createTask`, { method: 'POST', headers, body: JSON.stringify({ model: 'kling-2.6/image-to-video', input: { prompt, image_urls: [imageUrl], sound: sound === true, duration: String(duration) === '5' ? '5' : '10' } }) });
  } else {
    // grok-imagine (défaut). `index` a quitté la charge utile : il ne sert
    // qu'avec un task_id et le schéma le dit « ignored if image_urls is
    // provided » — il n'a jamais rien piloté ici.
    r = await fetchWithTimeout(`${KIE}/createTask`, { method: 'POST', headers, body: JSON.stringify({ model: 'grok-imagine/image-to-video', input: { image_urls: [imageUrl], mode: mode === 'fun' ? 'fun' : 'normal', duration: String(Math.round(Math.min(30, Math.max(6, Number(duration) || 10)))), resolution: resolution === '480p' ? '480p' : '720p', prompt } }) });
  }

  const data = await safeJson(r);
  if (!data.data?.taskId) throw new Error('No taskId returned');
  return { taskId: data.data.taskId, recordId: data.data.recordId || null };
}

// ─── TTS (ElevenLabs) ───

export async function tts(apiKey, { text, voice, stability, similarity_boost, style, speed }) {
  /* Le champ s'appelle bien `voice` et accepte AUSSI BIEN un nom de préréglage
   * (« Rachel », « Adam ») qu'un identifiant de voix — c'est ce que l'interface
   * envoie selon le groupe choisi. À ne pas « corriger » en `voice_id` :
   * docs/fal-integration.md l'annonce ainsi, à tort. */
  const input = { text, voice: voice || 'Rachel' };
  /* Bornes du schéma ElevenLabs chez KIE : stability, similarity_boost et style
   * dans [0,1], speed dans [0.7,1.2]. Les curseurs de l'interface les
   * respectent déjà ; ce filet ne sert qu'aux appels API directs, où une valeur
   * hors plage — ou un NaN, qui part en JSON comme `null` — faisait échouer la
   * tâche une fois le visiteur débité. */
  const stab = nombreBorne(stability, 0, 1);
  if (stab !== undefined) input.stability = stab;
  const similarite = nombreBorne(similarity_boost, 0, 1);
  if (similarite !== undefined) input.similarity_boost = similarite;
  const styleBorne = nombreBorne(style, 0, 1);
  if (styleBorne !== undefined) input.style = styleBorne;
  const vitesse = nombreBorne(speed, 0.7, 1.2);
  if (vitesse !== undefined) input.speed = vitesse;

  const r = await fetchWithTimeout(`${KIE}/createTask`, {
    method: 'POST',
    headers: kieHeaders(apiKey),
    body: JSON.stringify({ model: 'elevenlabs/text-to-speech-turbo-2-5', input }),
  });
  const data = await safeJson(r);
  if (!data.data?.taskId) throw new Error('TTS task failed');
  return { taskId: data.data.taskId, recordId: data.data.recordId || null };
}

// ─── Sound Effects (ElevenLabs) ───

export async function sfx(apiKey, { text, duration_seconds }) {
  /* `elevenlabs/sound-effect-v2` ne figure pas dans l'index public des modèles
   * de KIE au 26/08/2026 (les autres modèles ElevenLabs y sont). L'identifiant
   * est peut-être simplement absent de la documentation — à confirmer au
   * premier bruitage réel : un « model not found » viendrait de là, pas de la
   * charge utile ci-dessous. */
  const input = { text };
  // Durée : 0,5 à 22 s chez le fournisseur, et facultative (il la choisit
  // seul si on la tait). Avant, tout ce qui était « vrai » partait tel quel :
  // un 60, ou une chaîne non numérique, faisait échouer la tâche APRÈS coup.
  // Un 0 restait ignoré, et c'est toujours le cas — ce n'est pas une durée.
  const secondes = nombreBorne(duration_seconds, 0.5, 22);
  if (secondes !== undefined) input.duration_seconds = secondes;

  const r = await fetchWithTimeout(`${KIE}/createTask`, {
    method: 'POST',
    headers: kieHeaders(apiKey),
    body: JSON.stringify({ model: 'elevenlabs/sound-effect-v2', input }),
  });
  const data = await safeJson(r);
  if (!data.data?.taskId) throw new Error('SFX task failed');
  return { taskId: data.data.taskId, recordId: data.data.recordId || null };
}

// ─── Upscale Image (Topaz) ───

export async function upscaleImage(apiKey, { imageUrl, upscaleFactor }) {
  const r = await fetchWithTimeout(`${KIE}/createTask`, {
    method: 'POST',
    headers: kieHeaders(apiKey),
    // Facteur ramené à ce que Topaz sait faire (1, 2 ou 4) : voir facteurTopaz.
    body: JSON.stringify({ model: 'topaz/image-upscale', input: { image_url: imageUrl, upscale_factor: facteurTopaz(upscaleFactor) } }),
  });
  const data = await safeJson(r);
  if (!data.data?.taskId) throw new Error('Upscale task failed');
  return { taskId: data.data.taskId, recordId: data.data.recordId || null };
}

// ─── Upscale Video (Topaz) ───

export async function upscaleVideo(apiKey, { videoUrl, upscaleFactor }) {
  const r = await fetchWithTimeout(`${KIE}/createTask`, {
    method: 'POST',
    headers: kieHeaders(apiKey),
    // Même énumération que l'agrandissement d'image : 1, 2 ou 4.
    body: JSON.stringify({ model: 'topaz/video-upscale', input: { video_url: videoUrl, upscale_factor: facteurTopaz(upscaleFactor) } }),
  });
  const data = await safeJson(r);
  if (!data.data?.taskId) throw new Error('Video upscale task failed');
  return { taskId: data.data.taskId, recordId: data.data.recordId || null };
}

// ─── Cost Calculation (per generation, KIE.AI credit-based estimates) ───
export function calculateCost(type, params = {}) {
  switch (type) {
    case 'image': return 0.09;
    case 'polish':
    case 'remix':
      return 0.09;
    case 'adapt': return 0.09;
    case 'video': {
      const dur = parseInt(params.duration) || 8;
      const model = params.model || 'grok-imagine';
      /* Veo se facture à la vidéo, pas à la seconde — et sa durée n'était même
       * pas transmise au fournisseur. Le coût enregistré suivait pourtant la
       * durée demandée : une vidéo « 15 s » (durée que Veo n'accepte pas) était
       * comptée 3,75 $ au lieu de 1,25 $. Table alignée sur celle des
       * interfaces (public/tools.html). L'appelant ne transmet pas encore
       * `variant` : à défaut, on retient le tarif de la qualité haute, jamais
       * un tarif plus bas que le réel (voir le rapport). */
      if (model === 'veo3') {
        const forfaitVeo = { veo3: 1.25, veo3_fast: 0.30, veo3_lite: 0.15 };
        return forfaitVeo[params.variant] ?? forfaitVeo.veo3;
      }
      if (model === 'kling-2.6' || model === 'kling-3.0') return dur * 0.06;
      if (model === 'seedance-2') return dur * 0.05;
      return dur * 0.05; // grok-imagine
    }
    case 'img-upscale': return 0.12;
    case 'vid-upscale': return 0.70;
    case 'tts': return 0.05;
    case 'sfx': return 0.05;
    default: return 0.05;
  }
}

// ─── Polling (KIE recordInfo) ───

export async function pollTask(apiKey, { taskId, recordId, metadata }) {
  let videoModel = '';
  try {
    const meta = typeof metadata === 'string' ? JSON.parse(metadata) : (metadata || {});
    videoModel = meta.videoModel || '';
  } catch (err) { console.error('[KIE POLL META]', err.message); }
  const isVeo = videoModel === 'veo3' || videoModel === 'veo3_fast' || videoModel === 'veo3_lite';

  const params = new URLSearchParams({ taskId });
  if (recordId) params.append('recordId', recordId);

  const pollUrl = isVeo
    ? `${VEO_BASE}/record-info?taskId=${encodeURIComponent(taskId)}`
    : `${KIE}/recordInfo?${params}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const r = await fetch(pollUrl, {
      headers: kieHeaders(apiKey),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    // Fatal errors — never recoverable, mark failed immediately to free slot
    if (r.status === 401 || r.status === 403) return { status: 'failed', error: 'KIE.AI auth error — check API key' };
    if (r.status === 404) return { status: 'failed', error: 'KIE.AI task not found (expired or invalid)' };
    if (r.status === 410) return { status: 'failed', error: 'KIE.AI task expired' };
    // Transient — keep polling
    if (!r.ok) return { status: 'processing' };
    // KIE peut répondre 200 avec l'erreur dans le body
    const peek = await r.clone().json().catch(() => null);
    const bodyCode = Number(peek?.code);
    if (bodyCode === 401) return { status: 'failed', error: 'KIE.AI auth error — check API key' };
    if (bodyCode === 402) return { status: 'failed', error: 'KIE.AI credits exhausted — top up your account' };

    const data = await r.json();

    /* Veo ne parle pas la même langue que le reste du catalogue.
     *
     * /api/v1/veo/record-info rend { data: { successFlag, response: {
     * resultUrls }, errorMessage } } : ni `state`, ni `resultJson`. Le code
     * générique ci-dessous lisait donc `state` (indéfini), puis `resultJson`
     * (indéfini), et concluait « en cours » — à CHAQUE sondage, y compris sur
     * une vidéo terminée. Autrement dit : une génération Veo ne se finissait
     * jamais. Elle tournait jusqu'au délai (dix minutes pour une vidéo), puis
     * repartait en échec, la vidéo bel et bien produite et facturée restant
     * hors de portée. Un échec Veo, lui, n'était jamais lu non plus : le
     * message du fournisseur n'arrivait pas au visiteur.
     *
     * successFlag : 0 en cours · 1 succès · 2 et 3 échec. */
    if (isVeo) {
      const veo = data.data || {};
      const drapeau = Number(veo.successFlag);
      if (drapeau === 2 || drapeau === 3) {
        return { status: 'failed', error: veo.errorMessage || `KIE.AI Veo task failed (successFlag ${drapeau})` };
      }
      const urlVeo = extractUrl(veo.response);
      if (urlVeo) return { status: 'completed', resultUrl: urlVeo };
      if (drapeau === 1) {
        // Terminal annoncé sans URL : on le crie plutôt que de sonder dans le vide.
        console.error('[KIE POLL VEO] successFlag=1 sans URL. Brut :', JSON.stringify(veo.response || {}).slice(0, 500));
        return { status: 'failed', error: 'KIE.AI returned empty result' };
      }
      return { status: 'processing' };
    }

    const state = data.data?.state;
    const raw = data.data?.resultJson;

    /* L'état terminal d'échec s'écrit « fail », pas « failed » : l'énumération
     * du fournisseur est waiting | queuing | generating | success | fail. Le
     * seul mot qui compte manquait donc à cette liste — une tâche échouée
     * repartait en « en cours » et occupait son créneau jusqu'au délai, sans
     * jamais rendre le motif de l'échec ni rembourser tout de suite. */
    if (state === 'fail' || state === 'failed' || state === 'error' || state === 'cancelled') {
      const reason = data.data?.failMsg || data.data?.error || `KIE.AI task ${state}`;
      return { status: 'failed', error: reason };
    }

    if (!raw) return { status: 'processing' };

    const url = extractUrl(raw);
    if (!url) {
      // Terminal state reached but no URL extractable — log raw so we can fix extractUrl
      if (state === 'success' || state === 'completed' || state === 'done') {
        console.error('[KIE POLL] completed state but no URL extracted. Raw:', typeof raw === 'string' ? raw.slice(0, 500) : JSON.stringify(raw).slice(0, 500));
        return { status: 'failed', error: 'KIE.AI returned empty result' };
      }
      return { status: 'processing' };
    }

    return { status: 'completed', resultUrl: url };
  } catch (err) {
    clearTimeout(timeout);
    // Network/timeout — transient, keep polling
    return { status: 'processing' };
  }
}

function extractUrl(raw) {
  let url = '';
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    url = pickUrl(parsed);
  } catch (err) {
    // Raw wasn't JSON — maybe a bare URL string
    if (typeof raw === 'string' && /^https?:\/\//.test(raw.trim())) url = raw.trim();
    else console.error('[KIE EXTRACT URL] parse error:', err.message, 'raw sample:', String(raw).slice(0, 200));
  }
  const cleaned = (url || '').replace(/^["']|["']$/g, '').replace(/\s+/g, '').trim();
  if (!cleaned && raw) {
    console.warn('[KIE EXTRACT URL] no URL found in raw:', typeof raw === 'string' ? raw.slice(0, 300) : JSON.stringify(raw).slice(0, 300));
  }
  return cleaned;
}

// Recursively search common URL-bearing shapes
function pickUrl(node) {
  if (!node) return '';
  if (typeof node === 'string') return /^https?:\/\//.test(node.trim()) ? node.trim() : '';
  if (Array.isArray(node)) {
    for (const item of node) {
      const u = pickUrl(item);
      if (u) return u;
    }
    return '';
  }
  if (typeof node !== 'object') return '';
  // Direct URL fields (covers KIE, Fal, and common shapes)
  const keys = ['resultUrls', 'resultUrl', 'result_url', 'resultURL', 'output_url', 'outputUrl', 'url', 'video_url', 'videoUrl', 'image_url', 'imageUrl', 'audio_url', 'audioUrl'];
  for (const k of keys) {
    if (node[k]) {
      const u = pickUrl(node[k]);
      if (u) return u;
    }
  }
  // Nested containers
  const containers = ['results', 'result', 'output', 'outputs', 'images', 'videos', 'data', 'assets', 'files'];
  for (const k of containers) {
    if (node[k]) {
      const u = pickUrl(node[k]);
      if (u) return u;
    }
  }
  return '';
}

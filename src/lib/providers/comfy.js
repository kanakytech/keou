/**
 * Local Engine Provider — ComfyUI
 *
 * Parle à une instance ComfyUI (http://localhost:8188 par défaut) via son API
 * native : POST /prompt pour soumettre un graphe, GET /history/{id} pour le
 * sondage, GET /view pour récupérer l'image, POST /upload/image pour les
 * entrées. Aucune clé API : le « fournisseur », c'est la machine de
 * l'exploitant. C'est une feature de SELF-HOST — sur l'instance hébergée, le
 * serveur ne peut pas atteindre le localhost d'un visiteur, donc ce module ne
 * s'active que si l'opérateur pose LOCAL_ENGINE_URL sur son propre serveur.
 *
 * Périmètre v1 : images (texte→image, image→image, polish, remix, adapt) et
 * agrandissement. Vidéo, voix et SFX restent chez les fournisseurs cloud —
 * les workflows vidéo locaux dépendent trop des nodes installés pour être
 * promis à l'aveugle. On préfère un refus net à une promesse cassée.
 */

import { config } from '../../config.js';

export const name = 'local';

// ─── Plomberie HTTP ───

function base() {
  const url = (config.localEngine?.url || '').replace(/\/+$/, '');
  if (!url) throw new Error('Local engine not configured — set LOCAL_ENGINE_URL (e.g. http://localhost:8188)');
  if (!/^https?:\/\//.test(url)) throw new Error('LOCAL_ENGINE_URL must start with http:// or https://');
  return url;
}

async function fetchWithTimeout(url, opts = {}, ms = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...opts, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function comfyJson(path, opts = {}) {
  let r;
  try {
    r = await fetchWithTimeout(`${base()}${path}`, opts);
  } catch (err) {
    // undici cache l'ECONNREFUSED dans err.cause — sans ça, l'opérateur voit
    // « fetch failed » et ne sait pas que son ComfyUI est éteint.
    const cause = err?.cause?.code || err?.message || 'network error';
    throw new Error(`Local engine unreachable at ${base()} — is ComfyUI running? (${cause})`);
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Local engine: ComfyUI ${r.status} on ${path}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

/**
 * Sonde de santé — même principe que la sonde ffmpeg du serveur : dire au
 * boot et dans /health ce que le moteur local voit réellement, plutôt que de
 * laisser l'opérateur le découvrir à la première génération.
 */
export async function probeLocalEngine() {
  if (!config.localEngine?.url) return { configured: false };
  try {
    const [ckpt, up] = await Promise.all([
      comfyJson('/object_info/CheckpointLoaderSimple'),
      comfyJson('/object_info/UpscaleModelLoader').catch(() => null),
    ]);
    const checkpoints = ckpt?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
    const upscaleModels = up?.UpscaleModelLoader?.input?.required?.model_name?.[0] || [];
    const videoEngines = await detectVideoEngines().catch(() => ({}));
    return {
      configured: true, reachable: true, url: config.localEngine.url,
      checkpoints: checkpoints.length, upscaleModels: upscaleModels.length,
      video: Object.entries(videoEngines).filter(([, v]) => v).map(([k]) => k),
      active: config.defaultProvider === 'local',
    };
  } catch (err) {
    return { configured: true, reachable: false, url: config.localEngine.url, error: err.message, active: config.defaultProvider === 'local' };
  }
}

// ─── Découverte des modèles installés (cache 60 s) ───
// On ne devine JAMAIS un nom de checkpoint : une valeur hors liste fait
// échouer la tâche chez ComfyUI comme chez KIE. /object_info donne la liste
// réelle de ce que l'instance a dans models/ — l'env var de l'opérateur prime
// si elle correspond à un modèle présent, sinon on prend le premier installé.

const _models = { ckpt: { value: null, exp: 0 }, upscale: { value: null, exp: 0 } };

async function firstChoice(nodeType, inputName, cacheKey, preferred) {
  const now = Date.now();
  const c = _models[cacheKey];
  if (c.value && now < c.exp && !preferred) return c.value;

  const info = await comfyJson(`/object_info/${nodeType}`);
  const choices = info?.[nodeType]?.input?.required?.[inputName]?.[0];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(`ComfyUI has no ${nodeType} models installed — add one to the models folder`);
  }
  const picked = (preferred && choices.includes(preferred)) ? preferred : choices[0];
  _models[cacheKey] = { value: picked, exp: now + 60_000 };
  return picked;
}

const getCheckpoint = () => firstChoice('CheckpointLoaderSimple', 'ckpt_name', 'ckpt', config.localEngine?.checkpoint);
const getUpscaleModel = () => firstChoice('UpscaleModelLoader', 'model_name', 'upscale', config.localEngine?.upscaleModel);

// ─── Réglages d'échantillonnage selon la famille du modèle ───
// FLUX schnell tourne en 4 pas à CFG 1 ; FLUX dev en ~20 pas à CFG 1 ;
// SD/SDXL veulent un vrai CFG. Le nom de fichier du checkpoint est le seul
// indice fiable dont on dispose sans télécharger le modèle.

function samplerFor(ckpt) {
  const n = ckpt.toLowerCase();
  if (n.includes('schnell') || n.includes('turbo') || n.includes('lightning')) return { steps: 4, cfg: 1 };
  if (n.includes('flux')) return { steps: 20, cfg: 1 };
  return { steps: 25, cfg: 6.5 };
}

// ─── Formats ───
// Mêmes ratios que le studio (1:1, 3:4, 9:16, 16:9 + tolérés des routes),
// ramenés à ~1 mégapixel en multiples de 64 — la zone de confort de SDXL/FLUX.

const DIMS = {
  '1:1': [1024, 1024], '3:4': [896, 1152], '4:3': [1152, 896],
  '9:16': [768, 1344], '16:9': [1344, 768], '2:3': [832, 1216],
  '3:2': [1216, 832], '4:5': [896, 1120], '5:4': [1120, 896], '21:9': [1536, 640],
};
const dims = (ratio) => DIMS[ratio] || DIMS['1:1'];

const seed = () => Math.floor(Math.random() * 1e15);

// ─── Entrées image ───
// Le node LoadImage de ComfyUI ne lit que son dossier input/ local : toute
// image source doit d'abord passer par /upload/image. On télécharge donc
// l'URL (R2, provider, peu importe) et on la pousse dans l'instance.

async function uploadFromUrl(imageUrl) {
  const src = await fetchWithTimeout(imageUrl, {}, 60_000);
  if (!src.ok) throw new Error(`Cannot fetch source image (${src.status})`);
  const blob = await src.blob();
  const form = new FormData();
  const ext = (imageUrl.match(/\.(png|jpg|jpeg|webp)/i) || ['', 'png'])[1];
  form.append('image', blob, `keou-input-${Date.now()}.${ext}`);
  form.append('overwrite', 'true');
  const r = await fetchWithTimeout(`${base()}/upload/image`, { method: 'POST', body: form }, 60_000);
  if (!r.ok) throw new Error(`ComfyUI upload failed (${r.status})`);
  const data = await r.json();
  if (!data.name) throw new Error('ComfyUI upload returned no filename');
  return data;
}

// ─── Graphes ───

function baseGraph(ckpt, prompt, { steps, cfg }) {
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: prompt || '', clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality, watermark, text artifacts', clip: ['1', 1] } },
    5: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0],
        seed: seed(), steps, cfg, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
        latent_image: null, // branché par l'appelant
      },
    },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'keou' } },
  };
}

async function txt2imgGraph(prompt, ratio) {
  const ckpt = await getCheckpoint();
  const g = baseGraph(ckpt, prompt, samplerFor(ckpt));
  const [width, height] = dims(ratio);
  g[4] = { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };
  g[5].inputs.latent_image = ['4', 0];
  return g;
}

async function img2imgGraph(prompt, imageUrl, ratio, denoise) {
  const ckpt = await getCheckpoint();
  const g = baseGraph(ckpt, prompt, samplerFor(ckpt));
  const up = await uploadFromUrl(imageUrl);
  const [width, height] = dims(ratio);
  g[8] = { class_type: 'LoadImage', inputs: { image: up.name } };
  // Recadrage au format demandé AVANT l'encodage : c'est ce qui fait
  // fonctionner « adapt » (recomposition au ratio cible), et ça évite à
  // KSampler des dimensions non multiples de 64.
  g[9] = { class_type: 'ImageScale', inputs: { image: ['8', 0], upscale_method: 'lanczos', width, height, crop: 'center' } };
  g[10] = { class_type: 'VAEEncode', inputs: { pixels: ['9', 0], vae: ['1', 2] } };
  g[5].inputs.latent_image = ['10', 0];
  g[5].inputs.denoise = denoise;
  return g;
}

async function submit(graph) {
  const data = await comfyJson('/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: 'keou-local-engine' }),
  });
  if (!data.prompt_id) {
    // ComfyUI renvoie node_errors quand le graphe est refusé (node absent,
    // modèle manquant) — c'est la seule info utile pour l'opérateur.
    const detail = data.node_errors ? JSON.stringify(data.node_errors).slice(0, 200) : 'no prompt_id returned';
    throw new Error(`ComfyUI rejected the workflow: ${detail}`);
  }
  return { taskId: data.prompt_id, recordId: null };
}

// ─── Contrat provider — images ───
// La signature (apiKey, params) est celle du routeur ; la clé est ignorée.

export async function generateImage(_apiKey, { prompt, imageUrls, aspectRatio }) {
  // Avec une image produit de référence, on reste proche du pixel d'origine
  // (denoise 0.45) : c'est l'équivalent local — approché, pas identique — du
  // verrouillage produit des modèles d'édition cloud.
  if (Array.isArray(imageUrls) && imageUrls.length > 0) {
    return submit(await img2imgGraph(prompt, imageUrls[0], aspectRatio || '1:1', 0.45));
  }
  return submit(await txt2imgGraph(prompt, aspectRatio || '1:1'));
}

export async function textToImage(_apiKey, { prompt, aspectRatio }) {
  return submit(await txt2imgGraph(prompt, aspectRatio || '1:1'));
}

export async function polish(_apiKey, { prompt, imageUrl, aspectRatio }) {
  // Nettoyage léger : on retouche sans réinventer.
  return submit(await img2imgGraph(prompt, imageUrl, aspectRatio || '1:1', 0.3));
}

export async function remix(_apiKey, { prompt, imageUrl, aspectRatio }) {
  // Ré-imagination créative : on laisse plus de liberté au modèle.
  return submit(await img2imgGraph(prompt, imageUrl, aspectRatio || '1:1', 0.65));
}

export async function adapt(_apiKey, { prompt, imageUrl, aspectRatio }) {
  return submit(await img2imgGraph(prompt || 'same scene, recomposed', imageUrl, aspectRatio || '1:1', 0.5));
}

export async function upscaleImage(_apiKey, { imageUrl }) {
  // Le facteur est celui du modèle installé (RealESRGAN x4 → ×4) : ComfyUI
  // n'expose pas de facteur réglable sur ImageUpscaleWithModel.
  const model = await getUpscaleModel();
  const up = await uploadFromUrl(imageUrl);
  const graph = {
    1: { class_type: 'LoadImage', inputs: { image: up.name } },
    2: { class_type: 'UpscaleModelLoader', inputs: { model_name: model } },
    3: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['2', 0], image: ['1', 0] } },
    4: { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: 'keou-upscale' } },
  };
  return submit(graph);
}

// ─── Vidéo locale — Wan 2.2 / LTX-Video (nodes core ComfyUI) ───────────────
// Graphes reconstruits depuis les templates OFFICIELS Comfy-Org
// (video_wan2_2_5B_ti2v.json, video_wan2_2_14B_i2v.json, ltxv_*.json) — pas
// de custom node. Le gate est double : les NODES (vieille install) et surtout
// les MODÈLES (le vrai manque). On n'active que ce qui est réellement là.

const VIDEO_NEGATIVE = 'blurry, low quality, distorted, deformed, flickering, watermark, text, static image';

// Dimensions par moteur — toujours des multiples de 32 (contrainte des VAE
// vidéo), longueurs ≡ 1 mod 4 (Wan) / mod 8 (LTX), valeurs des templates.
const WAN5B_DIMS = { '1:1': [768, 768], '16:9': [1280, 704], '9:16': [704, 1280], '4:3': [960, 704], '3:4': [704, 960], '21:9': [1280, 544] };
const WAN14B_DIMS = { '1:1': [640, 640], '16:9': [832, 480], '9:16': [480, 832], '4:3': [704, 544], '3:4': [544, 704] };
const LTX_DIMS = { '1:1': [640, 640], '16:9': [768, 512], '9:16': [512, 768], '4:3': [704, 544], '3:4': [544, 704] };

async function loaderChoices(nodeType, inputName) {
  try {
    const info = await comfyJson(`/object_info/${nodeType}`);
    return info?.[nodeType]?.input?.required?.[inputName]?.[0] || [];
  } catch { return []; }
}

/**
 * Quels moteurs vidéo cette instance peut réellement servir.
 * Cache 60 s — même rythme que les checkpoints image.
 */
let _videoCache = { v: null, exp: 0 };

/** Réservé aux tests : invalide les caches modèles (image + vidéo). */
export function clearModelCache() {
  _videoCache = { v: null, exp: 0 };
  _models.ckpt = { value: null, exp: 0 };
  _models.upscale = { value: null, exp: 0 };
}
export async function detectVideoEngines() {
  const now = Date.now();
  if (_videoCache.v && now < _videoCache.exp) return _videoCache.v;

  const [unets, clips, vaes, ckpts, loras, saveNode] = await Promise.all([
    loaderChoices('UNETLoader', 'unet_name'),
    loaderChoices('CLIPLoader', 'clip_name'),
    loaderChoices('VAELoader', 'vae_name'),
    loaderChoices('CheckpointLoaderSimple', 'ckpt_name'),
    loaderChoices('LoraLoaderModelOnly', 'lora_name'),
    comfyJson('/object_info/SaveVideo').catch(() => ({})),
  ]);
  const has = (list, re) => list.find((n) => re.test(n)) || null;
  // SaveVideo est core depuis v0.3.34 (mai 2025) — absent = install trop
  // vieille pour la vidéo, on ne promet rien.
  const nodesOk = !!saveNode?.SaveVideo;

  const umt5 = has(clips, /umt5/i);
  const engines = {
    wan5b: nodesOk && has(unets, /wan2\.2.*ti2v.*5B/i) && umt5 && has(vaes, /wan2\.2_vae/i)
      ? { unet: has(unets, /wan2\.2.*ti2v.*5B/i), clip: umt5, vae: has(vaes, /wan2\.2_vae/i) } : null,
    wan14b: nodesOk && has(unets, /wan2\.2_i2v_high_noise_14B/i) && has(unets, /wan2\.2_i2v_low_noise_14B/i) && umt5 && has(vaes, /wan_2\.1_vae/i)
      ? {
          high: has(unets, /wan2\.2_i2v_high_noise_14B/i), low: has(unets, /wan2\.2_i2v_low_noise_14B/i),
          clip: umt5, vae: has(vaes, /wan_2\.1_vae/i),
          loraHigh: has(loras, /lightx2v.*high_noise/i), loraLow: has(loras, /lightx2v.*low_noise/i),
        } : null,
    ltx: nodesOk && has(ckpts, /ltx-video-2b/i) && has(clips, /t5xxl/i)
      ? { ckpt: has(ckpts, /ltx-video-2b/i), clip: has(clips, /t5xxl/i) } : null,
  };
  _videoCache = { v: engines, exp: now + 60_000 };
  return engines;
}

function pickVideoEngine(engines, wantsI2V) {
  const pin = (process.env.LOCAL_VIDEO_ENGINE || '').toLowerCase();
  if (pin && engines[pin]) return pin;
  // 5B d'abord : un seul modèle, t2v ET i2v, 8 Go de VRAM. 14B ensuite
  // (i2v uniquement, qualité max). LTX en repli léger et rapide.
  if (engines.wan5b) return 'wan5b';
  if (engines.wan14b && wantsI2V) return 'wan14b';
  if (engines.ltx) return 'ltx';
  return null;
}

async function wan5bGraph({ prompt, imageUrl, aspectRatio }) {
  const e = (await detectVideoEngines()).wan5b;
  const [width, height] = WAN5B_DIMS[aspectRatio] || WAN5B_DIMS['16:9'];
  const g = {
    37: { class_type: 'UNETLoader', inputs: { unet_name: e.unet, weight_dtype: 'default' } },
    38: { class_type: 'CLIPLoader', inputs: { clip_name: e.clip, type: 'wan', device: 'default' } },
    39: { class_type: 'VAELoader', inputs: { vae_name: e.vae } },
    48: { class_type: 'ModelSamplingSD3', inputs: { model: ['37', 0], shift: 8 } },
    6: { class_type: 'CLIPTextEncode', inputs: { clip: ['38', 0], text: prompt || '' } },
    7: { class_type: 'CLIPTextEncode', inputs: { clip: ['38', 0], text: VIDEO_NEGATIVE } },
    55: { class_type: 'Wan22ImageToVideoLatent', inputs: { vae: ['39', 0], width, height, length: 121, batch_size: 1 } },
    3: {
      class_type: 'KSampler',
      inputs: { model: ['48', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['55', 0], seed: seed(), steps: 20, cfg: 5, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1 },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['39', 0] } },
    57: { class_type: 'CreateVideo', inputs: { images: ['8', 0], fps: 24 } },
    58: { class_type: 'SaveVideo', inputs: { video: ['57', 0], filename_prefix: 'keou-video/keou', format: 'auto', codec: 'auto' } },
  };
  if (imageUrl) {
    const up = await uploadFromUrl(imageUrl);
    g[56] = { class_type: 'LoadImage', inputs: { image: up.name } };
    g[55].inputs.start_image = ['56', 0];
  }
  return g;
}

async function wan14bGraph({ prompt, imageUrl, aspectRatio }) {
  const e = (await detectVideoEngines()).wan14b;
  const [width, height] = WAN14B_DIMS[aspectRatio] || WAN14B_DIMS['16:9'];
  const up = await uploadFromUrl(imageUrl);
  const hasLora = !!(e.loraHigh && e.loraLow);
  // Avec les LoRA lightx2v : 4 pas / cfg 1 / bascule au pas 2 — le défaut du
  // template officiel. Sans : 20 pas / cfg 3.5 / bascule au pas 10.
  const steps = hasLora ? 4 : 20;
  const cfg = hasLora ? 1 : 3.5;
  const switchAt = hasLora ? 2 : 10;
  const g = {
    95: { class_type: 'UNETLoader', inputs: { unet_name: e.high, weight_dtype: 'default' } },
    96: { class_type: 'UNETLoader', inputs: { unet_name: e.low, weight_dtype: 'default' } },
    84: { class_type: 'CLIPLoader', inputs: { clip_name: e.clip, type: 'wan', device: 'default' } },
    90: { class_type: 'VAELoader', inputs: { vae_name: e.vae } },
    97: { class_type: 'LoadImage', inputs: { image: up.name } },
    93: { class_type: 'CLIPTextEncode', inputs: { clip: ['84', 0], text: prompt || '' } },
    89: { class_type: 'CLIPTextEncode', inputs: { clip: ['84', 0], text: VIDEO_NEGATIVE } },
    104: { class_type: 'ModelSamplingSD3', inputs: { model: hasLora ? ['101', 0] : ['95', 0], shift: 5 } },
    103: { class_type: 'ModelSamplingSD3', inputs: { model: hasLora ? ['102', 0] : ['96', 0], shift: 5 } },
    98: { class_type: 'WanImageToVideo', inputs: { positive: ['93', 0], negative: ['89', 0], vae: ['90', 0], start_image: ['97', 0], width, height, length: 81, batch_size: 1 } },
    86: {
      class_type: 'KSamplerAdvanced',
      inputs: { model: ['104', 0], positive: ['98', 0], negative: ['98', 1], latent_image: ['98', 2], add_noise: 'enable', noise_seed: seed(), steps, cfg, sampler_name: 'euler', scheduler: 'simple', start_at_step: 0, end_at_step: switchAt, return_with_leftover_noise: 'enable' },
    },
    85: {
      class_type: 'KSamplerAdvanced',
      inputs: { model: ['103', 0], positive: ['98', 0], negative: ['98', 1], latent_image: ['86', 0], add_noise: 'disable', noise_seed: 0, steps, cfg, sampler_name: 'euler', scheduler: 'simple', start_at_step: switchAt, end_at_step: steps, return_with_leftover_noise: 'disable' },
    },
    87: { class_type: 'VAEDecode', inputs: { samples: ['85', 0], vae: ['90', 0] } },
    94: { class_type: 'CreateVideo', inputs: { images: ['87', 0], fps: 16 } },
    108: { class_type: 'SaveVideo', inputs: { video: ['94', 0], filename_prefix: 'keou-video/keou', format: 'auto', codec: 'auto' } },
  };
  if (hasLora) {
    g[101] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['95', 0], lora_name: e.loraHigh, strength_model: 1.0 } };
    g[102] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['96', 0], lora_name: e.loraLow, strength_model: 1.0 } };
  }
  return g;
}

async function ltxGraph({ prompt, imageUrl, aspectRatio }) {
  const e = (await detectVideoEngines()).ltx;
  const [width, height] = LTX_DIMS[aspectRatio] || LTX_DIMS['16:9'];
  const g = {
    44: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: e.ckpt } },
    38: { class_type: 'CLIPLoader', inputs: { clip_name: e.clip, type: 'ltxv', device: 'default' } },
    6: { class_type: 'CLIPTextEncode', inputs: { clip: ['38', 0], text: prompt || '' } },
    7: { class_type: 'CLIPTextEncode', inputs: { clip: ['38', 0], text: 'low quality, worst quality, deformed, distorted, motion smear, motion artifacts' } },
    69: { class_type: 'LTXVConditioning', inputs: { positive: ['6', 0], negative: ['7', 0], frame_rate: 25 } },
    71: { class_type: 'LTXVScheduler', inputs: { steps: 30, max_shift: 2.05, base_shift: 0.95, stretch: true, terminal: 0.1, latent: null } },
    73: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    72: {
      class_type: 'SamplerCustom',
      inputs: { model: ['44', 0], add_noise: true, noise_seed: seed(), cfg: 3, positive: ['69', 0], negative: ['69', 1], sampler: ['73', 0], sigmas: ['71', 0], latent_image: null },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['72', 0], vae: ['44', 2] } },
    78: { class_type: 'CreateVideo', inputs: { images: ['8', 0], fps: 24 } },
    79: { class_type: 'SaveVideo', inputs: { video: ['78', 0], filename_prefix: 'keou-video/keou', format: 'auto', codec: 'auto' } },
  };
  if (imageUrl) {
    const up = await uploadFromUrl(imageUrl);
    // Piège de version : le 5e input de LTXVImgToVideo s'appelle `strength`
    // sur les builds récents, `image_noise_scale` sur les anciens — on lit
    // /object_info au lieu de deviner.
    const info = await comfyJson('/object_info/LTXVImgToVideo').catch(() => ({}));
    const inputs = info?.LTXVImgToVideo?.input?.required || {};
    const i2v = { positive: ['6', 0], negative: ['7', 0], vae: ['44', 2], image: ['80', 0], width, height, length: 97, batch_size: 1 };
    if ('strength' in inputs) i2v.strength = 1.0;
    else if ('image_noise_scale' in inputs) i2v.image_noise_scale = 0.15;
    g[80] = { class_type: 'LoadImage', inputs: { image: up.name } };
    g[77] = { class_type: 'LTXVImgToVideo', inputs: i2v };
    g[69].inputs.positive = ['77', 0];
    g[69].inputs.negative = ['77', 1];
    g[71].inputs.latent = ['77', 2];
    g[72].inputs.latent_image = ['77', 2];
  } else {
    g[70] = { class_type: 'EmptyLTXVLatentVideo', inputs: { width, height, length: 97, batch_size: 1 } };
    g[71].inputs.latent = ['70', 0];
    g[72].inputs.latent_image = ['70', 0];
  }
  return g;
}

export async function generateVideo(_apiKey, { prompt, imageUrl, aspectRatio }) {
  const engines = await detectVideoEngines();
  const engine = pickVideoEngine(engines, !!imageUrl);
  if (!engine) {
    throw new Error(
      'Local engine: no video model installed. For local video, add Wan 2.2 5B to your ComfyUI (diffusion_models/wan2.2_ti2v_5B_fp16.safetensors + text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors + vae/wan2.2_vae.safetensors — ~17 GB, runs on 8 GB VRAM) or LTX-Video 2B — or use a cloud provider key for video.'
    );
  }
  const params = { prompt, imageUrl, aspectRatio: aspectRatio || '16:9' };
  const graph = engine === 'wan5b' ? await wan5bGraph(params)
    : engine === 'wan14b' ? await wan14bGraph(params)
    : await ltxGraph(params);
  return submit(graph);
}

// ─── Hors périmètre — refus nets ───

const UNSUPPORTED = 'Local engine: voice and sound effects need a cloud provider key (KIE.AI or Fal.ai) — ComfyUI core has no TTS';

export async function tts() { throw new Error(UNSUPPORTED); }
export async function sfx() { throw new Error(UNSUPPORTED); }
export async function upscaleVideo() { throw new Error('Local engine: video upscaling still needs a cloud provider key — the local upscaler covers images'); }

// ─── Sondage ───

export async function pollTask(_apiKey, { taskId }) {
  let history;
  try { history = await comfyJson(`/history/${encodeURIComponent(taskId)}`); }
  catch (err) {
    // Instance éteinte ou redémarrée : on reste en processing — le poller
    // réessaiera, et l'expiration des tâches fera le ménage si ça ne revient
    // jamais. Échouer ici rembourserait des crédits pour un simple reboot.
    console.warn('[COMFY POLL]', err.message);
    return { status: 'processing' };
  }

  const entry = history?.[taskId];
  if (!entry) return { status: 'processing' }; // pas encore dans l'historique = en file ou en cours

  const statusStr = entry.status?.status_str;
  if (statusStr === 'error') {
    const messages = entry.status?.messages || [];
    const errMsg = messages.find((m) => m?.[0] === 'execution_error')?.[1];
    const detail = errMsg?.exception_message || 'ComfyUI execution error';
    return { status: 'failed', error: `Local engine: ${String(detail).slice(0, 300)}` };
  }

  // Succès : première image sortie d'un node SaveImage (type "output" —
  // les previews temp ne comptent pas).
  for (const nodeOut of Object.values(entry.outputs || {})) {
    const img = (nodeOut.images || []).find((i) => i.type === 'output');
    if (img) {
      const params = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: 'output' });
      return { status: 'completed', resultUrl: `${base()}/view?${params}` };
    }
  }

  // Terminé sans image : cas anormal (workflow sans SaveImage) — on le dit.
  if (entry.status?.completed) return { status: 'failed', error: 'Local engine finished without producing an image' };
  return { status: 'processing' };
}

// ─── Coût ───
// Le moteur local ne facture rien : l'électricité de l'opérateur n'est pas
// notre compteur. Zéro partout — le mode crédits journalise 0.

export function calculateCost() { return 0; }

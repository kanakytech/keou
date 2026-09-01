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
    return {
      configured: true, reachable: true, url: config.localEngine.url,
      checkpoints: checkpoints.length, upscaleModels: upscaleModels.length,
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

// ─── Hors périmètre v1 — refus nets ───

const UNSUPPORTED = 'Local engine: images and upscaling only for now — video, voice and sound effects still need a cloud provider key (KIE.AI or Fal.ai)';

export async function generateVideo() { throw new Error(UNSUPPORTED); }
export async function tts() { throw new Error(UNSUPPORTED); }
export async function sfx() { throw new Error(UNSUPPORTED); }
export async function upscaleVideo() { throw new Error(UNSUPPORTED); }

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

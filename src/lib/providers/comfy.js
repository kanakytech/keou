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
import { buildLocalEditPrompt, buildLocalImagePrompt, extractDirection, LOCAL_TASTE_VIDEO, LOCAL_TASTE_RAFFINAGE } from '../studio-prompts.js';

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

// ComfyUI expose historiquement les choix sous `[valeurs, options]`. Certains
// nœuds récents utilisent plutôt `['COMBO', { options: valeurs }]`.
function modelChoices(spec) {
  if (Array.isArray(spec?.[0])) return spec[0];
  if (Array.isArray(spec?.[1]?.options)) return spec[1].options;
  return [];
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
    const checkpoints = modelChoices(ckpt?.CheckpointLoaderSimple?.input?.required?.ckpt_name);
    const upscaleModels = modelChoices(up?.UpscaleModelLoader?.input?.required?.model_name);
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
  const choices = modelChoices(info?.[nodeType]?.input?.required?.[inputName]);
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

// Le compteur de ComfyUI (keou_00001_, 00002_…) REDÉMARRE à chaque relance du
// script de boot : un résultat pas encore copié sur R2 peut être écrasé par le
// job suivant qui reçoit le même nom. Un préfixe unique par job supprime la
// collision — le nom n'a de toute façon aucun sens métier, R2 range par id.
const prefixe = (base = 'keou') => `${base}_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;

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
    7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: prefixe() } },
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

// ─── FLUX.1 Kontext — édition par instruction ───
//
// SDXL en img2img ne sait PAS « garde ce produit, refais le décor » : une
// passe de débruitage conserve tout (denoise bas) ou tout change (denoise
// haut), sans notion d'objet à préserver. C'est précisément ce que réclame
// le brief de direction du studio (« verrouillage absolu » du produit), et
// c'est pour ça qu'un logo revenait intact sur fond inchangé.
//
// Kontext est un modèle d'ÉDITION : l'image source entre comme latent de
// référence (ReferenceLatent) plutôt que comme point de départ du bruit, et
// l'instruction textuelle décrit la transformation. C'est l'équivalent en
// poids ouverts des modèles d'édition cloud.

let _kontextCache = { v: undefined, exp: 0 };

/**
 * Un node ABSENT fait répondre ComfyUI 200 avec un objet VIDE — pas 404.
 * Tester le code HTTP conclut donc que tout existe, y compris ce qui n'existe
 * pas. On teste le contenu.
 */
async function nodeExiste(nom) {
  try {
    const d = await comfyJson(`/object_info/${nom}`);
    return !!(d && d[nom]);
  } catch { return false; }
}

export async function detectKontext() {
  const now = Date.now();
  if (_kontextCache.v !== undefined && now < _kontextCache.exp) return _kontextCache.v;

  const [unets, clips, vaes, refOk] = await Promise.all([
    loaderChoices('UNETLoader', 'unet_name'),
    loaderChoices('DualCLIPLoader', 'clip_name1'),
    loaderChoices('VAELoader', 'vae_name'),
    // ReferenceLatent n'existe qu'à partir de ComfyUI v0.3.44. Sans lui,
    // Kontext ne peut pas recevoir son image de référence : on préfère un
    // refus net à un graphe qui part et rend n'importe quoi.
    nodeExiste('ReferenceLatent'),
  ]);
  const trouve = (liste, re) => liste.find((n) => re.test(n)) || null;

  const unet = trouve(unets, /flux1.*kontext/i);
  const clipL = trouve(clips, /clip_l/i);
  const t5 = trouve(clips, /t5xxl/i);
  const vae = trouve(vaes, /^ae\.|flux.*ae/i);

  const v = refOk && unet && clipL && t5 && vae ? { unet, clipL, t5, vae } : null;
  _kontextCache = { v, exp: now + 60_000 };
  return v;
}

/**
 * Graphe Kontext. `instruction` décrit la TRANSFORMATION (« pose ce logo sur
 * le sable, ombres et reflets réalistes »), pas la scène finale.
 */
async function kontextGraph(instruction, imageUrl, ratio) {
  const k = await detectKontext();
  if (!k) throw new Error('Local engine: FLUX Kontext not installed — instruction editing needs flux1-dev-kontext, clip_l, t5xxl and ae in ComfyUI, on ComfyUI >= v0.3.44');
  const up = await uploadFromUrl(imageUrl);
  const [width, height] = dims(ratio);
  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: k.unet, weight_dtype: 'fp8_e4m3fn' } },
    2: { class_type: 'DualCLIPLoader', inputs: { clip_name1: k.clipL, clip_name2: k.t5, type: 'flux' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: k.vae } },
    4: { class_type: 'LoadImage', inputs: { image: up.name } },
    5: { class_type: 'ImageScale', inputs: { image: ['4', 0], upscale_method: 'lanczos', width, height, crop: 'center' } },
    6: { class_type: 'VAEEncode', inputs: { pixels: ['5', 0], vae: ['3', 0] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: instruction || '', clip: ['2', 0] } },
    // Le latent de référence : c'est CE branchement qui distingue une édition
    // d'un simple img2img.
    8: { class_type: 'ReferenceLatent', inputs: { conditioning: ['7', 0], latent: ['6', 0] } },
    9: { class_type: 'FluxGuidance', inputs: { conditioning: ['8', 0], guidance: 2.5 } },
    10: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
    // FLUX est un modèle guidance-distilled : cfg 1 et scheduler simple.
    // Un vrai CFG le fait diverger.
    11: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['9', 0], negative: ['10', 0], latent_image: ['6', 0],
        seed: seed(), steps: 20, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
      },
    },
    12: { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } },
    13: { class_type: 'SaveImage', inputs: { images: ['12', 0], filename_prefix: prefixe() } },
  };
}

export function clearKontextCache() { _kontextCache = { v: undefined, exp: 0 }; }

/**
 * Texte→image avec l'unet Kontext (poids FLUX.1-dev). Sans latent de
 * référence, Kontext génère comme FLUX : très au-dessus de SDXL en rendu
 * photo, texte et cohérence — et zéro octet de plus à télécharger.
 */
/**
 * FLUX livré en checkpoint TOUT-EN-UN (Comfy-Org/flux1-dev, ~16 Go, un seul
 * fichier qui porte l'unet, les deux encodeurs et le VAE).
 *
 * C'est la distribution que la plupart des gens téléchargent, et le studio ne
 * la voyait pas : il ne cherchait que le montage en fichiers séparés
 * (UNETLoader + DualCLIPLoader + VAELoader). Une box avec FLUX installé
 * retombait donc sur SDXL sans que personne comprenne pourquoi.
 */
let _fluxCkptCache = { v: undefined, exp: 0 };
export function clearFluxCkptCache() { _fluxCkptCache = { v: undefined, exp: 0 }; }

async function detectFluxCheckpoint() {
  const now = Date.now();
  if (_fluxCkptCache.v !== undefined && now < _fluxCkptCache.exp) return _fluxCkptCache.v;
  const ckpts = await loaderChoices('CheckpointLoaderSimple', 'ckpt_name').catch(() => []);
  // « flux » ET pas « ltx » : les deux cohabitent sur la même machine.
  const v = ckpts.find((n) => /flux/i.test(n) && !/ltx/i.test(n)) || null;
  _fluxCkptCache = { v, exp: now + 60_000 };
  return v;
}

/**
 * Texte→image FLUX depuis le checkpoint tout-en-un.
 *
 * `width`/`height` sont explicites : l'image de départ d'une vidéo doit être
 * NATIVEMENT nette à la résolution où le modèle vidéo la regardera. Une image
 * molle agrandie apporte du détail inventé ; une image générée large puis
 * réduite au lanczos apporte du détail réel. C'est la différence qu'on voit
 * à l'image sur un plan de 4 secondes.
 */
async function fluxCkptTxt2imgGraph(prompt, ratio, { width, height, steps } = {}) {
  const ckpt = await detectFluxCheckpoint();
  if (!ckpt) throw new Error('Local engine: FLUX checkpoint not installed');
  const [w, h] = width && height ? [width, height] : await fluxDims(ratio);
  // schnell est DISTILLÉ pour 4 pas : lui en imposer 28 coûte sept fois
  // le temps sans rien ajouter à l'image. samplerFor tranche par le nom.
  const pas = steps || samplerFor(ckpt).steps;
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    2: { class_type: 'ModelSamplingFlux', inputs: { model: ['1', 0], max_shift: 1.15, base_shift: 0.5, width: w, height: h } },
    3: { class_type: 'EmptySD3LatentImage', inputs: { width: w, height: h, batch_size: 1 } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: prompt || '', clip: ['1', 1] } },
    5: { class_type: 'FluxGuidance', inputs: { conditioning: ['4', 0], guidance: 3.5 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    7: {
      class_type: 'KSampler',
      inputs: {
        model: ['2', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['3', 0],
        seed: seed(), steps: pas, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
      },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['1', 2] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: prefixe() } },
  };
}

async function fluxTxt2imgGraph(prompt, ratio) {
  const k = await detectKontext();
  if (!k) throw new Error('Local engine: FLUX not installed');
  const [width, height] = dims(ratio);
  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: k.unet, weight_dtype: 'fp8_e4m3fn' } },
    2: { class_type: 'DualCLIPLoader', inputs: { clip_name1: k.clipL, clip_name2: k.t5, type: 'flux' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: k.vae } },
    // ModelSamplingFlux : le décalage de bruit recommandé pour FLUX à ~1 Mpx.
    4: { class_type: 'ModelSamplingFlux', inputs: { model: ['1', 0], max_shift: 1.15, base_shift: 0.5, width, height } },
    5: { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: prompt || '', clip: ['2', 0] } },
    7: { class_type: 'FluxGuidance', inputs: { conditioning: ['6', 0], guidance: 3.5 } },
    8: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
    9: {
      class_type: 'KSampler',
      inputs: {
        model: ['4', 0], positive: ['7', 0], negative: ['8', 0], latent_image: ['5', 0],
        seed: seed(), steps: 24, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
      },
    },
    10: { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['3', 0] } },
    11: { class_type: 'SaveImage', inputs: { images: ['10', 0], filename_prefix: prefixe() } },
  };
}

// ─── Capacités ───
// Le routeur demande « sais-tu faire ça ? » AVANT de choisir un fournisseur,
// pour envoyer au cloud ce que la machine ne sait pas faire plutôt que de
// laisser l'utilisateur découvrir un refus. Les réponses sont toutes issues
// des caches de détection déjà en place (60 s) : aucun aller-retour de plus.
export async function supports(action) {
  switch (action) {
    // Un checkpoint image est le minimum vital d'une box : si la machine
    // répond, SDXL (ou équivalent) est là. Kontext n'est pas requis — sans
    // lui on retombe sur img2img, dégradé mais fonctionnel.
    case 'image': case 'polish': case 'remix': case 'adapt': return true;
    case 'img-upscale': {
      const modeles = await loaderChoices('UpscaleModelLoader', 'model_name').catch(() => []);
      return modeles.length > 0;
    }
    case 'video': {
      const e = await detectVideoEngines().catch(() => ({}));
      return Object.values(e).some(Boolean);
    }
    // ComfyUI core n'a ni TTS, ni SFX, ni agrandisseur vidéo digne de ce nom.
    case 'tts': case 'sfx': case 'vid-upscale': return false;
    default: return false;
  }
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

export async function generateImage(_apiKey, { prompt, instruction, imageUrls, aspectRatio }) {
  if (Array.isArray(imageUrls) && imageUrls.length > 0) {
    // Une image de référence = une demande d'ÉDITION. Kontext sait tenir le
    // produit et refaire le décor ; SDXL non. On prend le bon outil quand il
    // est installé, et on retombe sur l'approximation historique sinon —
    // denoise 0.45, qui conserve beaucoup et transforme peu.
    //
    // `prompt` arrive enveloppé dans le brief de direction du studio (un JSON
    // en chinois écrit pour les modèles d'édition cloud). Kontext lit une
    // consigne impérative en clair — « pose cette bouteille sur du sable
    // mouillé » — pas un objet JSON. keou-actions.js passe donc AUSSI la
    // direction brute dans `instruction` ; c'est elle que Kontext reçoit.
    if (await detectKontext()) {
      const direction = extractDirection(prompt, instruction);
      return submit(await kontextGraph(buildLocalEditPrompt(direction), imageUrls[0], aspectRatio || '1:1'));
    }
    return submit(await img2imgGraph(prompt, imageUrls[0], aspectRatio || '1:1', 0.45));
  }
  if (await detectKontext()) {
    return submit(await fluxTxt2imgGraph(buildLocalImagePrompt(extractDirection(prompt, instruction)), aspectRatio || '1:1'));
  }
  return submit(await txt2imgGraph(prompt, aspectRatio || '1:1'));
}

export async function textToImage(_apiKey, { prompt, instruction, aspectRatio, width, height }) {
  const brief = buildLocalImagePrompt(extractDirection(prompt, instruction));
  // Ordre de préférence : FLUX (checkpoint tout-en-un OU fichiers séparés),
  // puis SDXL. FLUX est très au-dessus en rendu photo, en texte et en
  // cohérence — on ne retombe sur SDXL que s'il n'y a rien d'autre.
  if (await detectFluxCheckpoint()) {
    return submit(await fluxCkptTxt2imgGraph(brief, aspectRatio || '1:1', { width, height }));
  }
  if (await detectKontext()) {
    return submit(await fluxTxt2imgGraph(brief, aspectRatio || '1:1'));
  }
  return submit(await txt2imgGraph(prompt, aspectRatio || '1:1'));
}

export async function polish(_apiKey, { prompt, imageUrl, aspectRatio }) {
  // Une retouche est une édition : Kontext sait polir sans réinventer.
  if (await detectKontext()) {
    return submit(await kontextGraph(buildLocalEditPrompt('apply professional studio-grade retouching: cleaner lighting, richer materials, refined color grading — change nothing else'), imageUrl, aspectRatio || '1:1'));
  }
  return submit(await img2imgGraph(prompt, imageUrl, aspectRatio || '1:1', 0.3));
}

export async function remix(_apiKey, { prompt, imageUrl, aspectRatio }) {
  // Ré-imagination créative : on laisse plus de liberté au modèle.
  return submit(await img2imgGraph(prompt, imageUrl, aspectRatio || '1:1', 0.65));
}

export async function adapt(_apiKey, { prompt, imageUrl, aspectRatio }) {
  return submit(await img2imgGraph(prompt || 'same scene, recomposed', imageUrl, aspectRatio || '1:1', 0.5));
}

/**
 * Agrandissement GÉNÉRATIF avec FLUX — ×2 en espace pixel puis passe fine.
 *
 * ESRGAN invente du détail plausible par voisinage de pixels, sans savoir ce
 * qu'il regarde : sur une arête nette ça fourmille, sur une peau ça plastifie.
 * Ici on agrandit au lanczos — déterministe, il n'invente aucune structure —
 * puis on laisse le modèle repasser à 0,25 de bruit : il ajoute de la matière
 * fine en connaissant le sujet, sans avoir la liberté de le redessiner.
 *
 * L'agrandissement en LATENT (LatentUpscale) a été essayé et rejeté : il laisse
 * une grille régulière visible sur les aplats, et à un bruit assez fort pour
 * l'effacer, le modèle recompose la scène.
 */
async function fluxUpscaleGraph(imageUrl) {
  const ckpt = await detectFluxCheckpoint();
  const up = await uploadFromUrl(imageUrl);
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    2: { class_type: 'LoadImage', inputs: { image: up.name } },
    3: { class_type: 'ImageScaleBy', inputs: { image: ['2', 0], upscale_method: 'lanczos', scale_by: 2 } },
    4: { class_type: 'VAEEncode', inputs: { pixels: ['3', 0], vae: ['1', 2] } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: UPSCALE_BRIEF, clip: ['1', 1] } },
    6: { class_type: 'FluxGuidance', inputs: { conditioning: ['5', 0], guidance: 3.5 } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    8: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['4', 0],
        seed: seed(), steps: 10, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 0.25,
      },
    },
    // Décodage par tuiles : une image 4K dépasse le VAE d'un coup sur beaucoup
    // de cartes, et un échec ici gâcherait tout le calcul déjà fait.
    9: { class_type: 'VAEDecodeTiled', inputs: { samples: ['8', 0], vae: ['1', 2], tile_size: 1024, overlap: 64, temporal_size: 64, temporal_overlap: 8 } },
    10: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: prefixe('keou-upscale') } },
  };
}

// Consigne volontairement NEUTRE : on agrandit, on ne réinterprète pas. Y
// remettre la direction créative rouvrirait la porte à la recomposition.
const UPSCALE_BRIEF = LOCAL_TASTE_RAFFINAGE;

/**
 * Agrandissement par DIFFUSION EN TUILES (Ultimate SD Upscale).
 *
 * L'image agrandie est découpée en tuiles d'environ 1 Mpx — la zone où le
 * modèle est bon — et chacune repasse par l'échantillonneur. Le modèle ajoute
 * donc du détail en connaissant le sujet, au lieu d'en inventer à une échelle
 * qu'il n'a jamais vue.
 *
 * Mesuré le 06/09 sur un même rendu porté en 4K, écart entre colonnes voisines
 * sur un aplat de bitume — plus bas veut dire moins d'artefact :
 *   lanczos simple (la référence) . . . 14,4
 *   seconde passe FLUX en latent . . . . 21,4   trame en damier
 *   ESRGAN x4 seul . . . . . . . . . . . 4,4   propre mais lisse les dégradés
 *   diffusion en tuiles . . . . . . . . . 1,89  le plus propre des quatre
 *
 * Sans passe de raccords : avec 16 de flou de masque et 64 de débord les
 * jonctions ne se voient pas, et la passe de raccords doublait le temps
 * (18 tuiles au lieu de 8).
 */
async function usduGraph(imageUrl, ckpt, modeleAgrandisseur) {
  const up = await uploadFromUrl(imageUrl);
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    2: { class_type: 'LoadImage', inputs: { image: up.name } },
    3: { class_type: 'ModelSamplingFlux', inputs: { model: ['1', 0], max_shift: 1.15, base_shift: 0.5, width: 1920, height: 1080 } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: UPSCALE_BRIEF, clip: ['1', 1] } },
    5: { class_type: 'FluxGuidance', inputs: { conditioning: ['4', 0], guidance: 3.5 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    7: { class_type: 'UpscaleModelLoader', inputs: { model_name: modeleAgrandisseur } },
    8: {
      class_type: 'UltimateSDUpscale',
      inputs: {
        image: ['2', 0], model: ['3', 0], positive: ['5', 0], negative: ['6', 0], vae: ['1', 2],
        upscale_by: 2, seed: seed(), steps: 14, cfg: 1, sampler_name: 'euler', scheduler: 'simple',
        // 0,2 : le sujet ne bouge pas d'une tuile à l'autre. Au-delà de 0,3
        // les tuiles divergent et les raccords se voient.
        denoise: 0.2, upscale_model: ['7', 0], mode_type: 'Linear',
        tile_width: 1024, tile_height: 1024, mask_blur: 16, tile_padding: 64,
        seam_fix_mode: 'None', seam_fix_denoise: 0.4, seam_fix_width: 96,
        seam_fix_mask_blur: 16, seam_fix_padding: 32,
        force_uniform_tiles: true, tiled_decode: true, batch_size: 1,
      },
    },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: prefixe('keou-upscale') } },
  };
}

export async function upscaleImage(_apiKey, { imageUrl }) {
  // ESRGAN d'abord — il est FAIT pour agrandir une image fixe. Le reproche
  // qu'on lui fait (le fourmillement) vaut pour la VIDÉO, où il traite chaque
  // image sans mémoire de la précédente : sur une image seule il n'y a pas de
  // suite à trahir. Mesuré le 06/09 sur un même rendu porté en 4K, écart entre
  // colonnes voisines sur un aplat de bitume : 14,4 pour un simple lanczos
  // (la référence), 21,4 en repassant FLUX sur le latent 4K — une trame en
  // damier bien réelle, FLUX sortant de sa résolution d'entraînement — et 4,4
  // avec l'agrandisseur dédié, soit plus propre que la référence.
  const model = await getUpscaleModel().catch(() => null);
  const ckptFlux = await detectFluxCheckpoint();
  // Le meilleur chemin quand tout est là : diffusion en tuiles. Il a besoin
  // d'un modèle de diffusion ET d'un agrandisseur classique — il se sert du
  // second pour poser la trame, du premier pour y remettre de la matière.
  if (model && ckptFlux && await nodeExiste('UltimateSDUpscale')) {
    return submit(await usduGraph(imageUrl, ckptFlux, model));
  }
  if (!model) {
    // Aucun agrandisseur installé : plutôt que de refuser, on se rabat sur
    // FLUX. Moins bon, mais l'utilisateur obtient son image.
    if (await detectFluxCheckpoint()) return submit(await fluxUpscaleGraph(imageUrl));
    throw new Error('Local engine: no upscale model installed — add one to models/upscale_models (e.g. 4x-UltraSharp.pth)');
  }
  // Le facteur est celui du modèle installé (RealESRGAN x4 → ×4) : ComfyUI
  // n'expose pas de facteur réglable sur ImageUpscaleWithModel.
  const up = await uploadFromUrl(imageUrl);
  const graph = {
    1: { class_type: 'LoadImage', inputs: { image: up.name } },
    2: { class_type: 'UpscaleModelLoader', inputs: { model_name: model } },
    3: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['2', 0], image: ['1', 0] } },
    4: { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: prefixe('keou-upscale') } },
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
// Résolution native de Wan 2.2 14B. Le jeu 832x480 était calibré pour une
// carte de 32 Go ; il plafonnait la qualité bien avant le modèle. Mesuré le
// 05/09 : un master 4K60 tiré d'un 832x480 garde une luminance moyenne de
// 32/255 et montre du warping RIFE dans les zones sombres — il n'y a pas
// assez d'information source à reconstruire. 1280x720 donne 2,3x plus de
// pixels réels et demande ~48 Go de VRAM sur le 14B.
const WAN14B_DIMS = { '1:1': [960, 960], '16:9': [1280, 720], '9:16': [720, 1280], '4:3': [1024, 768], '3:4': [768, 1024] };
// LTX-2.3 : dimensions FINALES. L'étage 1 échantillonne à la moitié, donc
// chaque côté doit être divisible par 64 (le latent veut des multiples de 32).
//
// Deux jeux, choisis sur la VRAM RÉELLE de la machine et pas sur une constante :
// une image de départ nette ne sert à rien si le modèle la réduit ensuite à
// 1280x704. Mesuré le 06/09 sur une RTX 5090 32 Go : le jeu haut passe grâce
// au déchargement dynamique de ComfyUI (30,6 Go utilisés, 71 s au lieu de 43).
// En dessous de 30 Go on reste sur le jeu standard — mieux vaut un plan un peu
// moins défini qu'une génération qui meurt en fin de course.
const LTX23_DIMS_HD = { '1:1': [1536, 1536], '16:9': [1920, 1088], '9:16': [1088, 1920], '4:3': [1600, 1216], '3:4': [1216, 1600], '21:9': [1920, 832] };
const LTX23_DIMS = { '1:1': [1024, 1024], '16:9': [1280, 704], '9:16': [704, 1280], '4:3': [1024, 768], '3:4': [768, 1024], '21:9': [1216, 512] };

// VRAM totale annoncée par ComfyUI, en Go. Cache long : le matériel ne change
// pas sous les pieds d'une instance.
let _vramCache = { v: null, exp: 0 };
async function vramTotaleGo() {
  const now = Date.now();
  if (_vramCache.v !== null && now < _vramCache.exp) return _vramCache.v;
  let v = 0;
  try {
    const st = await comfyJson('/system_stats');
    v = Math.max(0, ...(st?.devices || []).map((d) => (d?.vram_total || 0) / 1073741824));
  } catch { v = 0; }
  _vramCache = { v, exp: now + 600_000 };
  return v;
}

/**
 * Dimensions FLUX. Sur une machine capable, on génère à la résolution EXACTE
 * que le modèle vidéo utilisera (LTX23_DIMS_HD) : l'image de départ d'une
 * vidéo ne subit alors aucun redimensionnement, ni vers le haut ni vers le
 * bas. Générer en 1344x768 pour une vidéo en 1920x1088 revenait à agrandir —
 * donc à inventer du détail — juste avant l'étape qui compte.
 *
 * Sur une petite machine on reste à ~1 Mpx : FLUX y est déjà excellent, et
 * une génération qui aboutit vaut mieux qu'une définition qui sature la carte.
 */
async function fluxDims(ratio) {
  const table = (await vramTotaleGo()) >= 30 ? LTX23_DIMS_HD : DIMS;
  return table[ratio] || table['16:9'] || DIMS['1:1'];
}

/** Le jeu de dimensions que cette machine peut réellement tenir. */
async function ltx23Dims(ratio) {
  const table = (await vramTotaleGo()) >= 30 ? LTX23_DIMS_HD : LTX23_DIMS;
  return table[ratio] || table['16:9'];
}
const LTX_DIMS = { '1:1': [640, 640], '16:9': [768, 512], '9:16': [512, 768], '4:3': [704, 544], '3:4': [544, 704] };

async function loaderChoices(nodeType, inputName) {
  try {
    const info = await comfyJson(`/object_info/${nodeType}`);
    return modelChoices(info?.[nodeType]?.input?.required?.[inputName]);
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

  const [unets, clips, vaes, ckpts, loras, saveNode, gemmas, latentUp, inplaceNode] = await Promise.all([
    loaderChoices('UNETLoader', 'unet_name'),
    loaderChoices('CLIPLoader', 'clip_name'),
    loaderChoices('VAELoader', 'vae_name'),
    loaderChoices('CheckpointLoaderSimple', 'ckpt_name'),
    loaderChoices('LoraLoaderModelOnly', 'lora_name'),
    comfyJson('/object_info/SaveVideo').catch(() => ({})),
    loaderChoices('LTXAVTextEncoderLoader', 'text_encoder'),
    loaderChoices('LatentUpscaleModelLoader', 'model_name'),
    comfyJson('/object_info/LTXVImgToVideoInplace').catch(() => ({})),
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
    // LTX-2.3 22B — le seul moteur local dont l'agrandissement se fait DANS
    // le latent, par un upscaler entraîné avec le modèle. Tout le reste
    // (ESRGAN & co) invente des pixels image par image, d'où le fourmillement
    // sur les arêtes. Exigeant : ~30 Go de VRAM, et les nodes LTX 2.x ne sont
    // arrivés dans ComfyUI qu'en septembre 2026 — d'où la vérification du
    // node, pas seulement des fichiers.
    ltx23: nodesOk && inplaceNode?.LTXVImgToVideoInplace && has(ckpts, /ltx-2\.3.*22b/i)
      && has(gemmas, /gemma/i) && has(latentUp, /spatial-upscaler/i)
      ? {
          ckpt: has(ckpts, /ltx-2\.3.*22b/i), gemma: has(gemmas, /gemma/i),
          upscaler: has(latentUp, /spatial-upscaler/i),
          lora: has(loras, /ltx_2\.3.*distilled/i),
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
  // LTX-2.3 d'abord quand il est là : c'est le seul à tenir la cohérence
  // temporelle à l'agrandissement. Puis 5B (un seul modèle, t2v ET i2v,
  // 8 Go de VRAM), puis 14B ensuite
  // (i2v uniquement, qualité max). LTX en repli léger et rapide.
  if (engines.ltx23) return 'ltx23';
  if (engines.wan5b) return 'wan5b';
  if (engines.wan14b && wantsI2V) return 'wan14b';
  if (engines.ltx) return 'ltx';
  return null;
}

// Wan travaille par paquets de 4 images + 1 : 81 (3,3 s), 121 (5 s, natif),
// 161, 201, 241 (10 s). Au-delà de 5 s, la cohérence peut dériver et la VRAM
// grimpe — on borne à 241 et on laisse le résultat parler.
function framesPour(duration, fps = 24) {
  const sec = Math.max(2, Math.min(10, Number(duration) || 5));
  return Math.round((sec * fps) / 4) * 4 + 1;
}

// LTX-2.3 travaille par paquets de 8 images + 1 : 97 (4 s), 121 (5 s), 241 (10 s).
function framesPourLtx23(duration, fps = 24) {
  const sec = Math.max(2, Math.min(10, Number(duration) || 4));
  return Math.round((sec * fps) / 8) * 8 + 1;
}

// Sigmas du template officiel video_ltx2_3_i2v.json. L'étage 2 repart à 0,85
// : assez de bruit pour reconstruire du détail à la nouvelle échelle, pas
// assez pour réinventer la scène.
const LTX23_SIGMAS_1 = '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0';
const LTX23_SIGMAS_2 = '0.85, 0.7250, 0.4219, 0.0';

/**
 * LTX-2.3 22B, pipeline officiel à deux étages.
 *
 * Étage 1 : échantillonnage à la MOITIÉ de la résolution demandée.
 * Étage 2 : LTXVLatentUpsampler x2 dans l'espace latent — l'agrandisseur natif
 *   du modèle, entraîné avec lui — puis un second échantillonnage court qui
 *   régénère le détail à la nouvelle échelle.
 *
 * C'est ce qui sépare ce moteur de tout le reste : l'agrandissement n'est pas
 * un post-traitement image par image (ESRGAN & co, d'où le fourmillement sur
 * les arêtes), c'est le modèle lui-même qui régénère en gardant sa cohérence
 * temporelle. Mesuré le 06/09 : 4 s en 1280x704 rendues en 38 s, sans dérive
 * de la carrosserie ni des jantes entre la première et la dernière image.
 *
 * LTX 2.3 est un modèle AUDIO-vidéo : le latent audio doit accompagner le
 * latent vidéo dans l'échantillonneur même quand on ne garde que l'image,
 * sinon le modèle reçoit une forme qu'il n'a jamais vue.
 */
async function ltx23Graph({ prompt, imageUrl, aspectRatio, duration }) {
  const e = (await detectVideoEngines()).ltx23;
  const [width, height] = await ltx23Dims(aspectRatio);
  const frames = framesPourLtx23(duration);
  const fps = 24;

  const g = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: e.ckpt } },
    2: { class_type: 'LTXAVTextEncoderLoader', inputs: { text_encoder: e.gemma, ckpt_name: e.ckpt, device: 'default' } },
    7: { class_type: 'EmptyLTXVLatentVideo', inputs: { width: width / 2, height: height / 2, length: frames, batch_size: 1 } },
    9: { class_type: 'LTXVAudioVAELoader', inputs: { ckpt_name: e.ckpt } },
    10: { class_type: 'LTXVEmptyLatentAudio', inputs: { audio_vae: ['9', 0], frames_number: frames, frame_rate: 25, batch_size: 1 } },
    12: { class_type: 'CLIPTextEncode', inputs: { text: `${prompt}. ${LOCAL_TASTE_VIDEO}`, clip: ['2', 0] } },
    13: { class_type: 'CLIPTextEncode', inputs: { text: VIDEO_NEGATIVE, clip: ['2', 0] } },
    14: { class_type: 'LTXVConditioning', inputs: { positive: ['12', 0], negative: ['13', 0], frame_rate: fps } },
    16: { class_type: 'RandomNoise', inputs: { noise_seed: Math.floor(Math.random() * 1e15) } },
    17: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    18: { class_type: 'ManualSigmas', inputs: { sigmas: LTX23_SIGMAS_1 } },
    20: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['19', 0] } },
    21: { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: e.upscaler } },
    22: { class_type: 'LTXVLatentUpsampler', inputs: { samples: ['20', 0], upscale_model: ['21', 0], vae: ['1', 2] } },
    25: { class_type: 'LTXVCropGuides', inputs: { positive: ['14', 0], negative: ['14', 1], latent: ['20', 0] } },
    27: { class_type: 'RandomNoise', inputs: { noise_seed: 42 } },
    28: { class_type: 'ManualSigmas', inputs: { sigmas: LTX23_SIGMAS_2 } },
    30: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['29', 0] } },
    31: { class_type: 'VAEDecodeTiled', inputs: { samples: ['30', 0], vae: ['1', 2], tile_size: 768, overlap: 64, temporal_size: 4096, temporal_overlap: 4 } },
    32: { class_type: 'CreateVideo', inputs: { images: ['31', 0], fps } },
    33: { class_type: 'SaveVideo', inputs: { video: ['32', 0], filename_prefix: prefixe('keou-video/keou'), format: 'auto', codec: 'auto' } },
  };

  // La LoRA distillée n'est pas obligatoire : sans elle le modèle tourne, avec
  // elle il converge en moins d'étapes. On ne la rend jamais requise.
  const modele = e.lora
    ? (g[3] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: e.lora, strength_model: 0.5 } }, ['3', 0])
    : ['1', 0];

  // Image de départ : redimensionnée puis passée par LTXVPreprocess, qui
  // applique la compression JPEG que le modèle attend sur son conditionnement.
  // LTXVImgToVideoInplace injecte l'image DANS le latent — aux deux étages,
  // sinon l'étage 2 perd l'ancrage et redessine le sujet.
  let latentVideo = ['7', 0];
  if (imageUrl) {
    const up = await uploadFromUrl(imageUrl);
    g[4] = { class_type: 'LoadImage', inputs: { image: up.name } };
    g[5] = { class_type: 'ImageScale', inputs: { image: ['4', 0], upscale_method: 'lanczos', width, height, crop: 'center' } };
    g[6] = { class_type: 'LTXVPreprocess', inputs: { image: ['5', 0], img_compression: 18 } };
    g[8] = { class_type: 'LTXVImgToVideoInplace', inputs: { vae: ['1', 2], image: ['6', 0], latent: ['7', 0], strength: 0.7, bypass: false } };
    g[23] = { class_type: 'LTXVImgToVideoInplace', inputs: { vae: ['1', 2], image: ['6', 0], latent: ['22', 0], strength: 1, bypass: false } };
    latentVideo = ['8', 0];
  }

  g[11] = { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: latentVideo, audio_latent: ['10', 0] } };
  g[15] = { class_type: 'CFGGuider', inputs: { model: modele, positive: ['14', 0], negative: ['14', 1], cfg: 1 } };
  g[19] = { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['16', 0], guider: ['15', 0], sampler: ['17', 0], sigmas: ['18', 0], latent_image: ['11', 0] } };
  g[24] = { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: imageUrl ? ['23', 0] : ['22', 0], audio_latent: ['20', 1] } };
  g[26] = { class_type: 'CFGGuider', inputs: { model: modele, positive: ['25', 0], negative: ['25', 1], cfg: 1 } };
  g[29] = { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['27', 0], guider: ['26', 0], sampler: ['17', 0], sigmas: ['28', 0], latent_image: ['24', 0] } };

  return g;
}

async function wan5bGraph({ prompt, imageUrl, aspectRatio, duration }) {
  const e = (await detectVideoEngines()).wan5b;
  const [width, height] = WAN5B_DIMS[aspectRatio] || WAN5B_DIMS['16:9'];
  const g = {
    37: { class_type: 'UNETLoader', inputs: { unet_name: e.unet, weight_dtype: 'default' } },
    38: { class_type: 'CLIPLoader', inputs: { clip_name: e.clip, type: 'wan', device: 'default' } },
    39: { class_type: 'VAELoader', inputs: { vae_name: e.vae } },
    48: { class_type: 'ModelSamplingSD3', inputs: { model: ['37', 0], shift: 8 } },
    6: { class_type: 'CLIPTextEncode', inputs: { clip: ['38', 0], text: prompt || '' } },
    7: { class_type: 'CLIPTextEncode', inputs: { clip: ['38', 0], text: VIDEO_NEGATIVE } },
    55: { class_type: 'Wan22ImageToVideoLatent', inputs: { vae: ['39', 0], width, height, length: framesPour(duration), batch_size: 1 } },
    3: {
      class_type: 'KSampler',
      inputs: { model: ['48', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['55', 0], seed: seed(), steps: 20, cfg: 5, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1 },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['39', 0] } },
    57: { class_type: 'CreateVideo', inputs: { images: ['8', 0], fps: 24 } },
    58: { class_type: 'SaveVideo', inputs: { video: ['57', 0], filename_prefix: prefixe('keou-video/keou'), format: 'auto', codec: 'auto' } },
  };
  if (imageUrl) {
    const up = await uploadFromUrl(imageUrl);
    g[56] = { class_type: 'LoadImage', inputs: { image: up.name } };
    g[55].inputs.start_image = ['56', 0];
  }
  return g;
}

async function wan14bGraph({ prompt, imageUrl, aspectRatio, duration }) {
  const e = (await detectVideoEngines()).wan14b;
  const [width, height] = WAN14B_DIMS[aspectRatio] || WAN14B_DIMS['16:9'];
  const fps = 16;
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
    98: { class_type: 'WanImageToVideo', inputs: { positive: ['93', 0], negative: ['89', 0], vae: ['90', 0], start_image: ['97', 0], width, height, length: framesPour(duration, fps), batch_size: 1 } },
    86: {
      class_type: 'KSamplerAdvanced',
      inputs: { model: ['104', 0], positive: ['98', 0], negative: ['98', 1], latent_image: ['98', 2], add_noise: 'enable', noise_seed: seed(), steps, cfg, sampler_name: 'euler', scheduler: 'simple', start_at_step: 0, end_at_step: switchAt, return_with_leftover_noise: 'enable' },
    },
    85: {
      class_type: 'KSamplerAdvanced',
      inputs: { model: ['103', 0], positive: ['98', 0], negative: ['98', 1], latent_image: ['86', 0], add_noise: 'disable', noise_seed: 0, steps, cfg, sampler_name: 'euler', scheduler: 'simple', start_at_step: switchAt, end_at_step: steps, return_with_leftover_noise: 'disable' },
    },
    87: { class_type: 'VAEDecode', inputs: { samples: ['85', 0], vae: ['90', 0] } },
    94: { class_type: 'CreateVideo', inputs: { images: ['87', 0], fps } },
    108: { class_type: 'SaveVideo', inputs: { video: ['94', 0], filename_prefix: prefixe('keou-video/keou'), format: 'auto', codec: 'auto' } },
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
    79: { class_type: 'SaveVideo', inputs: { video: ['78', 0], filename_prefix: prefixe('keou-video/keou'), format: 'auto', codec: 'auto' } },
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

export async function generateVideo(_apiKey, { prompt, imageUrl, aspectRatio, duration }) {
  const engines = await detectVideoEngines();
  const engine = pickVideoEngine(engines, !!imageUrl);
  if (!engine) {
    throw new Error(
      'Local engine: no video model installed. Best quality — LTX-2.3 22B '
      + '(checkpoints/ltx-2.3-22b-dev-fp8.safetensors + text_encoders/gemma_3_12B_it_fp8_e4m3fn.safetensors '
      + '+ latent_upscale_models/ltx-2.3-spatial-upscaler-x2-1.1.safetensors — ~42 GB, needs ~30 GB VRAM and '
      + 'ComfyUI >= Sept 2026 for the LTX 2.x nodes). Lighter — Wan 2.2 5B '
      + '(diffusion_models/wan2.2_ti2v_5B_fp16.safetensors + text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors '
      + '+ vae/wan2.2_vae.safetensors — ~17 GB, 8 GB VRAM). Or use a cloud provider key for video.'
    );
  }
  const params = { prompt, imageUrl, aspectRatio: aspectRatio || '16:9', duration };
  const graph = engine === 'ltx23' ? await ltx23Graph(params)
    : engine === 'wan5b' ? await wan5bGraph(params)
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

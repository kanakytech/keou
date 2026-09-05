/**
 * Test d'intégration du moteur local (providers/comfy.js) contre un STUB
 * ComfyUI — pas d'instance réelle requise, donc exécutable en CI.
 *
 * Le stub émule les 5 endpoints que l'adaptateur utilise : /object_info,
 * /prompt, /history/{id}, /upload/image, /view. On vérifie le contrat
 * provider de bout en bout : soumission → sondage → resultUrl, l'upload des
 * images source, les refus nets (vidéo/tts/sfx), et le coût nul.
 */

import http from 'node:http';
import assert from 'node:assert';

const PORT = 3498;
let promptCount = 0;
const submitted = {}; // prompt_id → graph

const stub = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };

  if (url.pathname === '/object_info/CheckpointLoaderSimple') {
    return send(200, { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['flux1-schnell-fp8.safetensors', 'sdxl-base.safetensors']] } } } });
  }
  if (url.pathname === '/object_info/UpscaleModelLoader') {
    return send(200, { UpscaleModelLoader: { input: { required: { model_name: [['RealESRGAN_x4plus.pth']] } } } });
  }
  // Modèles vidéo — pilotés par le test (globalThis.STUB_VIDEO) pour vérifier
  // le refus SANS modèles puis le graphe AVEC.
  if (url.pathname === '/object_info/UNETLoader') {
    return send(200, { UNETLoader: { input: { required: { unet_name: [globalThis.STUB_VIDEO ? [ 'wan2.2_ti2v_5B_fp16.safetensors' ] : []] } } } });
  }
  if (url.pathname === '/object_info/CLIPLoader') {
    return send(200, { CLIPLoader: { input: { required: { clip_name: [globalThis.STUB_VIDEO ? ['umt5_xxl_fp8_e4m3fn_scaled.safetensors'] : []] } } } });
  }
  if (url.pathname === '/object_info/VAELoader') {
    return send(200, { VAELoader: { input: { required: { vae_name: [globalThis.STUB_VIDEO ? ['wan2.2_vae.safetensors'] : []] } } } });
  }
  if (url.pathname === '/object_info/LoraLoaderModelOnly') {
    return send(200, { LoraLoaderModelOnly: { input: { required: { lora_name: [[]] } } } });
  }
  if (url.pathname === '/object_info/SaveVideo') {
    return send(200, globalThis.STUB_VIDEO ? { SaveVideo: { input: { required: {} } } } : {});
  }
  if (url.pathname === '/upload/image' && req.method === 'POST') {
    return send(200, { name: 'keou-input-test.png', subfolder: '', type: 'input' });
  }
  if (url.pathname === '/prompt' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { prompt } = JSON.parse(body);
      promptCount += 1;
      const id = `stub-${promptCount}`;
      submitted[id] = prompt;
      send(200, { prompt_id: id, number: promptCount });
    });
    return;
  }
  if (url.pathname.startsWith('/history/')) {
    const id = url.pathname.split('/').pop();
    if (id === 'stub-pending') return send(200, {});
    if (id === 'stub-error') {
      return send(200, { [id]: { status: { status_str: 'error', completed: false, messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] }, outputs: {} } });
    }
    if (id === 'stub-video') {
      // SaveVideo range le mp4 sous `images` avec le flag `animated` — vérifié
      // dans PreviewVideo.as_dict() du code ComfyUI.
      return send(200, { [id]: { status: { status_str: 'success', completed: true }, outputs: { 58: { images: [{ filename: 'keou_00001_.mp4', subfolder: 'keou-video', type: 'output' }], animated: [true] } } } });
    }
    return send(200, { [id]: { status: { status_str: 'success', completed: true }, outputs: { 7: { images: [{ filename: 'keou_00001_.png', subfolder: '', type: 'output' }] } } } });
  }
  if (url.pathname === '/fake-source.png') {
    return send(200, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png');
  }
  send(404, { error: 'not found' });
});

await new Promise((r) => stub.listen(PORT, r));

// L'env DOIT être posé avant l'import : config.js lit au chargement.
process.env.LOCAL_ENGINE_URL = `http://localhost:${PORT}`;
const comfy = await import('../src/lib/providers/comfy.js');

let failures = 0;
const ok = (label) => console.log(`  ✓ ${label}`);
const ko = (label, err) => { failures += 1; console.error(`  ✗ ${label} — ${err.message}`); };

// 1. texte → image
try {
  const t = await comfy.textToImage('', { prompt: 'a bottle on a beach', aspectRatio: '3:4' });
  assert.ok(t.taskId.startsWith('stub-'), 'taskId manquant');
  const graph = submitted[t.taskId];
  // Un checkpoint FLUX passe par le graphe FLUX, pas par celui de SDXL : le
  // latent doit être un EmptySD3LatentImage (16 canaux). EmptyLatentImage en
  // fabrique un de 4 — ce que le test exigeait avant, et qu'aucun modèle FLUX
  // ne peut décoder. La structure était vérifiée, l'exécution jamais.
  assert.equal(graph[1].inputs.ckpt_name, 'flux1-schnell-fp8.safetensors');
  assert.equal(graph[3].class_type, 'EmptySD3LatentImage', 'FLUX veut un latent SD3');
  assert.equal(graph[3].inputs.width, 896);
  assert.equal(graph[3].inputs.height, 1152);
  assert.equal(graph[2].class_type, 'ModelSamplingFlux', 'décalage de bruit FLUX absent');
  assert.equal(graph[5].class_type, 'FluxGuidance', 'guidage distillé FLUX absent');
  assert.equal(graph[7].inputs.steps, 4, 'schnell doit tourner en 4 pas');
  assert.equal(graph[7].inputs.cfg, 1, 'FLUX est distillé : cfg 1');
  ok('textToImage : graphe FLUX correct (latent SD3, dims, 4 pas pour schnell)');
} catch (e) { ko('textToImage', e); }

// 2. image de référence → img2img avec upload
try {
  const t = await comfy.generateImage('', { prompt: 'studio scene', imageUrls: [`http://localhost:${PORT}/fake-source.png`], aspectRatio: '1:1' });
  const graph = submitted[t.taskId];
  assert.equal(graph[8].class_type, 'LoadImage');
  assert.equal(graph[8].inputs.image, 'keou-input-test.png');
  assert.equal(graph[5].inputs.denoise, 0.45, 'denoise produit verrouillé');
  ok('generateImage(ref) : upload + img2img denoise 0.45');
} catch (e) { ko('generateImage(ref)', e); }

// 3. upscale
try {
  const t = await comfy.upscaleImage('', { imageUrl: `http://localhost:${PORT}/fake-source.png` });
  const graph = submitted[t.taskId];
  assert.equal(graph[2].inputs.model_name, 'RealESRGAN_x4plus.pth');
  assert.equal(graph[3].class_type, 'ImageUpscaleWithModel');
  ok('upscaleImage : graphe upscale avec modèle auto-détecté');
} catch (e) { ko('upscaleImage', e); }

// 4. sondage — les trois états
try {
  const done = await comfy.pollTask('', { taskId: 'stub-1' });
  assert.equal(done.status, 'completed');
  assert.ok(done.resultUrl.includes('/view?filename=keou_00001_.png'), 'resultUrl /view attendu');
  const pending = await comfy.pollTask('', { taskId: 'stub-pending' });
  assert.equal(pending.status, 'processing');
  const failed = await comfy.pollTask('', { taskId: 'stub-error' });
  assert.equal(failed.status, 'failed');
  assert.ok(failed.error.includes('CUDA out of memory'), 'le message ComfyUI doit remonter');
  ok('pollTask : completed / processing / failed avec message');
} catch (e) { ko('pollTask', e); }

// 5. vidéo SANS modèles : refus actionnable ; tts toujours refusé ; coût nul
try {
  globalThis.STUB_VIDEO = false;
  comfy.clearModelCache();
  await assert.rejects(() => comfy.generateVideo('', { prompt: 'x' }), /no video model installed/);
  await assert.rejects(() => comfy.tts('', {}), /cloud provider/);
  assert.equal(comfy.calculateCost('image'), 0);
  assert.equal(comfy.calculateCost('video'), 0);
  ok('vidéo sans modèles refusée avec instructions, tts refusé, coût nul');
} catch (e) { ko('refus/coût', e); }

// 6. vidéo AVEC Wan 5B : graphe complet t2v et i2v
try {
  globalThis.STUB_VIDEO = true;
  comfy.clearModelCache();
  const t = await comfy.generateVideo('', { prompt: 'slow dolly-in on the bottle', aspectRatio: '9:16' });
  const graph = submitted[t.taskId];
  assert.equal(graph[37].inputs.unet_name, 'wan2.2_ti2v_5B_fp16.safetensors');
  assert.equal(graph[55].class_type, 'Wan22ImageToVideoLatent');
  assert.equal(graph[55].inputs.width, 704);
  assert.equal(graph[55].inputs.height, 1280);
  assert.equal(graph[55].inputs.length, 121);
  assert.equal(graph[58].class_type, 'SaveVideo');
  assert.ok(!graph[56], 't2v ne doit pas charger d\'image');
  const t2 = await comfy.generateVideo('', { prompt: 'x', imageUrl: `http://localhost:${PORT}/fake-source.png`, aspectRatio: '16:9' });
  const g2 = submitted[t2.taskId];
  assert.equal(g2[56].class_type, 'LoadImage');
  assert.deepEqual(g2[55].inputs.start_image, ['56', 0]);
  ok('generateVideo local : graphe Wan 5B t2v + i2v corrects');
} catch (e) { ko('generateVideo', e); }

// 7. sondage vidéo : le mp4 sous `images`+`animated` remonte en resultUrl
try {
  const done = await comfy.pollTask('', { taskId: 'stub-video' });
  assert.equal(done.status, 'completed');
  assert.ok(done.resultUrl.includes('keou_00001_.mp4'), `resultUrl mp4 attendu, reçu ${done.resultUrl}`);
  assert.ok(done.resultUrl.includes('subfolder=keou-video'), 'le subfolder vidéo doit être conservé');
  ok('pollTask vidéo : mp4 récupéré via /view');
} catch (e) { ko('pollTask vidéo', e); }

// 6. le routeur retourne le provider local quand configuré
try {
  process.env.DEFAULT_PROVIDER = 'local';
  const { getProvider, getProviderApiKey } = await import('../src/lib/providers/index.js');
  // config est déjà chargé avec LOCAL_ENGINE_URL ; defaultProvider a été lu
  // au chargement — on vérifie au minimum la résolution de clé.
  const key = await getProviderApiKey('local');
  assert.equal(key, '');
  ok('getProviderApiKey(local) → chaîne vide, pas d\'erreur');
} catch (e) { ko('routeur local', e); }

stub.close();
if (failures > 0) { console.error(`\n  ${failures} échec(s)`); process.exit(1); }
console.log('\n  local engine check passed');

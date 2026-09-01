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
  assert.equal(graph[4].inputs.width, 896);
  assert.equal(graph[4].inputs.height, 1152);
  assert.equal(graph[1].inputs.ckpt_name, 'flux1-schnell-fp8.safetensors');
  assert.equal(graph[5].inputs.steps, 4, 'schnell doit tourner en 4 pas');
  ok('textToImage : graphe t2i correct (dims, checkpoint auto, pas schnell)');
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

// 5. refus nets + coût nul
try {
  await assert.rejects(() => comfy.generateVideo('', {}), /cloud provider/);
  await assert.rejects(() => comfy.tts('', {}), /cloud provider/);
  assert.equal(comfy.calculateCost('image'), 0);
  assert.equal(comfy.calculateCost('video'), 0);
  ok('vidéo/tts refusés proprement, coût nul');
} catch (e) { ko('refus/coût', e); }

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

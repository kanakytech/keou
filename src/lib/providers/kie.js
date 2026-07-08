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
  return r.json();
}

function kieHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
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

export async function generateVideo(apiKey, { model, prompt, imageUrl, duration, resolution, mode, sound, aspectRatio, generateAudio, variant }) {
  const headers = kieHeaders(apiKey);
  let r;

  if (model === 'seedance-2') {
    r = await fetchWithTimeout(`${KIE}/createTask`, { method: 'POST', headers, body: JSON.stringify({ model: 'bytedance/seedance-2', input: { prompt, first_frame_url: imageUrl, generate_audio: generateAudio === true, resolution: resolution === '480p' ? '480p' : '720p', aspect_ratio: aspectRatio || '16:9', duration: Math.min(15, Math.max(4, Number(duration) || 10)), web_search: false } }) });
  } else if (model === 'veo3') {
    r = await fetchWithTimeout(`${VEO_BASE}/generate`, { method: 'POST', headers, body: JSON.stringify({ prompt, model: ['veo3','veo3_fast','veo3_lite'].includes(variant) ? variant : 'veo3', imageUrls: [imageUrl], generationType: 'FIRST_AND_LAST_FRAMES_2_VIDEO', aspect_ratio: aspectRatio || '16:9' }) });
  } else if (model === 'kling-3.0') {
    r = await fetchWithTimeout(`${KIE}/createTask`, { method: 'POST', headers, body: JSON.stringify({ model: 'kling-3.0/video', input: { prompt, image_urls: [imageUrl], sound: sound === true, duration: String(Math.min(15, Math.max(3, Number(duration) || 8))), aspect_ratio: aspectRatio || '16:9', mode: mode === 'std' ? 'std' : 'pro', multi_shots: false } }) });
  } else if (model === 'kling-2.6') {
    r = await fetchWithTimeout(`${KIE}/createTask`, { method: 'POST', headers, body: JSON.stringify({ model: 'kling-2.6/image-to-video', input: { prompt, image_urls: [imageUrl], sound: sound === true, duration: duration === '5' ? '5' : '10' } }) });
  } else {
    // grok-imagine (default)
    r = await fetchWithTimeout(`${KIE}/createTask`, { method: 'POST', headers, body: JSON.stringify({ model: 'grok-imagine/image-to-video', input: { image_urls: [imageUrl], index: 0, mode: mode === 'fun' ? 'fun' : 'normal', duration: String(Math.min(30, Math.max(6, Number(duration) || 10))), resolution: resolution === '480p' ? '480p' : '720p', prompt } }) });
  }

  const data = await safeJson(r);
  if (!data.data?.taskId) throw new Error('No taskId returned');
  return { taskId: data.data.taskId, recordId: data.data.recordId || null };
}

// ─── TTS (ElevenLabs) ───

export async function tts(apiKey, { text, voice, stability, similarity_boost, style, speed }) {
  const input = { text, voice: voice || 'Rachel' };
  if (stability !== undefined) input.stability = stability;
  if (similarity_boost !== undefined) input.similarity_boost = similarity_boost;
  if (style !== undefined) input.style = style;
  if (speed !== undefined) input.speed = speed;

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
  const input = { text };
  if (duration_seconds) input.duration_seconds = duration_seconds;

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
    body: JSON.stringify({ model: 'topaz/image-upscale', input: { image_url: imageUrl, upscale_factor: upscaleFactor } }),
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
    body: JSON.stringify({ model: 'topaz/video-upscale', input: { video_url: videoUrl, upscale_factor: upscaleFactor } }),
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
      if (model === 'veo3') return dur * 0.25;
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

    const data = await r.json();
    const state = data.data?.state;
    const raw = data.data?.resultJson;

    if (state === 'failed' || state === 'error' || state === 'cancelled') {
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

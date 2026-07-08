/**
 * Fal.ai Provider — Raw API calls
 *
 * Images/audio: sync via fal.run (returns result immediately)
 * Videos: async via queue.fal.run (returns request_id for polling)
 *
 * Sync results return { resultUrl, immediate: true }
 * Async results return { taskId } (request_id stored as taskId)
 */

export const name = 'fal';

const FAL_RUN = 'https://fal.run';
const FAL_QUEUE = 'https://queue.fal.run';
const FETCH_TIMEOUT = 60_000; // 60s for sync calls (image gen can take 30s+)

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || FETCH_TIMEOUT);
  try { return await fetch(url, { ...opts, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function falHeaders(apiKey) {
  return { 'Authorization': `Key ${apiKey}`, 'Content-Type': 'application/json' };
}

async function falSync(apiKey, endpoint, body) {
  const r = await fetchWithTimeout(`${FAL_RUN}/${endpoint}`, {
    method: 'POST',
    headers: falHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Fal API ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

async function falQueue(apiKey, endpoint, body) {
  const r = await fetchWithTimeout(`${FAL_QUEUE}/${endpoint}`, {
    method: 'POST',
    headers: falHeaders(apiKey),
    body: JSON.stringify(body),
    timeout: 30_000,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Fal Queue ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  if (!data.request_id) throw new Error('No request_id returned from Fal queue');
  return data.request_id;
}

// ─── Image Gen (nano-banana-pro/edit) ───

export async function generateImage(apiKey, { prompt, imageUrls, aspectRatio, outputFormat, resolution }) {
  const endpoint = 'fal-ai/nano-banana-pro/edit';
  const data = await falSync(apiKey, endpoint, {
    prompt,
    image_urls: imageUrls,
    aspect_ratio: aspectRatio || '1:1',
    output_format: outputFormat || 'png',
    resolution: resolution || '2K',
    num_images: 1,
    safety_tolerance: '4',
  });

  const url = data.images?.[0]?.url;
  if (!url) throw new Error('Fal image generation failed — no result URL');
  return { resultUrl: url, immediate: true, falEndpoint: endpoint };
}

// ─── Polish (flux-2-pro/edit) ───

export async function polish(apiKey, { prompt, imageUrl, aspectRatio }) {
  const endpoint = 'fal-ai/flux-2-pro/edit';
  // Map KIE aspect ratios to Fal image_size
  const imageSize = mapRatioToFalSize(aspectRatio);

  const data = await falSync(apiKey, endpoint, {
    prompt,
    image_urls: [imageUrl],
    image_size: imageSize,
    output_format: 'png',
    safety_tolerance: '2',
  });

  const url = data.images?.[0]?.url;
  if (!url) throw new Error('Fal polish failed — no result URL');
  return { resultUrl: url, immediate: true, falEndpoint: endpoint };
}

// ─── Remix (flux-2-pro/edit with custom prompt) ───

export async function remix(apiKey, { prompt, imageUrl, aspectRatio }) {
  // Same endpoint as polish, different prompt
  return polish(apiKey, { prompt, imageUrl, aspectRatio });
}

// ─── Adapt Format (nano-banana-pro/edit with ratio change) ───

export async function adapt(apiKey, { prompt, imageUrl, aspectRatio }) {
  const endpoint = 'fal-ai/nano-banana-pro/edit';
  const data = await falSync(apiKey, endpoint, {
    prompt,
    image_urls: [imageUrl],
    aspect_ratio: aspectRatio,
    output_format: 'png',
    resolution: '2K',
    num_images: 1,
    safety_tolerance: '4',
  });

  const url = data.images?.[0]?.url;
  if (!url) throw new Error('Fal adapt failed — no result URL');
  return { resultUrl: url, immediate: true, falEndpoint: endpoint };
}

// ─── Video Gen (multi-model, always async/queue) ───

export async function generateVideo(apiKey, { model, prompt, imageUrl, duration, resolution, mode, sound, aspectRatio, generateAudio, variant }) {
  let endpoint, body;

  if (model === 'seedance-2') {
    endpoint = 'bytedance/seedance-2.0/image-to-video';
    body = {
      prompt,
      image_url: imageUrl,
      duration: [4,8,12].includes(Number(duration)) ? Number(duration) : 8,
      resolution: resolution === '480p' ? '480p' : '720p',
      aspect_ratio: aspectRatio || '16:9',
      generate_audio: generateAudio === true,
    };
  } else if (model === 'veo3') {
    endpoint = 'fal-ai/veo3';
    // Fal Veo3 = text-to-video only (no image input)
    const dur = [4,6,8].includes(Number(duration)) ? Number(duration) : 8;
    body = {
      prompt,
      resolution: resolution === '1080p' ? '1080p' : '720p',
      duration: `${dur}s`,
      aspect_ratio: aspectRatio || '16:9',
      generate_audio: generateAudio !== false,
      safety_tolerance: 4,
    };
  } else if (model === 'kling-3.0' || model === 'kling-2.6') {
    endpoint = 'fal-ai/kling-video/v2.1/standard/image-to-video';
    body = {
      prompt,
      image_url: imageUrl,
      duration: duration === '5' ? '5' : '10',
      negative_prompt: 'blur, distort, and low quality',
      cfg_scale: 0.5,
    };
  } else {
    // grok-imagine (default)
    endpoint = 'xai/grok-imagine-video/reference-to-video';
    // Fal Grok uses @Image1 reference in prompt
    const grokPrompt = prompt.includes('@Image') ? prompt : `${prompt} @Image1`;
    body = {
      prompt: grokPrompt,
      reference_image_urls: [imageUrl],
      duration: Math.min(10, Math.max(1, Number(duration) || 8)),
      aspect_ratio: aspectRatio || '16:9',
      resolution: resolution === '480p' ? '480p' : '720p',
    };
  }

  const requestId = await falQueue(apiKey, endpoint, body);
  return { taskId: requestId, falEndpoint: endpoint };
}

// ─── TTS (ElevenLabs via Fal — sync) ───

export async function tts(apiKey, { text, voice, stability, similarity_boost, style, speed }) {
  const endpoint = 'fal-ai/elevenlabs/tts/turbo-v2-5';
  const input = { text, voice: voice || 'Rachel' };
  if (stability !== undefined) input.stability = stability;
  if (similarity_boost !== undefined) input.similarity_boost = similarity_boost;
  if (style !== undefined) input.style = style;
  if (speed !== undefined) input.speed = speed;

  const data = await falSync(apiKey, endpoint, input);
  const url = data.audio?.url;
  if (!url) throw new Error('Fal TTS failed — no audio URL');
  return { resultUrl: url, immediate: true, falEndpoint: endpoint };
}

// ─── Sound Effects (ElevenLabs v2 via Fal — sync) ───

export async function sfx(apiKey, { text, duration_seconds }) {
  const endpoint = 'fal-ai/elevenlabs/sound-effects/v2';
  const input = { text };
  if (duration_seconds) input.duration_seconds = duration_seconds;
  input.prompt_influence = 0.3;

  const data = await falSync(apiKey, endpoint, input);
  const url = data.audio?.url;
  if (!url) throw new Error('Fal SFX failed — no audio URL');
  return { resultUrl: url, immediate: true, falEndpoint: endpoint };
}

// ─── Upscale Image (Topaz via Fal — sync) ───

export async function upscaleImage(apiKey, { imageUrl, upscaleFactor }) {
  const endpoint = 'fal-ai/topaz/upscale/image';
  const factor = Math.min(parseInt(upscaleFactor) || 4, 4); // Fal max = 4x

  const data = await falSync(apiKey, endpoint, {
    image_url: imageUrl,
    model: 'Standard V2',
    upscale_factor: factor,
    output_format: 'png',
    face_enhancement: true,
  });

  const url = data.image?.url;
  if (!url) throw new Error('Fal upscale failed — no result URL');
  return { resultUrl: url, immediate: true, falEndpoint: endpoint };
}

// ─── Upscale Video (Topaz via Fal — async/queue) ───

export async function upscaleVideo(apiKey, { videoUrl, upscaleFactor }) {
  const endpoint = 'fal-ai/topaz/upscale/video';
  const factor = Math.min(parseInt(upscaleFactor) || 4, 4);

  const requestId = await falQueue(apiKey, endpoint, {
    video_url: videoUrl,
    model: 'Proteus',
    upscale_factor: factor,
  });
  return { taskId: requestId, falEndpoint: endpoint };
}

// ─── Polling (Fal queue status) ───

export async function pollTask(apiKey, { taskId, metadata }) {
  let falEndpoint = '';
  try {
    const meta = typeof metadata === 'string' ? JSON.parse(metadata) : (metadata || {});
    falEndpoint = meta.falEndpoint || '';
  } catch (err) { console.error('[FAL POLL META]', err.message); }
  if (!falEndpoint) return { status: 'processing' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    // Check status
    const statusRes = await fetch(`${FAL_QUEUE}/${falEndpoint}/requests/${taskId}/status`, {
      headers: falHeaders(apiKey),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!statusRes.ok) return { status: 'processing' };

    const statusData = await statusRes.json();

    if (statusData.status === 'COMPLETED') {
      // Fetch result
      const resultRes = await fetch(`${FAL_QUEUE}/${falEndpoint}/requests/${taskId}`, {
        headers: falHeaders(apiKey),
      });
      if (!resultRes.ok) return { status: 'processing' };
      const data = await resultRes.json();
      const resultUrl = data.video?.url || data.images?.[0]?.url || data.image?.url || data.audio?.url;
      if (!resultUrl) return { status: 'processing' };
      return { status: 'completed', resultUrl };
    }

    if (statusData.status === 'FAILED') {
      return { status: 'failed', error: statusData.error || 'Fal generation failed' };
    }

    // IN_QUEUE or IN_PROGRESS
    return { status: 'processing' };
  } catch (err) {
    clearTimeout(timeout);
    return { status: 'processing' };
  }
}

// ─── Cost Calculation (per generation, based on Fal.ai pricing) ───
export function calculateCost(type, params = {}) {
  switch (type) {
    case 'image':
      return params.resolution === '4K' ? 0.30 : 0.15; // nano-banana-pro/edit
    case 'polish':
    case 'remix':
      return 0.03; // flux-2-pro/edit ~1 megapixel
    case 'adapt':
      return 0.15; // nano-banana-pro/edit
    case 'video': {
      const dur = parseInt(params.duration) || 8;
      const model = params.model || 'grok-imagine';
      if (model === 'veo3') return dur * 0.40;
      if (model === 'kling-2.6' || model === 'kling-3.0') return dur * 0.056;
      if (model === 'seedance-2') return dur * 0.06;
      return dur * 0.05; // grok-imagine default
    }
    case 'img-upscale': return 0.08;
    case 'vid-upscale': return (parseInt(params.duration) || 5) * 0.02;
    case 'tts': return Math.max(0.01, ((params.charCount || 100) / 1000) * 0.30);
    case 'sfx': return 0.10;
    default: return 0.05;
  }
}

// ─── Helpers ───

function mapRatioToFalSize(ratio) {
  const map = {
    '1:1':  'square_hd',
    '4:3':  'landscape_4_3',
    '3:4':  'portrait_4_3',
    '16:9': 'landscape_16_9',
    '9:16': 'portrait_16_9',
    '3:2':  { width: 1536, height: 1024 },
    '2:3':  { width: 1024, height: 1536 },
  };
  return map[ratio] || 'auto';
}

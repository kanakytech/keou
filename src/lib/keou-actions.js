/**
 * Keou Actions — open-source edition execution layer.
 *
 * Image and video generation only. The enterprise edition ships additional
 * tools (polish, remix, format adapt, packs, TTS, SFX, upscaling) and a
 * production-tuned prompt stack — https://keou.systems for details.
 */

import { query, queryOne } from '../db.js';
import { deductCredits, refundCredits, getQuotaRemaining } from '../utils/credits.js';
import { logActivity } from '../utils/activity.js';
import { getProvider, getProviderApiKey } from './providers/index.js';
import { persistFromUrl } from './r2.js';
import { assertSafeUrl } from '../utils/safeUrl.js';

// ─── Prompts (community edition) ───

const IMAGE_PROMPT = [
  'You are a commercial product photographer. Place the product from the reference',
  'image into a clean, professional commercial scene. The product itself is locked:',
  'keep its shape, colors, text, labels and logos exactly as in the reference —',
  'never redraw or alter the product. Only generate a realistic environment around',
  'it: natural lighting, believable surfaces, subtle depth of field. Photorealistic',
  'output, no cartoon or CGI look.',
].join(' ');

const VIDEO_PROMPT = [
  'You are a commercial video director. The product in the reference image must stay',
  'exactly as shown — identical geometry, colors, text and logos at all times. Do not',
  'rotate it, reveal unseen angles or reinterpret it. Create motion only through',
  'camera movement, lighting transitions and environment: smooth cinematic moves,',
  'realistic shadows and reflections. Polished, ad-ready result with no warping or',
  'flickering.',
].join(' ');

// ─── Helpers ───

let _defaultProjectId = null;
async function getDefaultProjectId() {
  if (_defaultProjectId) return _defaultProjectId;
  const row = await queryOne("SELECT id FROM projects WHERE name = 'General' ORDER BY id LIMIT 1");
  if (row) _defaultProjectId = row.id;
  return _defaultProjectId;
}

async function resolveEffectiveCampaignId(projectId, campaignId) {
  if (campaignId) return campaignId;
  const existing = await queryOne("SELECT id FROM campaigns WHERE project_id = $1 AND name = 'General' LIMIT 1", [projectId]);
  if (existing) return existing.id;
  const created = await queryOne(
    "INSERT INTO campaigns (project_id, name, description, color, created_by) VALUES ($1, 'General', 'Default campaign', '#6B7280', (SELECT id FROM users LIMIT 1)) ON CONFLICT (project_id, name) DO UPDATE SET name = 'General' RETURNING id",
    [projectId]
  );
  return created?.id || null;
}

/**
 * Shared idempotency check. If a row already exists for this
 * (user, idempotencyKey) and a provider task was created (task_id present)
 * or the row completed, return it so the route can short-circuit.
 */
export async function findIdempotent(userId, idempotencyKey) {
  if (!idempotencyKey) return null;
  const row = await queryOne(
    `SELECT id, task_id, record_id, status, result_url, type
       FROM generations
      WHERE user_id = $1 AND idempotency_key = $2
      LIMIT 1`,
    [userId, idempotencyKey]
  );
  if (!row) return null;
  if (row.status === 'completed' || row.task_id) return row;
  return null; // stale pending — let route retry
}

/**
 * Persist a provider result URL to R2 (if configured) and mark the generation
 * completed. Only fires for rows still pending/processing, so a concurrent
 * winner's write is preserved.
 */
export async function persistAndComplete(genId, resultUrl, type) {
  const ext = type.includes('video') || type === 'vid-upscale' ? 'mp4'
            : (type === 'tts' || type === 'sfx') ? 'mp3'
            : 'png';
  const r2Key = `results/${genId}.${ext}`;
  let finalUrl = resultUrl;
  let persistedKey = null;
  try {
    finalUrl = await persistFromUrl(resultUrl, r2Key);
    persistedKey = r2Key;
  } catch (r2Err) {
    console.error('[R2 PERSIST]', r2Err.message);
  }
  await query(
    `UPDATE generations
       SET status='completed', result_url=$1, r2_key=COALESCE($2, r2_key), completed_at=NOW()
     WHERE id=$3 AND status IN ('pending','processing')`,
    [finalUrl, persistedKey, genId]
  );
  return finalUrl;
}

/** Handle provider result: immediate or async (store taskId for polling). */
async function handleProviderResult(genId, result, providerName, type) {
  if (result.immediate && result.resultUrl) {
    await persistAndComplete(genId, result.resultUrl, type);
  } else {
    const metaUpdate = { provider: providerName };
    if (result.falEndpoint) metaUpdate.falEndpoint = result.falEndpoint;
    await query(
      `UPDATE generations SET status=$1, task_id=$2, record_id=$3,
       metadata = metadata::jsonb || $4::jsonb WHERE id=$5`,
      ['processing', result.taskId, result.recordId || null, JSON.stringify(metaUpdate), genId]
    );
  }
}

/** Debit before the provider call; mark the row failed if the debit loses a race. */
async function debitOrFail(userId, type, units, genId) {
  try {
    await deductCredits(userId, type, units, genId);
  } catch (err) {
    await query('UPDATE generations SET status = $1, error = $2 WHERE id = $3', ['failed', err.message, genId]);
    throw err;
  }
}

// ─── Actions ───

export async function executeGenerateImage(userId, { imgUrl, format, creativeDirection, projectId, campaignId, idempotencyKey }) {
  if (!imgUrl) throw new Error('Image URL required');
  assertSafeUrl(imgUrl);
  const provider = await getProvider();
  const apiKey = await getProviderApiKey(provider.name);
  const effectiveProjectId = projectId || await getDefaultProjectId();
  const effectiveCampaignId = await resolveEffectiveCampaignId(effectiveProjectId, campaignId);

  const metadata = { provider: provider.name };
  if (creativeDirection) metadata.creativeDirection = creativeDirection;

  const gen = await query(
    `INSERT INTO generations (user_id, project_id, campaign_id, type, status, input_url, format, credits_used, metadata, idempotency_key)
     VALUES ($1, $2, $3, 'image', 'pending', $4, $5, 1, $6, $7) RETURNING id`,
    [userId, effectiveProjectId, effectiveCampaignId, imgUrl, format || '1:1', JSON.stringify(metadata), idempotencyKey || null]
  );
  const genId = gen.rows[0].id;

  let finalPrompt = IMAGE_PROMPT;
  if (creativeDirection) {
    finalPrompt += ` CREATIVE DIRECTION: ${creativeDirection}. Blend it into the scene, lighting and mood — never alter the product itself.`;
  }

  // Deduct BEFORE provider call — refund on failure
  await debitOrFail(userId, 'image', 1, genId);
  try {
    const result = await provider.generateImage(apiKey, {
      prompt: finalPrompt,
      imageUrls: [imgUrl],
      aspectRatio: format || '1:1',
      outputFormat: 'png',
      resolution: '2K',
    });

    await handleProviderResult(genId, result, provider.name, 'image');

    const cost = provider.calculateCost('image', { resolution: '2K' });
    await query('UPDATE generations SET api_cost = $1 WHERE id = $2', [cost, genId]);

    logActivity(userId, 'generation', 'generation', genId, { type: 'image', provider: provider.name });

    return { taskId: result.taskId || null, recordId: result.recordId || null, generationId: genId, type: 'image' };
  } catch (err) {
    await refundCredits(userId, 'image', 1, genId);
    await query('UPDATE generations SET status = $1, error = $2 WHERE id = $3', ['failed', err.message, genId]);
    throw err;
  }
}

export async function executeGenerateVideo(userId, { imageUrl, videoModel, creativeDirection, duration, resolution, mode, sound, aspectRatio, generateAudio, variant, projectId, campaignId, idempotencyKey }) {
  if (!imageUrl) throw new Error('Image URL required');
  assertSafeUrl(imageUrl);
  const provider = await getProvider();
  const apiKey = await getProviderApiKey(provider.name);
  const model = ['grok-imagine', 'kling-2.6', 'kling-3.0', 'veo3', 'seedance-2'].includes(videoModel) ? videoModel : 'grok-imagine';
  const effectiveProjectId = projectId || await getDefaultProjectId();
  const effectiveCampaignId = await resolveEffectiveCampaignId(effectiveProjectId, campaignId);

  const metadata = { videoModel: model, provider: provider.name };
  if (creativeDirection) metadata.creativeDirection = creativeDirection;

  const gen = await query(
    `INSERT INTO generations (user_id, project_id, campaign_id, type, status, input_url, credits_used, metadata, idempotency_key)
     VALUES ($1, $2, $3, 'video', 'pending', $4, 1, $5, $6) RETURNING id`,
    [userId, effectiveProjectId, effectiveCampaignId, imageUrl, JSON.stringify(metadata), idempotencyKey || null]
  );
  const genId = gen.rows[0].id;

  let finalPrompt = VIDEO_PROMPT;
  if (creativeDirection) finalPrompt += ` CREATIVE DIRECTION: ${creativeDirection}. Apply it through camera, lighting and atmosphere while keeping the product locked.`;

  // Deduct BEFORE provider call — refund on failure
  await debitOrFail(userId, 'video', 1, genId);
  try {
    const result = await provider.generateVideo(apiKey, {
      model, prompt: finalPrompt, imageUrl, duration, resolution, mode, sound, aspectRatio, generateAudio, variant,
    });

    await handleProviderResult(genId, result, provider.name, 'video');

    const cost = provider.calculateCost('video', { model, duration });
    await query('UPDATE generations SET api_cost = $1 WHERE id = $2', [cost, genId]);

    logActivity(userId, 'generation', 'generation', genId, { type: 'video', model, provider: provider.name });

    return { taskId: result.taskId || null, recordId: result.recordId || null, generationId: genId, type: 'video' };
  } catch (err) {
    await refundCredits(userId, 'video', 1, genId);
    await query('UPDATE generations SET status = $1, error = $2 WHERE id = $3', ['failed', err.message, genId]);
    throw err;
  }
}

// ─── Enterprise-only tools ───
// These endpoints are 404-gated in this edition; the stubs exist so shared
// modules import cleanly. The full suite lives in Keou Enterprise.

const enterpriseOnly = (name) => async () => {
  throw new Error(`${name} is part of Keou Enterprise — see https://keou.systems`);
};

export const executePolish = enterpriseOnly('Polish');
export const executeRemix = enterpriseOnly('Remix');
export const executeAdapt = enterpriseOnly('Format adapt');
export const executeTts = enterpriseOnly('Text-to-speech');
export const executeSfx = enterpriseOnly('Sound effects');
export const executeImageUpscale = enterpriseOnly('Image upscale');
export const executeVideoUpscale = enterpriseOnly('Video upscale');

// ─── Compat exports ───

export async function getApiKey() {
  const prov = await getProvider();
  return getProviderApiKey(prov.name);
}

export async function getCreditsInfo() {
  const remaining = await getQuotaRemaining();
  return { imageCredits: remaining.imageCredits, videoCredits: remaining.videoCredits };
}

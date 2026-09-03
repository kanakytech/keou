/**
 * Keou Actions — Internal execution layer for Jarvis mode
 *
 * Orchestrator: handles validation, DB, credits, logging.
 * Delegates API calls to the active provider (KIE or Fal).
 */

import { config } from '../config.js';
import { isCommunity } from '../middleware/edition.js';
import { query, queryOne, queryAll } from '../db.js';
import { deductCredits, refundCredits, getQuotaRemaining, billingMode } from '../utils/credits.js';
import { creditCost } from './pricing.js';
import { logActivity } from '../utils/activity.js';
import { getProvider, getProviderApiKey } from './providers/index.js';
import { persistFromUrl } from './r2.js';
import { assertSafeUrl } from '../utils/safeUrl.js';
import { IMAGE_PROMPT, VIDEO_PROMPT, POLISH_PROMPT, ADAPT_PROMPT, buildImagePrompt } from './studio-prompts.js';

/**
 * Units to bill for an action.
 * quota mode  : 1 unit per image/video generation, tools are free (legacy).
 * credits mode: Keou credit price from pricing.js — tools are billed too.
 */
function billedUnits(type, params = {}) {
  if (billingMode() === 'credits') return creditCost(type, params);
  return ['image', 'polish', 'remix', 'adapt', 'video'].includes(type) ? 1 : 0;
}

/**
 * Debit before the provider call. The generation row already exists, so if
 * the atomic debit loses a balance race we mark the row failed instead of
 * leaving it pending forever, then rethrow for the route's error mapping.
 */
async function debitOrFail(userId, type, units, genId) {
  try {
    await deductCredits(userId, type, units, genId);
  } catch (err) {
    await query('UPDATE generations SET status = $1, error = $2 WHERE id = $3', ['failed', err.message, genId]);
    throw err;
  }
}

// ─── Prompts ───
// Moved to src/lib/studio-prompts.js so the anonymous studio (essai pipeline)
// uses the exact same director's briefs. Imported at the top of this file.

// ─── Helpers ───

let _defaultProjectId = null;
async function getDefaultProjectId() {
  if (_defaultProjectId) return _defaultProjectId;
  const row = await queryOne("SELECT id FROM projects WHERE name = 'General' ORDER BY id LIMIT 1");
  if (row) _defaultProjectId = row.id;
  return _defaultProjectId;
}

// Community edition: workspaces are per-account. A caller may only attach
// work to a project they created; anything else (including no project at
// all) lands in their own "My workspace" project, created on first use.
// Enterprise/opensource keep the shared-agency behavior unchanged.
const _personalProjectIds = new Map();
async function resolveOwnedProjectId(userId, projectId) {
  if (!isCommunity()) return projectId || await getDefaultProjectId();

  if (projectId) {
    const p = await queryOne('SELECT created_by FROM projects WHERE id = $1', [projectId]);
    if (p && p.created_by === userId) return projectId;
  }
  if (_personalProjectIds.has(userId)) return _personalProjectIds.get(userId);
  let row = await queryOne(
    "SELECT id FROM projects WHERE created_by = $1 AND name = 'My workspace' ORDER BY id LIMIT 1",
    [userId]
  );
  if (!row) {
    row = await queryOne(
      `INSERT INTO projects (name, description, color, created_by)
       VALUES ('My workspace', 'Default workspace', '#0A0A0A', $1) RETURNING id`,
      [userId]
    );
  }
  _personalProjectIds.set(userId, row.id);
  return row.id;
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
 * Shared idempotency check for all creative-tool routes.
 * If a row already exists for this (user, idempotencyKey) AND a provider task
 * was successfully created (task_id present) OR the row is already completed,
 * return the existing record so the route can short-circuit. Otherwise null.
 *
 * Rows where task_id is still null (first attempt died before KIE response)
 * are treated as stale — we return null so the route can proceed with a fresh
 * insert, and the 23505 unique-violation handler in the route catches any race.
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
 * Persist a provider result URL to R2 and mark the generation completed.
 * Safe to call from any worker (client poll, server poller, sync handler):
 * the UPDATE only fires for rows still in pending/processing state, so a
 * concurrent winner's write is preserved.
 *
 * @param {number} genId
 * @param {string} resultUrl - Raw provider URL (KIE temp, Fal output)
 * @param {string} type - generation type (image/video/polish/…)
 * @returns {Promise<string>} final URL written to DB (R2 if persist succeeded, else raw)
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
  // Only update if still pending/processing — preserves a concurrent winner's data
  await query(
    `UPDATE generations
       SET status='completed', result_url=$1, r2_key=COALESCE($2, r2_key), completed_at=NOW()
     WHERE id=$3 AND status IN ('pending','processing')`,
    [finalUrl, persistedKey, genId]
  );
  return finalUrl;
}

/**
 * Handle provider result: immediate (Fal sync) or async (KIE / Fal queue)
 * Updates DB accordingly and optionally persists to R2.
 */
async function handleProviderResult(genId, result, providerName, type) {
  if (result.immediate && result.resultUrl) {
    await persistAndComplete(genId, result.resultUrl, type);
  } else {
    // Async — store taskId for polling, include provider info in metadata
    const metaUpdate = { provider: providerName };
    if (result.falEndpoint) metaUpdate.falEndpoint = result.falEndpoint;

    await query(
      `UPDATE generations SET status=$1, task_id=$2, record_id=$3,
       metadata = metadata::jsonb || $4::jsonb WHERE id=$5`,
      ['processing', result.taskId, result.recordId || null, JSON.stringify(metaUpdate), genId]
    );
  }
}

// ─── Actions ───

export async function executeGenerateImage(userId, { imgUrl, format, creativeDirection, projectId, campaignId, idempotencyKey }) {
  if (!imgUrl) throw new Error('Image URL required');
  assertSafeUrl(imgUrl);
  const provider = await getProvider();
  const apiKey = await getProviderApiKey(provider.name);
  const effectiveProjectId = await resolveOwnedProjectId(userId, projectId);
  const effectiveCampaignId = await resolveEffectiveCampaignId(effectiveProjectId, campaignId);

  const metadata = { provider: provider.name };
  if (creativeDirection) metadata.creativeDirection = creativeDirection;

  const gen = await query(
    `INSERT INTO generations (user_id, project_id, campaign_id, type, status, input_url, format, credits_used, metadata, idempotency_key)
     VALUES ($1, $2, $3, 'image', 'pending', $4, $5, 1, $6, $7) RETURNING id`,
    [userId, effectiveProjectId, effectiveCampaignId, imgUrl, format || '1:1', JSON.stringify(metadata), idempotencyKey || null]
  );
  const genId = gen.rows[0].id;

  const finalPrompt = buildImagePrompt(creativeDirection);

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

    // Calculate and store real API cost
    const cost = provider.calculateCost('image', { resolution: '2K' });
    await query('UPDATE generations SET api_cost = $1 WHERE id = $2', [cost, genId]);

    logActivity(userId, 'generation', 'generation', genId, { type: 'image', source: 'jarvis', provider: provider.name });

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
  const model = ['grok-imagine', 'kling-2.6', 'kling-3.0', 'veo3', 'seedance-2', 'wan-3.0', 'seedance-2.5', 'kling-o3'].includes(videoModel) ? videoModel : 'grok-imagine';
  const effectiveProjectId = await resolveOwnedProjectId(userId, projectId);
  const effectiveCampaignId = await resolveEffectiveCampaignId(effectiveProjectId, campaignId);

  const metadata = { videoModel: model, provider: provider.name };
  if (creativeDirection) metadata.creativeDirection = creativeDirection;
  const units = billedUnits('video', { model, duration });

  const gen = await query(
    `INSERT INTO generations (user_id, project_id, campaign_id, type, status, input_url, credits_used, metadata, idempotency_key)
     VALUES ($1, $2, $3, 'video', 'pending', $4, $5, $6, $7) RETURNING id`,
    [userId, effectiveProjectId, effectiveCampaignId, imageUrl, units, JSON.stringify(metadata), idempotencyKey || null]
  );
  const genId = gen.rows[0].id;

  let finalPrompt = VIDEO_PROMPT;
  if (creativeDirection) finalPrompt += ` ADDITIONAL CREATIVE DIRECTION: ${creativeDirection}. Integrate this into camera, lighting, atmosphere while keeping product locked.`;

  // Deduct BEFORE provider call — refund on failure
  await debitOrFail(userId, 'video', units, genId);
  try {
    const result = await provider.generateVideo(apiKey, {
      model, prompt: finalPrompt, imageUrl, duration, resolution, mode, sound, aspectRatio, generateAudio, variant,
    });

    await handleProviderResult(genId, result, provider.name, 'video');

    // Calculate and store real API cost
    const cost = provider.calculateCost('video', { model, duration });
    await query('UPDATE generations SET api_cost = $1 WHERE id = $2', [cost, genId]);

    logActivity(userId, 'generation', 'generation', genId, { type: 'video', model, source: 'jarvis', provider: provider.name });

    return { taskId: result.taskId || null, recordId: result.recordId || null, generationId: genId, type: 'video' };
  } catch (err) {
    if (units > 0) await refundCredits(userId, 'video', units, genId);
    await query('UPDATE generations SET status = $1, error = $2 WHERE id = $3', ['failed', err.message, genId]);
    throw err;
  }
}

export async function executePolish(userId, { imageUrl, ratio, projectId, campaignId, idempotencyKey }) {
  if (!imageUrl) throw new Error('Image URL required');
  assertSafeUrl(imageUrl);
  const provider = await getProvider();
  const apiKey = await getProviderApiKey(provider.name);
  const effectiveProjectId = await resolveOwnedProjectId(userId, projectId);
  const effectiveCampaignId = await resolveEffectiveCampaignId(effectiveProjectId, campaignId);

  const gen = await query(
    `INSERT INTO generations (user_id, project_id, campaign_id, type, status, input_url, format, credits_used, metadata, idempotency_key)
     VALUES ($1, $2, $3, 'polish', 'pending', $4, $5, 1, $6, $7) RETURNING id`,
    [userId, effectiveProjectId, effectiveCampaignId, imageUrl, ratio || '1:1', JSON.stringify({ provider: provider.name }), idempotencyKey || null]
  );
  const genId = gen.rows[0].id;

  // Deduct BEFORE provider call — refund on failure
  await debitOrFail(userId, 'image', 1, genId);
  try {
    const result = await provider.polish(apiKey, { prompt: POLISH_PROMPT, imageUrl, aspectRatio: ratio || '1:1', resolution: '2K' });
    await handleProviderResult(genId, result, provider.name, 'polish');

    // Calculate and store real API cost
    const cost = provider.calculateCost('polish', {});
    await query('UPDATE generations SET api_cost = $1 WHERE id = $2', [cost, genId]);

    return { taskId: result.taskId || null, recordId: result.recordId || null, generationId: genId, type: 'polish' };
  } catch (err) {
    await refundCredits(userId, 'image', 1, genId);
    await query('UPDATE generations SET status = $1, error = $2 WHERE id = $3', ['failed', err.message, genId]);
    throw err;
  }
}

export async function executeRemix(userId, { imageUrl, remixPrompt, ratio, projectId, campaignId, idempotencyKey }) {
  if (!imageUrl) throw new Error('Image URL required');
  assertSafeUrl(imageUrl);
  if (!remixPrompt) throw new Error('Remix prompt required');
  const provider = await getProvider();
  const apiKey = await getProviderApiKey(provider.name);
  const effectiveProjectId = await resolveOwnedProjectId(userId, projectId);
  const effectiveCampaignId = await resolveEffectiveCampaignId(effectiveProjectId, campaignId);

  const gen = await query(
    `INSERT INTO generations (user_id, project_id, campaign_id, type, status, input_url, format, credits_used, metadata, idempotency_key)
     VALUES ($1, $2, $3, 'image', 'pending', $4, $5, 1, $6, $7) RETURNING id`,
    [userId, effectiveProjectId, effectiveCampaignId, imageUrl, ratio || '1:1', JSON.stringify({ remixPrompt, provider: provider.name }), idempotencyKey || null]
  );
  const genId = gen.rows[0].id;

  // Deduct BEFORE provider call — refund on failure
  await debitOrFail(userId, 'image', 1, genId);
  try {
    const result = await provider.remix(apiKey, { prompt: remixPrompt, imageUrl, aspectRatio: ratio || '1:1', resolution: '2K' });
    await handleProviderResult(genId, result, provider.name, 'image');

    // Calculate and store real API cost
    const cost = provider.calculateCost('remix', {});
    await query('UPDATE generations SET api_cost = $1 WHERE id = $2', [cost, genId]);

    return { taskId: result.taskId || null, recordId: result.recordId || null, generationId: genId, type: 'remix' };
  } catch (err) {
    await refundCredits(userId, 'image', 1, genId);
    await query('UPDATE generations SET status = $1, error = $2 WHERE id = $3', ['failed', err.message, genId]);
    throw err;
  }
}

export async function executeAdapt(userId, { imageUrl, ratio, projectId, campaignId, idempotencyKey }) {
  if (!imageUrl) throw new Error('Image URL required');
  assertSafeUrl(imageUrl);
  if (!ratio) throw new Error('Target ratio required');
  const provider = await getProvider();
  const apiKey = await getProviderApiKey(provider.name);
  const effectiveProjectId = await resolveOwnedProjectId(userId, projectId);
  const effectiveCampaignId = await resolveEffectiveCampaignId(effectiveProjectId, campaignId);

  const gen = await query(
    `INSERT INTO generations (user_id, project_id, campaign_id, type, status, input_url, format, credits_used, metadata, idempotency_key)
     VALUES ($1, $2, $3, 'image', 'pending', $4, $5, 1, $6, $7) RETURNING id`,
    [userId, effectiveProjectId, effectiveCampaignId, imageUrl, ratio, JSON.stringify({ adaptedFrom: 'original', targetRatio: ratio, provider: provider.name }), idempotencyKey || null]
  );
  const genId = gen.rows[0].id;

  // Deduct BEFORE provider call — refund on failure
  await debitOrFail(userId, 'image', 1, genId);
  try {
    const result = await provider.adapt(apiKey, { prompt: ADAPT_PROMPT, imageUrl, aspectRatio: ratio });
    await handleProviderResult(genId, result, provider.name, 'image');

    // Calculate and store real API cost
    const cost = provider.calculateCost('adapt', {});
    await query('UPDATE generations SET api_cost = $1 WHERE id = $2', [cost, genId]);

    return { taskId: result.taskId || null, recordId: result.recordId || null, generationId: genId, type: 'adapt' };
  } catch (err) {
    await refundCredits(userId, 'image', 1, genId);
    await query('UPDATE generations SET status = $1, error = $2 WHERE id = $3', ['failed', err.message, genId]);
    throw err;
  }
}

export async function executeTts(userId, { text, voice, stability, similarity_boost, style, speed, projectId, campaignId, idempotencyKey }) {
  if (!text) throw new Error('Text required');
  const provider = await getProvider();
  const apiKey = await getProviderApiKey(provider.name);
  const effectiveProjectId = await resolveOwnedProjectId(userId, projectId);
  const effectiveCampaignId = await resolveEffectiveCampaignId(effectiveProjectId, campaignId);

  const units = billedUnits('tts');
  const gen = await query(
    `INSERT INTO generations (user_id, project_id, campaign_id, type, status, credits_used, metadata, idempotency_key)
     VALUES ($1, $2, $3, 'tts', 'pending', $4, $5, $6) RETURNING id`,
    [userId, effectiveProjectId, effectiveCampaignId, units, JSON.stringify({ toolType: 'tts', voice: voice || 'Rachel', charCount: text.length, provider: provider.name }), idempotencyKey || null]
  );
  const genId = gen.rows[0].id;

  if (units > 0) await debitOrFail(userId, 'tts', units, genId);
  try {
    const result = await provider.tts(apiKey, { text, voice, stability, similarity_boost, style, speed });
    await handleProviderResult(genId, result, provider.name, 'tts');

    // Calculate and store real API cost
    const cost = provider.calculateCost('tts', { charCount: text.length });
    await query('UPDATE generations SET api_cost = $1 WHERE id = $2', [cost, genId]);

    logActivity(userId, 'tool_use', 'generation', genId, { tool: 'tts', voice, provider: provider.name });

    return { taskId: result.taskId || null, recordId: result.recordId || null, generationId: genId, type: 'tts' };
  } catch (err) {
    if (units > 0) await refundCredits(userId, 'tts', units, genId);
    await query('UPDATE generations SET status = $1, error = $2 WHERE id = $3', ['failed', err.message, genId]);
    throw err;
  }
}

export async function executeSfx(userId, { text, duration_seconds, projectId, campaignId, idempotencyKey }) {
  if (!text) throw new Error('Sound description required');
  const provider = await getProvider();
  const apiKey = await getProviderApiKey(provider.name);
  const effectiveProjectId = await resolveOwnedProjectId(userId, projectId);
  const effectiveCampaignId = await resolveEffectiveCampaignId(effectiveProjectId, campaignId);

  const units = billedUnits('sfx');
  const gen = await query(
    `INSERT INTO generations (user_id, project_id, campaign_id, type, status, credits_used, metadata, idempotency_key)
     VALUES ($1, $2, $3, 'sfx', 'pending', $4, $5, $6) RETURNING id`,
    [userId, effectiveProjectId, effectiveCampaignId, units, JSON.stringify({ toolType: 'sfx', provider: provider.name }), idempotencyKey || null]
  );
  const genId = gen.rows[0].id;

  if (units > 0) await debitOrFail(userId, 'sfx', units, genId);
  try {
    const result = await provider.sfx(apiKey, { text, duration_seconds });
    await handleProviderResult(genId, result, provider.name, 'sfx');

    // Calculate and store real API cost
    const cost = provider.calculateCost('sfx', {});
    await query('UPDATE generations SET api_cost = $1 WHERE id = $2', [cost, genId]);

    logActivity(userId, 'tool_use', 'generation', genId, { tool: 'sfx', provider: provider.name });

    return { taskId: result.taskId || null, recordId: result.recordId || null, generationId: genId, type: 'sfx' };
  } catch (err) {
    if (units > 0) await refundCredits(userId, 'sfx', units, genId);
    await query('UPDATE generations SET status = $1, error = $2 WHERE id = $3', ['failed', err.message, genId]);
    throw err;
  }
}

export async function executeImageUpscale(userId, { imageUrl, upscaleFactor, projectId, campaignId, idempotencyKey }) {
  if (!imageUrl) throw new Error('Image URL required');
  assertSafeUrl(imageUrl);
  const provider = await getProvider();
  const apiKey = await getProviderApiKey(provider.name);
  const effectiveProjectId = await resolveOwnedProjectId(userId, projectId);
  const effectiveCampaignId = await resolveEffectiveCampaignId(effectiveProjectId, campaignId);
  const factor = upscaleFactor === '8' ? '8' : '4';

  const units = billedUnits('img-upscale');
  const gen = await query(
    `INSERT INTO generations (user_id, project_id, campaign_id, type, status, input_url, credits_used, metadata, idempotency_key)
     VALUES ($1, $2, $3, 'img-upscale', 'pending', $4, $5, $6, $7) RETURNING id`,
    [userId, effectiveProjectId, effectiveCampaignId, imageUrl, units, JSON.stringify({ toolType: 'img-upscale', factor, provider: provider.name }), idempotencyKey || null]
  );
  const genId = gen.rows[0].id;

  if (units > 0) await debitOrFail(userId, 'img-upscale', units, genId);
  try {
    const result = await provider.upscaleImage(apiKey, { imageUrl, upscaleFactor: factor });
    await handleProviderResult(genId, result, provider.name, 'img-upscale');

    // Calculate and store real API cost
    const cost = provider.calculateCost('img-upscale', {});
    await query('UPDATE generations SET api_cost = $1 WHERE id = $2', [cost, genId]);

    logActivity(userId, 'tool_use', 'generation', genId, { tool: 'image-upscale', factor, provider: provider.name });

    return { taskId: result.taskId || null, recordId: result.recordId || null, generationId: genId, type: 'img-upscale' };
  } catch (err) {
    if (units > 0) await refundCredits(userId, 'img-upscale', units, genId);
    await query('UPDATE generations SET status = $1, error = $2 WHERE id = $3', ['failed', err.message, genId]);
    throw err;
  }
}

export async function executeVideoUpscale(userId, { videoUrl, upscaleFactor, projectId, campaignId, idempotencyKey }) {
  if (!videoUrl) throw new Error('Video URL required');
  assertSafeUrl(videoUrl);
  const provider = await getProvider();
  const apiKey = await getProviderApiKey(provider.name);
  const effectiveProjectId = await resolveOwnedProjectId(userId, projectId);
  const effectiveCampaignId = await resolveEffectiveCampaignId(effectiveProjectId, campaignId);
  const factor = upscaleFactor === '2' ? '2' : '4';

  const units = billedUnits('vid-upscale');
  const gen = await query(
    `INSERT INTO generations (user_id, project_id, campaign_id, type, status, input_url, credits_used, metadata, idempotency_key)
     VALUES ($1, $2, $3, 'vid-upscale', 'pending', $4, $5, $6, $7) RETURNING id`,
    [userId, effectiveProjectId, effectiveCampaignId, videoUrl, units, JSON.stringify({ toolType: 'vid-upscale', factor, provider: provider.name }), idempotencyKey || null]
  );
  const genId = gen.rows[0].id;

  if (units > 0) await debitOrFail(userId, 'vid-upscale', units, genId);
  try {
    const result = await provider.upscaleVideo(apiKey, { videoUrl, upscaleFactor: factor });
    await handleProviderResult(genId, result, provider.name, 'vid-upscale');

    // Calculate and store real API cost
    const cost = provider.calculateCost('vid-upscale', {});
    await query('UPDATE generations SET api_cost = $1 WHERE id = $2', [cost, genId]);

    logActivity(userId, 'tool_use', 'generation', genId, { tool: 'video-upscale', factor, provider: provider.name });

    return { taskId: result.taskId || null, recordId: result.recordId || null, generationId: genId, type: 'vid-upscale' };
  } catch (err) {
    if (units > 0) await refundCredits(userId, 'vid-upscale', units, genId);
    await query('UPDATE generations SET status = $1, error = $2 WHERE id = $3', ['failed', err.message, genId]);
    throw err;
  }
}

// ─── Exports kept for backward compat (jarvis.js imports getApiKey) ───

export async function getApiKey() {
  const prov = await getProvider();
  return getProviderApiKey(prov.name);
}

export async function getCreditsInfo() {
  const remaining = await getQuotaRemaining();
  return { imageCredits: remaining.imageCredits, videoCredits: remaining.videoCredits };
}

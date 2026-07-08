/**
 * Generate Routes — Studio UI endpoints
 *
 * All generation logic delegates to keou-actions.js (provider-aware).
 * These routes just handle HTTP validation + response formatting.
 */

import { Router } from 'express';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePro } from '../middleware/pro.js';
import { requireCredits } from '../middleware/credits.js';
import { requireEnterprise } from '../middleware/edition.js';
import { billingMode } from '../utils/credits.js';
import { logActivity } from '../utils/activity.js';
import { query, queryOne, queryAll } from '../db.js';
import {
  executeGenerateImage,
  executeGenerateVideo,
  executePolish,
  executeRemix,
  executeAdapt,
  executeImageUpscale,
  executeVideoUpscale,
  persistAndComplete,
  findIdempotent,
} from '../lib/keou-actions.js';

/**
 * Shared pattern: if idempotencyKey is present, either short-circuit with the
 * existing task or (if stale) fall through to normal processing. If absent,
 * apply the legacy 1-second input_url dup guard.
 * Returns { existing } to short-circuit, or null to proceed.
 */
async function applyIdempotency(req, res, { imageUrl, idempotencyKey, type }) {
  if (idempotencyKey) {
    const existing = await findIdempotent(req.user.id, idempotencyKey);
    if (existing) {
      res.json({
        generationId: existing.id,
        taskId: existing.task_id,
        recordId: existing.record_id,
        type,
        deduped: true,
      });
      return true;
    }
    return false;
  }
  if (imageUrl) {
    const recent = await queryOne(
      `SELECT id FROM generations WHERE user_id = $1 AND input_url = $2 AND created_at > NOW() - INTERVAL '1 second' LIMIT 1`,
      [req.user.id, imageUrl]
    );
    if (recent) {
      res.status(409).json({ error: 'Duplicate request — generation already in progress', generationId: recent.id });
      return true;
    }
  }
  return false;
}

/** Retry-existing helper for race on unique constraint (23505). */
async function resolveUniqueRace(req, res, idempotencyKey, type) {
  if (!idempotencyKey) return false;
  const existing = await findIdempotent(req.user.id, idempotencyKey);
  if (existing) {
    res.json({
      generationId: existing.id,
      taskId: existing.task_id,
      recordId: existing.record_id,
      type,
      deduped: true,
    });
    return true;
  }
  return false;
}

const router = Router();

/** Map error to user-friendly message */
function friendlyError(e, fallback) {
  const msg = e.message || '';
  // Credits mode: the platform operates the production engine — never leak
  // provider names or upstream billing details to the client.
  if (billingMode() === 'credits') {
    if (msg.includes('Insufficient credits')) return 'Insufficient credits — contact your account manager to top up';
    if (msg.includes('Credits insufficient') || msg.includes('exhausted') || msg.includes('402')) return 'Production engine temporarily unavailable — our team has been notified, please try again shortly';
    if (msg.includes('429') || msg.includes('rate limit')) return 'Rate limit reached — please wait a moment and try again';
    if (msg.includes('API') || msg.includes('KIE') || msg.includes('Fal')) return 'Generation failed — please try again';
    return fallback;
  }
  // No key configured
  if (msg === 'NO_API_KEY' || msg.includes('No API key configured') || msg.includes('not configured')) return 'API key not configured — go to Dashboard → Settings to add your API key';
  // Auth errors
  if (msg.includes('API 401') || msg.includes('API 403')) return 'API key is invalid — check your key in Dashboard → Settings';
  // Fal specific
  if (msg.includes('Fal API 402') || msg.includes('insufficient') || msg.includes('payment')) return 'Insufficient credits on Fal.ai — top up at fal.ai/dashboard/billing';
  if (msg.includes('Fal API 429') || msg.includes('rate limit')) return 'Rate limit reached — please wait a moment and try again';
  if (msg.includes('Fal')) return `Fal.ai error: ${msg.slice(0, 150)}`;
  // KIE specific
  if (msg.includes('Credits insufficient') || msg.includes('exhausted')) return 'Credits exhausted — please top up on kie.ai';
  if (msg.includes('KIE')) return `KIE.AI error: ${msg.slice(0, 150)}`;
  // Generic API error
  if (msg.includes('API')) return `API error: ${msg.slice(0, 150)}`;
  return fallback;
}

/** Exported for compatibility — resolve campaign ID */
async function resolveEffectiveCampaignId(projectId, campaignId) {
  if (campaignId) return campaignId;
  const row = await queryOne(
    "SELECT id FROM campaigns WHERE project_id = $1 AND name = 'General' ORDER BY id ASC LIMIT 1",
    [projectId]
  );
  if (row) return row.id;
  const result = await query(
    `INSERT INTO campaigns (project_id, name, description, color, created_by)
     VALUES ($1, 'General', 'Default campaign', '#6B7280', (SELECT created_by FROM projects WHERE id = $1))
     ON CONFLICT (project_id, name) DO UPDATE SET name = 'General'
     RETURNING id`,
    [projectId]
  );
  return result.rows[0].id;
}
export { resolveEffectiveCampaignId };

/** Clear cached key — delegates to the real provider cache invalidator. */
export async function clearKieKeyCache() {
  const { clearKeyCache } = await import('../lib/providers/index.js');
  clearKeyCache();
}

// ─── Generate Image ───
router.post('/generate', requireAuth, requireCredits('image', 1), async (req, res) => {
  try {
    const { imgUrl, format, projectId, campaignId, creativeDirection, idempotencyKey } = req.body;
    if (!imgUrl) return res.status(400).json({ error: 'imgUrl required' });

    if (await applyIdempotency(req, res, { imageUrl: imgUrl, idempotencyKey, type: 'image' })) return;

    const result = await executeGenerateImage(req.user.id, { imgUrl, format, creativeDirection, projectId, campaignId, idempotencyKey });
    res.json(result);
  } catch (e) {
    console.error('Generate error:', e);
    if (e.code === '23505' && await resolveUniqueRace(req, res, req.body?.idempotencyKey, 'image')) return;
    if (!res.headersSent) res.status(500).json({ error: friendlyError(e, 'Generation failed') });
  }
});

// ─── Generate Video ───
router.post('/video', requireAuth, requireCredits('video', 1), async (req, res) => {
  try {
    const { imageUrl, projectId, campaignId, creativeDirection, videoModel,
            duration, resolution, mode, sound, aspectRatio, generateAudio, variant, idempotencyKey } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });

    if (await applyIdempotency(req, res, { imageUrl, idempotencyKey, type: 'video' })) return;

    const result = await executeGenerateVideo(req.user.id, {
      imageUrl, videoModel, creativeDirection, duration, resolution, mode, sound, aspectRatio, generateAudio, variant, projectId, campaignId, idempotencyKey,
    });
    res.json(result);
  } catch (e) {
    console.error('Video error:', e);
    if (e.code === '23505' && await resolveUniqueRace(req, res, req.body?.idempotencyKey, 'video')) return;
    if (!res.headersSent) res.status(500).json({ error: friendlyError(e, 'Video generation failed') });
  }
});

// ─── Polish Image ───
router.post('/polish', requireEnterprise, requireAuth, requireCredits('image', 1), async (req, res) => {
  try {
    const { imageUrl, ratio, projectId, campaignId, idempotencyKey } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });

    if (await applyIdempotency(req, res, { imageUrl, idempotencyKey, type: 'polish' })) return;

    const result = await executePolish(req.user.id, { imageUrl, ratio, projectId, campaignId, idempotencyKey });
    res.json(result);
  } catch (e) {
    console.error('Polish error:', e);
    if (e.code === '23505' && await resolveUniqueRace(req, res, req.body?.idempotencyKey, 'polish')) return;
    if (!res.headersSent) res.status(500).json({ error: friendlyError(e, 'Polish failed') });
  }
});

// ─── Remix Image ───
router.post('/remix', requireEnterprise, requireAuth, requireCredits('image', 1), async (req, res) => {
  try {
    const { imageUrl, remixPrompt, ratio, projectId, campaignId, idempotencyKey } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });
    if (!remixPrompt || !remixPrompt.trim()) return res.status(400).json({ error: 'remixPrompt required' });

    if (await applyIdempotency(req, res, { imageUrl, idempotencyKey, type: 'remix' })) return;

    const result = await executeRemix(req.user.id, { imageUrl, remixPrompt: remixPrompt.trim(), ratio, projectId, campaignId, idempotencyKey });
    res.json(result);
  } catch (e) {
    console.error('Remix error:', e);
    if (e.code === '23505' && await resolveUniqueRace(req, res, req.body?.idempotencyKey, 'remix')) return;
    if (!res.headersSent) res.status(500).json({ error: friendlyError(e, 'Remix failed') });
  }
});

// ─── Adapt Format ───
router.post('/adapt', requireEnterprise, requireAuth, requireCredits('image', 1), async (req, res) => {
  try {
    const { imageUrl, ratio, projectId, campaignId, idempotencyKey } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });
    if (!ratio) return res.status(400).json({ error: 'ratio required' });

    const validRatios = ['1:1', '3:4', '4:3', '9:16', '16:9'];
    if (!validRatios.includes(ratio)) return res.status(400).json({ error: `Invalid ratio. Must be one of: ${validRatios.join(', ')}` });

    if (await applyIdempotency(req, res, { imageUrl, idempotencyKey, type: 'adapt' })) return;

    const result = await executeAdapt(req.user.id, { imageUrl, ratio, projectId, campaignId, idempotencyKey });
    res.json(result);
  } catch (e) {
    console.error('Adapt error:', e);
    if (e.code === '23505' && await resolveUniqueRace(req, res, req.body?.idempotencyKey, 'adapt')) return;
    if (!res.headersSent) res.status(500).json({ error: friendlyError(e, 'Adapt failed') });
  }
});

// ─── Upscale Video ───
router.post('/upscale', requireEnterprise, requireAuth, async (req, res) => {
  try {
    const { videoUrl, projectId, campaignId, idempotencyKey } = req.body;
    if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });

    if (await applyIdempotency(req, res, { imageUrl: videoUrl, idempotencyKey, type: 'vid-upscale' })) return;

    const result = await executeVideoUpscale(req.user.id, { videoUrl, upscaleFactor: '4', projectId, campaignId, idempotencyKey });
    res.json(result);
  } catch (e) {
    console.error('Upscale error:', e);
    if (e.code === '23505' && await resolveUniqueRace(req, res, req.body?.idempotencyKey, 'vid-upscale')) return;
    if (!res.headersSent) res.status(500).json({ error: friendlyError(e, 'Upscale failed') });
  }
});

// ─── Poll Status (used by studio frontend) ───
router.get('/status/:type/:taskId', requireAuth, async (req, res) => {
  try {
    const { taskId, type } = req.params;
    const generationId = req.query.generationId;

    // Check DB first — if already completed/failed by poller, return immediately
    if (generationId) {
      const gen = await queryOne('SELECT status, result_url, error FROM generations WHERE id = $1 AND user_id = $2', [generationId, req.user.id]);
      if (gen) {
        if (gen.status === 'completed' && gen.result_url) {
          return res.json({ ready: true, resultUrl: gen.result_url, state: 'completed' });
        }
        if (gen.status === 'failed') {
          return res.json({ ready: false, failed: true, state: 'failed', error: gen.error || 'Generation failed' });
        }
      }
    }

    // Not yet done — poll the provider directly for faster response
    const { getProviderApiKey } = await import('../lib/providers/index.js');

    // Detect provider + type from generation metadata.
    // Ownership check: this fallback polls the provider with the agency key and
    // returns the result URL — never serve another member's generation.
    let providerName = 'kie';
    let genType = type || 'image';
    let genRow = null;
    if (generationId) {
      genRow = await queryOne(
        `SELECT metadata, type FROM generations WHERE id = $1 ${req.user.role === 'admin' ? '' : 'AND user_id = $2'}`,
        req.user.role === 'admin' ? [generationId] : [generationId, req.user.id]
      );
      if (!genRow) return res.status(404).json({ error: 'Generation not found' });
      try {
        if (genRow.metadata) {
          const meta = typeof genRow.metadata === 'string' ? JSON.parse(genRow.metadata) : genRow.metadata;
          if (meta.provider) providerName = meta.provider;
        }
        if (genRow.type) genType = genRow.type;
      } catch (err) { console.error('[STATUS PROVIDER DETECT]', err.message); }
    }

    const kieProvider = await import('../lib/providers/kie.js');
    const falProvider = await import('../lib/providers/fal.js');
    const provider = providerName === 'fal' ? falProvider : kieProvider;

    let apiKey;
    try { apiKey = await getProviderApiKey(providerName); }
    catch (err) { console.error('[STATUS API KEY]', err.message); return res.json({ ready: false, state: 'no_key' }); }

    // Get metadata for polling context (genRow already ownership-checked above)
    let metadata = '{}';
    if (genRow) metadata = genRow.metadata || '{}';

    const result = await provider.pollTask(apiKey, { taskId, recordId: req.query.recordId, metadata });

    if (result.status === 'completed' && result.resultUrl) {
      // Persist to R2 inline so the client fast-path doesn't leave KIE temp URLs in DB
      // (KIE URLs expire in 14d — without this, history/share links break later).
      let finalUrl = result.resultUrl;
      if (generationId) {
        try { finalUrl = await persistAndComplete(generationId, result.resultUrl, genType); }
        catch (persistErr) { console.error('[STATUS R2 PERSIST]', persistErr.message); }
      }
      return res.json({ ready: true, resultUrl: finalUrl, state: 'completed' });
    }

    if (result.status === 'failed') {
      if (generationId) {
        // C1 — transition-first: atomically flip the row, and ONLY the call that wins
        // the flip refunds. Prevents the double-refund race when two status polls (or a
        // poll + the server poller) hit a failed task at the same time.
        const flipped = await query(
          `UPDATE generations SET status='failed', error=$1
             WHERE id=$2 AND status IN ('pending','processing')
           RETURNING type, credits_used, user_id`,
          [result.error || 'Generation failed', generationId]
        );
        if (flipped.rowCount === 1 && flipped.rows[0].credits_used > 0) {
          const g = flipped.rows[0];
          const { refundCredits } = await import('../utils/credits.js');
          const creditType = g.type === 'video' ? 'video' : 'image';
          await refundCredits(g.user_id, creditType, g.credits_used, generationId);
        }
      }
      return res.json({ ready: false, failed: true, state: 'failed', error: result.error });
    }

    res.json({ ready: false, state: result.status });
  } catch (e) {
    console.error('Status error:', e);
    res.status(500).json({ error: 'Status check failed' });
  }
});

// ─── Report failure (refund credits) ───
router.post('/report-failure', requireAuth, async (req, res) => {
  try {
    const { generationId } = req.body;
    if (!generationId) return res.status(400).json({ error: 'generationId required' });

    const gen = await queryOne('SELECT * FROM generations WHERE id = $1 AND user_id = $2', [generationId, req.user.id]);
    if (!gen) return res.status(404).json({ error: 'Generation not found' });
    if (gen.status === 'completed') return res.status(400).json({ error: 'Already completed' });
    // Idempotent: if another worker (poller / status route) already marked failed + refunded, skip
    if (gen.status === 'failed') return res.json({ ok: true, refunded: 0, alreadyFailed: true });

    const creditType = gen.type === 'video' ? 'video' : 'image';
    const { refundCredits } = await import('../utils/credits.js');
    // Atomic status transition — only refund + mark failed if still pending/processing
    const transition = await query(
      `UPDATE generations SET status='failed', error=$1 WHERE id=$2 AND status IN ('pending','processing') RETURNING id`,
      [req.body.error || 'Task failed', generationId]
    );
    if (transition.rowCount === 0) {
      // Lost the race — someone else finalized the row. Skip refund.
      return res.json({ ok: true, refunded: 0, alreadyFinalized: true });
    }
    if (gen.credits_used > 0) {
      await refundCredits(req.user.id, creditType, gen.credits_used, generationId);
    }

    res.json({ ok: true, refunded: gen.credits_used });
  } catch (e) {
    console.error('Report failure error:', e);
    res.status(500).json({ error: 'Failed to report failure' });
  }
});

// ═══════════════════════════════════════════
// EXPORT PACKS
// One source generation → N adapt variants in parallel → bundled ZIP
// for delivery. Each variant is a regular generations row tagged with
// pack_id so we can group them later.
// ═══════════════════════════════════════════
import { listPacks, getPack, slugify, packEntryName } from '../lib/packs.js';
import { randomBytes } from 'crypto';
import JSZip from 'jszip';

router.get('/packs', requireEnterprise, requireAuth, (req, res) => {
  res.json({ packs: listPacks() });
});

/**
 * POST /api/generate/pack
 * Body: { sourceGenerationId, packId, projectId?, campaignId? }
 * Returns: { packId, sourceGenerationId, formats: [{ name, ratio, generationId, taskId, recordId }] }
 *
 * Each format is fired in parallel via executeAdapt. Each row in DB gets
 * a shared pack_id so the ZIP endpoint can group them.
 */
router.post('/pack', requireEnterprise, requireAuth, requirePro, requireCredits('image', 1), async (req, res) => {
  try {
    const { sourceGenerationId, packId, projectId, campaignId } = req.body;
    const sgi = parseInt(sourceGenerationId);
    if (!sgi) return res.status(400).json({ error: 'sourceGenerationId required' });
    const pack = getPack(packId);
    if (!pack) return res.status(400).json({ error: 'Unknown packId' });

    // Source must exist + completed + belong to user (or admin)
    const source = await queryOne(
      'SELECT id, user_id, type, result_url, r2_key, status FROM generations WHERE id = $1',
      [sgi]
    );
    if (!source) return res.status(404).json({ error: 'Source generation not found' });
    if (req.user.role !== 'admin' && source.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to use this source' });
    }
    if (source.status !== 'completed' || !source.result_url) {
      return res.status(400).json({ error: 'Source must be a completed generation' });
    }

    // Stable pack id for grouping
    const packGroupId = `pk_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;

    // Fire all adaptations in parallel
    const results = await Promise.all(pack.formats.map(async (fmt) => {
      try {
        const r = await executeAdapt(req.user.id, {
          imageUrl: source.result_url,
          ratio: fmt.ratio,
          projectId,
          campaignId,
          // No idempotencyKey — each adapt is genuinely a new generation
        });
        // Tag the row with pack metadata so we can group + name on ZIP
        if (r.generationId) {
          await query(
            'UPDATE generations SET pack_id = $1, pack_format_label = $2 WHERE id = $3',
            [packGroupId, fmt.name, r.generationId]
          );
        }
        return { ...fmt, generationId: r.generationId, taskId: r.taskId, recordId: r.recordId, error: null };
      } catch (e) {
        console.error('[PACK adapt error]', fmt.name, e.message);
        return { ...fmt, generationId: null, error: e.message };
      }
    }));

    res.json({
      packId: packGroupId,
      packPresetId: packId,
      sourceGenerationId: sgi,
      formats: results,
    });
  } catch (e) {
    console.error('Pack create error:', e);
    if (!res.headersSent) res.status(500).json({ error: friendlyError(e, 'Failed to start pack') });
  }
});

/**
 * GET /api/generate/pack/:packId/status
 * Polled by the studio to track progress of all N adaptations.
 */
router.get('/pack/:packId/status', requireAuth, async (req, res) => {
  try {
    const items = await queryAll(
      `SELECT id, status, result_url, r2_key, pack_format_label, error
         FROM generations
        WHERE pack_id = $1 ${req.user.role === 'admin' ? '' : 'AND user_id = $2'}
        ORDER BY id ASC`,
      req.user.role === 'admin' ? [req.params.packId] : [req.params.packId, req.user.id]
    );
    if (items.length === 0) return res.status(404).json({ error: 'Pack not found' });
    const ready = items.filter(i => i.status === 'completed').length;
    const failed = items.filter(i => i.status === 'failed').length;
    res.json({
      packId: req.params.packId,
      total: items.length,
      ready,
      failed,
      done: (ready + failed) === items.length,
      items: items.map(i => ({
        generationId: i.id,
        formatLabel: i.pack_format_label,
        status: i.status,
        url: i.result_url || null,
        error: i.error || null,
      })),
    });
  } catch (e) {
    console.error('Pack status error:', e);
    res.status(500).json({ error: 'Failed to fetch pack status' });
  }
});

/**
 * GET /api/generate/pack/:packId/zip
 * Bundles all completed pack items into a single ZIP and streams to the browser.
 * Naming convention : NN_<format-name>_<W>x<H>.png inside a folder named
 * after the campaign or project.
 */
router.get('/pack/:packId/zip', requireAuth, async (req, res) => {
  try {
    const items = await queryAll(
      `SELECT g.id, g.status, g.result_url, g.r2_key, g.pack_format_label, g.format,
              p.name AS project_name, c.name AS campaign_name
         FROM generations g
         LEFT JOIN projects p ON p.id = g.project_id
         LEFT JOIN campaigns c ON c.id = g.campaign_id
        WHERE g.pack_id = $1 ${req.user.role === 'admin' ? '' : 'AND g.user_id = $2'}
        ORDER BY g.id ASC`,
      req.user.role === 'admin' ? [req.params.packId] : [req.params.packId, req.user.id]
    );
    if (items.length === 0) return res.status(404).json({ error: 'Pack not found' });
    const ready = items.filter(i => i.status === 'completed' && i.result_url);
    if (ready.length === 0) return res.status(409).json({ error: 'No items ready in this pack yet' });

    // Build folder name : ProjectName_CampaignName_YYYYMMDD or fallback
    const projectSlug = slugify(items[0].project_name || 'pack');
    const campaignSlug = items[0].campaign_name && items[0].campaign_name !== 'General'
      ? '_' + slugify(items[0].campaign_name) : '';
    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const folderName = `${projectSlug}${campaignSlug}_${dateStr}`;

    const zip = new JSZip();
    const folder = zip.folder(folderName);

    // Fetch every asset in parallel and add to ZIP
    await Promise.all(ready.map(async (item, i) => {
      try {
        const r = await fetch(item.result_url);
        if (!r.ok) throw new Error(`fetch ${r.status}`);
        const buffer = Buffer.from(await r.arrayBuffer());
        const ext = (r.headers.get('content-type') || '').includes('jpeg') ? 'jpg' : 'png';
        const name = packEntryName(i, { name: item.pack_format_label || 'asset', ratio: item.format || '1:1' }, ext);
        folder.file(name, buffer);
      } catch (e) {
        console.error('[PACK zip fetch]', item.id, e.message);
      }
    }));

    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${folderName}.zip"`);
    res.send(buf);
  } catch (e) {
    console.error('Pack zip error:', e);
    res.status(500).json({ error: 'Failed to build ZIP' });
  }
});

// ─── Get user's pending/processing generations ───
router.get('/pending', requireEnterprise, requireAuth, async (req, res) => {
  try {
    const items = await queryAll(`
      SELECT id, type, status, task_id, record_id, input_url, format, created_at, metadata
      FROM generations
      WHERE user_id = $1
        AND status IN ('pending', 'processing')
        AND created_at > NOW() - INTERVAL '1 hour'
      ORDER BY created_at DESC
    `, [req.user.id]);
    res.json({ items });
  } catch (e) {
    console.error('Pending error:', e);
    res.status(500).json({ error: 'Failed to get pending items' });
  }
});

export default router;

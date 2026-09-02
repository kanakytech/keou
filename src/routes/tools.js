/**
 * Creative Tools routes — TTS / SFX / Image-Upscale / Video-Upscale
 *
 * All logic delegates to keou-actions.js (provider-aware, handles encrypted
 * API keys, R2 persistence, and the shared task lifecycle).
 * Routes just handle HTTP validation + idempotency + response formatting.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { queryOne } from '../db.js';
import { billingMode } from '../utils/credits.js';
import {
  executeTts,
  executeSfx,
  executeImageUpscale,
  executeVideoUpscale,
  findIdempotent,
} from '../lib/keou-actions.js';

const router = Router();

/** Shared idempotency handler — short-circuits if the client retries with the same key. */
async function applyIdempotency(req, res, { idempotencyKey, type }) {
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

function friendlyToolError(e, fallback) {
  const msg = e.message || '';
  if (billingMode() === 'credits') {
    if (msg.includes('Insufficient credits')) return 'Insufficient credits — contact your account manager to top up';
    if (msg.includes('402') || msg.includes('insufficient') || msg.includes('exhausted')) return 'Production engine temporarily unavailable — our team has been notified, please try again shortly';
    if (msg.includes('429') || msg.includes('rate limit')) return 'Rate limit reached — please wait a moment and try again';
    return fallback;
  }
  if (msg === 'NO_API_KEY' || msg.includes('not configured')) return 'API key not configured — go to Dashboard → Settings';
  if (msg.includes('API 401') || msg.includes('API 403')) return 'API key is invalid — check your key in Dashboard → Settings';
  if (msg.includes('402') || msg.includes('insufficient') || msg.includes('exhausted')) return 'Credits exhausted on provider — top up';
  if (msg.includes('429') || msg.includes('rate limit')) return 'Rate limit reached — please wait a moment and try again';
  // Agrandissement : le résultat dépasserait 20 000 px de côté (cas typique :
  // ré-agrandir une image déjà agrandie). Le 422 brut ne dit pas quoi faire.
  if (/exceeds the limit after scaling/i.test(msg)) return 'The result would exceed the provider\'s 20,000 px limit on the longest side — pick ×2 instead of ×4, or start from a smaller image.';
  if (/max size|too large/i.test(msg)) return 'The source file is heavier than the 10 MB the provider accepts — start from a lighter file.';
  return fallback + (msg ? `: ${msg.slice(0, 150)}` : '');
}

// ═══ TTS — ElevenLabs Turbo v2.5 ═══
router.post('/tts', requireAuth, async (req, res) => {
  try {
    const { text, voice, stability, similarity_boost, style, speed, projectId, campaignId, idempotencyKey } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'text is required' });
    }
    if (text.length > 5000) {
      return res.status(400).json({ error: 'text must be 5000 characters or less' });
    }

    if (await applyIdempotency(req, res, { idempotencyKey, type: 'tts' })) return;

    const result = await executeTts(req.user.id, {
      text: text.trim(),
      // Pas de defaut impose : « Rachel » est un NOM de l'ancienne API
      // ElevenLabs, que KIE ne reconnait plus. Le fournisseur a le sien.
      voice: typeof voice === 'string' && voice.trim() ? voice.trim() : undefined,
      stability: stability != null ? Number(stability) : undefined,
      similarity_boost: similarity_boost != null ? Number(similarity_boost) : undefined,
      style: style != null ? Number(style) : undefined,
      speed: speed != null ? Number(speed) : undefined,
      projectId, campaignId, idempotencyKey,
    });
    res.json(result);
  } catch (e) {
    console.error('TTS tool error:', e);
    if (e.code === '23505' && await resolveUniqueRace(req, res, req.body?.idempotencyKey, 'tts')) return;
    if (!res.headersSent) res.status(500).json({ error: friendlyToolError(e, 'TTS generation failed') });
  }
});

// ═══ SFX — ElevenLabs Sound Effects v2 ═══
router.post('/sfx', requireAuth, async (req, res) => {
  try {
    const { text, duration_seconds, projectId, campaignId, idempotencyKey } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'text is required' });
    }
    if (text.length > 450) {
      return res.status(400).json({ error: 'text must be 450 characters or less' });
    }

    if (await applyIdempotency(req, res, { idempotencyKey, type: 'sfx' })) return;

    const result = await executeSfx(req.user.id, {
      text: text.trim(),
      duration_seconds: duration_seconds != null ? Math.min(22, Math.max(0.5, Number(duration_seconds))) : undefined,
      projectId, campaignId, idempotencyKey,
    });
    res.json(result);
  } catch (e) {
    console.error('SFX tool error:', e);
    if (e.code === '23505' && await resolveUniqueRace(req, res, req.body?.idempotencyKey, 'sfx')) return;
    if (!res.headersSent) res.status(500).json({ error: friendlyToolError(e, 'SFX generation failed') });
  }
});

// ═══ Image Upscale — Topaz ═══
router.post('/image-upscale', requireAuth, async (req, res) => {
  try {
    const { imageUrl, upscaleFactor, projectId, campaignId, idempotencyKey } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });
    // Topaz ne connait que 1, 2 et 4 : accepter '8' revenait a facturer un
    // agrandissement que le fournisseur ne rend pas. Voir src/lib/providers/kie.js.
    const demandeFacteur = String(upscaleFactor ?? '4');
    if (!['1', '2', '4'].includes(demandeFacteur)) {
      return res.status(400).json({ error: 'Upscale factor must be 2 or 4 — the provider does not do more' });
    }
    const factor = demandeFacteur;

    if (await applyIdempotency(req, res, { idempotencyKey, type: 'img-upscale' })) return;

    const result = await executeImageUpscale(req.user.id, {
      imageUrl, upscaleFactor: factor, projectId, campaignId, idempotencyKey,
    });
    res.json(result);
  } catch (e) {
    console.error('Image upscale tool error:', e);
    if (e.code === '23505' && await resolveUniqueRace(req, res, req.body?.idempotencyKey, 'img-upscale')) return;
    if (!res.headersSent) res.status(500).json({ error: friendlyToolError(e, 'Image upscale failed') });
  }
});

// ═══ Video Upscale — Topaz ═══
router.post('/video-upscale', requireAuth, async (req, res) => {
  try {
    const { videoUrl, upscaleFactor, projectId, campaignId, idempotencyKey } = req.body;
    if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });
    const factor = ['2', '4'].includes(String(upscaleFactor)) ? String(upscaleFactor) : '4';

    if (await applyIdempotency(req, res, { idempotencyKey, type: 'vid-upscale' })) return;

    const result = await executeVideoUpscale(req.user.id, {
      videoUrl, upscaleFactor: factor, projectId, campaignId, idempotencyKey,
    });
    res.json(result);
  } catch (e) {
    console.error('Video upscale tool error:', e);
    if (e.code === '23505' && await resolveUniqueRace(req, res, req.body?.idempotencyKey, 'vid-upscale')) return;
    if (!res.headersSent) res.status(500).json({ error: friendlyToolError(e, 'Video upscale failed') });
  }
});

export default router;

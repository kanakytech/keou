import { getQuotaRemaining, getUserUsage, getAgency, billingMode } from '../utils/credits.js';
import { creditCost } from '../lib/pricing.js';
import { isByok } from './edition.js';

/**
 * Middleware factory — friendly pre-check before a generation starts.
 * quota mode  : checks agency pool + per-user quota (legacy behavior).
 * credits mode: checks the prepaid credit balance against the estimated
 *               action cost (from req.body for video model/duration).
 * Enforcement is always the atomic UPDATE in deductCredits — this middleware
 * only exists to fail fast with a clear 402.
 * @param {'image'|'video'} creditType
 * @param {number} amount
 */
const UNLIMITED_THRESHOLD = 999999;

export function requireCredits(creditType, amount = 1) {
  return async (req, res, next) => {
    // BYOK editions: the caller's own provider key pays for the generation —
    // no platform balance or quota to pre-check.
    if (isByok()) return next();

    if (billingMode() === 'credits') {
      const estimated = creditType === 'video'
        // /api/video sends `videoModel`; jarvis/internal callers may send `model`
        ? creditCost('video', { model: req.body?.videoModel || req.body?.model, duration: req.body?.duration })
        : creditCost(creditType === 'image' ? 'image' : creditType, {});
      const agency = await getAgency();
      const balance = parseInt(agency?.credit_balance) || 0;
      if (balance < estimated) {
        return res.status(402).json({
          error: 'Insufficient credits',
          code: 'INSUFFICIENT_CREDITS',
          balance,
          required: estimated,
          message: 'Your credit balance is too low for this generation. Contact your account manager to top up.',
        });
      }
      return next();
    }
    // 1. Check agency-level pool (skipped if agency has unlimited quota).
    // getAgency() is cached 10s and invalidated on every deductCredits/refundCredits,
    // so we trade at worst 10s of staleness (which the atomic UPDATE in deductCredits
    // catches anyway) for one fewer DB roundtrip per generate/video/polish request.
    const agency = await getAgency();
    const quotaCol = creditType === 'video' ? 'video_quota' : 'image_quota';
    const usedCol = creditType === 'video' ? 'video_used' : 'image_used';
    const isUnlimited = agency && agency[quotaCol] >= UNLIMITED_THRESHOLD;

    if (!isUnlimited) {
      const remaining = await getQuotaRemaining();
      const key = creditType === 'video' ? 'videoCredits' : 'imageCredits';

      if (remaining[key] < amount) {
        return res.status(402).json({
          error: 'Agency quota exceeded',
          code: 'QUOTA_EXCEEDED',
          remaining: remaining[key],
          required: amount,
          creditType,
          message: 'Contact your admin to increase the quota or enable unlimited mode',
        });
      }
    }

    // 2. Check per-user quota (if set — NULL means unlimited within agency pool)
    const user = req.user;
    const userQuota = creditType === 'video' ? user.video_quota : user.image_quota;

    if (userQuota !== null && userQuota !== undefined) {
      const usage = await getUserUsage(user.id);
      const userUsed = creditType === 'video' ? usage.videoUsed : usage.imageUsed;

      if (userUsed + amount > userQuota) {
        return res.status(402).json({
          error: 'Personal quota exceeded',
          code: 'USER_QUOTA_EXCEEDED',
          remaining: Math.max(0, userQuota - userUsed),
          quota: userQuota,
          used: userUsed,
          required: amount,
          creditType,
          message: 'You have reached your individual limit. Contact your admin.',
        });
      }
    }

    next();
  };
}

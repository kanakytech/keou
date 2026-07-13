import { query, queryOne } from '../db.js';
import { getPresignedUrl } from '../lib/r2.js';
import { config } from '../config.js';
import { isByok } from '../middleware/edition.js';

/**
 * Billing mode of this deployment. 'quota' = legacy image/video pools,
 * 'credits' = prepaid Keou credit balance (see src/lib/pricing.js).
 */
export function billingMode() {
  return config.billingMode;
}

/**
 * Agency singleton — cached 10s to avoid hitting the DB on every generate /
 * quota check. Routes that mutate the agency row (admin quota update, logo
 * upload, branding) must call clearAgencyCache() to invalidate.
 */
let _agencyCache = { value: null, exp: 0 };

export async function getAgency() {
  const now = Date.now();
  if (_agencyCache.value && now < _agencyCache.exp) return _agencyCache.value;
  const row = await queryOne('SELECT * FROM agency LIMIT 1');
  _agencyCache = { value: row, exp: now + 10_000 };
  return row;
}

export function clearAgencyCache() {
  _agencyCache = { value: null, exp: 0 };
}

/** Get remaining quota */
export async function getQuotaRemaining() {
  const agency = await getAgency();
  if (!agency) return { imageCredits: 0, videoCredits: 0 };
  return {
    imageCredits: agency.image_quota - agency.image_used,
    videoCredits: agency.video_quota - agency.video_used,
  };
}

/** Resolve logo URL — re-sign R2 keys, pass through full URLs */
async function resolveLogoUrl(logoUrl) {
  if (!logoUrl) return null;
  // If it's already a full URL (legacy imgBB or presigned), return as-is
  if (logoUrl.startsWith('http')) return logoUrl;
  // Otherwise it's an R2 key — generate a fresh presigned URL (7 days)
  try {
    return await getPresignedUrl(logoUrl, 604800);
  } catch {
    return null;
  }
}

/** Get full quota summary for API responses */
export async function getQuotaSummary() {
  const agency = await getAgency();
  if (!agency) return { imageQuota: 0, videoQuota: 0, imageUsed: 0, videoUsed: 0, imageCredits: 0, videoCredits: 0, billingMode: billingMode(), creditBalance: 0 };
  return {
    billingMode: billingMode(),
    creditBalance: parseInt(agency.credit_balance) || 0,
    agencyName: agency.name,
    agencyLogo: await resolveLogoUrl(agency.logo_url),
    imageQuota: agency.image_quota,
    videoQuota: agency.video_quota,
    imageUsed: agency.image_used,
    videoUsed: agency.video_used,
    imageCredits: agency.image_quota - agency.image_used,
    videoCredits: agency.video_quota - agency.video_used,
  };
}

/** Get usage counts for a specific user */
export async function getUserUsage(userId) {
  const row = await queryOne(`
    SELECT
      COALESCE(SUM(CASE WHEN type IN ('image','polish') AND status = 'completed' THEN credits_used ELSE 0 END), 0) as "imageUsed",
      COALESCE(SUM(CASE WHEN type = 'video' AND status = 'completed' THEN credits_used ELSE 0 END), 0) as "videoUsed"
    FROM generations WHERE user_id = $1
  `, [userId]);
  return {
    imageUsed: parseInt(row?.imageUsed) || 0,
    videoUsed: parseInt(row?.videoUsed) || 0,
  };
}

/**
 * Deduct credits (atomic — prevents race conditions).
 *
 * quota mode  : `amount` is quota units (1 per generation), debited from the
 *               image/video pool matching `creditType`.
 * credits mode: `amount` is Keou credits (variable per action, from
 *               src/lib/pricing.js), debited from agency.credit_balance.
 *
 * Note: if BILLING_MODE is flipped while a generation is in flight, its
 * refund lands in the pool of the *new* mode — acceptable for a manual,
 * one-time migration done outside business hours.
 */
export async function deductCredits(userId, creditType, amount, generationId) {
  // BYOK editions (opensource, community): the caller pays their own provider
  // directly — there is nothing to meter. Record the transaction for
  // analytics, never enforce a balance or pool.
  if (isByok()) {
    await query(
      `INSERT INTO credit_transactions (user_id, type, amount, reason, generation_id) VALUES ($1, $2, $3, 'generation', $4)`,
      [userId, creditType, -amount, generationId]
    );
    return 999999;
  }

  if (billingMode() === 'credits') {
    clearAgencyCache();
    const result = await query(
      `UPDATE agency SET credit_balance = credit_balance - $1, updated_at = NOW()
       WHERE id = 1 AND credit_balance >= $1
       RETURNING credit_balance as remaining`,
      [amount]
    );
    if (result.rowCount === 0) {
      throw new Error('Insufficient credits');
    }
    const remaining = parseInt(result.rows[0].remaining);
    await query(
      `INSERT INTO credit_transactions (user_id, type, amount, reason, generation_id, balance_after)
       VALUES ($1, $2, $3, 'generation', $4, $5)`,
      [userId, creditType, -amount, generationId, remaining]
    );
    return remaining;
  }

  const usedCol = creditType === 'video' ? 'video_used' : 'image_used';
  const quotaCol = creditType === 'video' ? 'video_quota' : 'image_quota';

  // If agency is in unlimited mode (quota >= 999999), skip the atomic check
  // — just increment usage for analytics tracking without enforcement
  const agency = await queryOne('SELECT image_quota, video_quota FROM agency LIMIT 1');
  const isUnlimited = agency && agency[quotaCol] >= 999999;
  clearAgencyCache(); // usage about to change — drop cached image_used/video_used

  if (isUnlimited) {
    await query(
      `UPDATE agency SET ${usedCol} = ${usedCol} + $1, updated_at = NOW() WHERE id = 1`,
      [amount]
    );
    await query(
      `INSERT INTO credit_transactions (user_id, type, amount, reason, generation_id) VALUES ($1, $2, $3, 'generation', $4)`,
      [userId, creditType, -amount, generationId]
    );
    return 999999; // report unlimited remaining
  }

  // Atomic check-and-update: only succeeds if quota allows
  const result = await query(
    `UPDATE agency SET ${usedCol} = ${usedCol} + $1, updated_at = NOW()
     WHERE id = 1 AND ${usedCol} + $1 <= ${quotaCol}
     RETURNING ${quotaCol} - ${usedCol} as remaining`,
    [amount]
  );

  if (result.rowCount === 0) {
    throw new Error('Agency quota exceeded');
  }

  await query(
    `INSERT INTO credit_transactions (user_id, type, amount, reason, generation_id) VALUES ($1, $2, $3, 'generation', $4)`,
    [userId, creditType, -amount, generationId]
  );

  return parseInt(result.rows[0].remaining);
}

/** Refund credits (if task fails) — mirrors deductCredits' billing modes. */
export async function refundCredits(userId, creditType, amount, generationId) {
  // BYOK editions: nothing was enforced at debit time — journal only.
  if (isByok()) {
    await query(
      `INSERT INTO credit_transactions (user_id, type, amount, reason, generation_id) VALUES ($1, $2, $3, 'refund', $4)`,
      [userId, creditType, amount, generationId]
    );
    return;
  }

  const agency = await getAgency();
  if (!agency) return;

  if (billingMode() === 'credits') {
    clearAgencyCache();
    const result = await query(
      `UPDATE agency SET credit_balance = credit_balance + $1, updated_at = NOW()
       WHERE id = $2 RETURNING credit_balance as remaining`,
      [amount, agency.id]
    );
    await query(
      `INSERT INTO credit_transactions (user_id, type, amount, reason, generation_id, balance_after)
       VALUES ($1, $2, $3, 'refund', $4, $5)`,
      [userId, creditType, amount, generationId, parseInt(result.rows[0]?.remaining) || null]
    );
    return;
  }

  const usedCol = creditType === 'video' ? 'video_used' : 'image_used';
  clearAgencyCache();

  await query(
    `UPDATE agency SET ${usedCol} = GREATEST(0, ${usedCol} - $1), updated_at = NOW() WHERE id = $2`,
    [amount, agency.id]
  );

  await query(
    `INSERT INTO credit_transactions (user_id, type, amount, reason, generation_id) VALUES ($1, $2, $3, 'refund', $4)`,
    [userId, creditType, amount, generationId]
  );
}

/**
 * Manual credit top-up / adjustment by the platform operator (bank transfer
 * received → credits allocated). `amount` may be negative for corrections but
 * the balance never goes below zero. Journaled as purchase|adjustment against
 * the bootstrap admin (credit_transactions.user_id is NOT NULL).
 */
export async function adjustCreditBalance(amount, note = null) {
  const admin = await queryOne(`SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`);
  if (!admin) throw new Error('No admin user to attribute the transaction to');

  clearAgencyCache();
  const result = await query(
    `UPDATE agency SET credit_balance = GREATEST(0, credit_balance + $1), updated_at = NOW()
     WHERE id = 1 RETURNING credit_balance as balance`,
    [amount]
  );
  if (result.rowCount === 0) throw new Error('Agency row not found');
  const balance = parseInt(result.rows[0].balance);

  await query(
    `INSERT INTO credit_transactions (user_id, type, amount, reason, balance_after, note)
     VALUES ($1, 'credit', $2, $3, $4, $5)`,
    [admin.id, amount, amount >= 0 ? 'purchase' : 'adjustment', balance, note]
  );
  return balance;
}

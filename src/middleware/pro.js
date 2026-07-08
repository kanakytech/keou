/**
 * requirePro — gate routes behind an active Keou Pro subscription.
 * Must be chained AFTER requireAuth (reads req.user.id).
 *
 * A user is "active Pro" iff users.plan = 'pro' AND pro_period_end is in
 * the future (or null for legacy/grandfathered Pro accounts).
 */

import { queryOne } from '../db.js';

export async function requirePro(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  try {
    const u = await queryOne(
      'SELECT plan, pro_period_end FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!u || u.plan !== 'pro') {
      return res.status(402).json({
        error: 'Keou Pro required',
        upgradeUrl: 'https://keou.systems/pro',
        currentPlan: u?.plan || 'free',
      });
    }
    if (u.pro_period_end && new Date(u.pro_period_end) < new Date()) {
      return res.status(402).json({
        error: 'Keou Pro subscription expired',
        upgradeUrl: 'https://keou.systems/pro',
        expiredAt: u.pro_period_end,
      });
    }
    next();
  } catch (e) {
    console.error('[PRO] middleware error:', e);
    res.status(500).json({ error: 'Plan check failed' });
  }
}

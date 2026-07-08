import { config } from '../config.js';

/**
 * Gate for enterprise-only surface. In the opensource edition the platform
 * ships the basic studio only (image + video generation, BYOK) — everything
 * else (tools, team, admin, analytics, history, packs, …) answers 404 so the
 * routes are indistinguishable from not existing.
 */
export function requireEnterprise(req, res, next) {
  if (config.edition === 'opensource') {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

export function isOpensource() {
  return config.edition === 'opensource';
}

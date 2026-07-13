import { config } from '../config.js';

/**
 * Edition gates.
 *
 * opensource — limited self-host/demo build: basic studio only (image + video,
 *   BYOK), everything else answers 404 so the routes are indistinguishable
 *   from not existing.
 * community  — hosted free tier: real accounts (public signup), the full
 *   creative suite is unlocked, generation is BYOK (the visitor's own
 *   provider key rides each request; platform keys are never touched).
 *   Operator/cost surfaces (assistant, billing, keys, platform) stay off.
 * enterprise — everything.
 */

/** 404 unless the full enterprise platform is running. Use for surfaces that
 *  spend the operator's money (assistant/chat) or manage the paid deployment
 *  (billing, provider keys, platform top-ups). */
export function requireEnterprise(req, res, next) {
  if (config.edition !== 'enterprise') {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

/** 404 only in the opensource edition. Use for product features that are
 *  free in the hosted community tier (history, projects, tools, share, …) —
 *  they are all per-user scoped and run on the caller's own provider key. */
export function requireMembership(req, res, next) {
  if (config.edition === 'opensource') {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

export function isOpensource() {
  return config.edition === 'opensource';
}

export function isCommunity() {
  return config.edition === 'community';
}

/** BYOK editions: the caller supplies the provider key on every request and
 *  the platform's own keys must never be used or billed. */
export function isByok() {
  return config.edition === 'opensource' || config.edition === 'community';
}

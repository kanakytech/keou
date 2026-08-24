import { config } from '../config.js';

/**
 * Edition gates.
 *
 * Keou is open source. Every creative feature ships in every edition — the
 * only thing an edition changes is who pays the provider.
 *
 * opensource — self-hosted. The complete studio: image, video, polish, remix,
 *   format adapt, export packs, TTS, SFX, upscaling, history, projects,
 *   tools, sharing, teams, the assistant. BYOK: you wire your own provider
 *   key and pay the provider directly. No billing, no quotas, no ceiling.
 * community  — the same complete studio, hosted by us at studio.kanaky.xyz so
 *   nobody has to deploy anything. Still BYOK: the visitor's own provider key
 *   rides each request and our keys are never touched.
 * enterprise — identical feature set, plus the commercial plumbing we run for
 *   managed deployments: prepaid credit billing and operator top-ups.
 *
 * Historical note: polish/remix/adapt/packs and the production prompt stack
 * used to be withheld from the open-source edition as an upgrade funnel. That
 * funnel is gone. Paid work is now bespoke builds, not withheld features.
 */

/** 404 unless the commercial platform is running. Reserved for surfaces that
 *  exist only to run OUR hosted business — prepaid credit billing and the
 *  operator top-up endpoints. Never use this to gate a product feature. */
export function requireEnterprise(req, res, next) {
  if (config.edition !== 'enterprise') {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

/** Passthrough. Kept so route files read explicitly ("this is a signed-in
 *  product feature") and so the gate has one place to come back to if a
 *  future edition ever needs it. It gates nothing: every edition ships the
 *  complete feature set. */
export function requireMembership(req, res, next) {
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

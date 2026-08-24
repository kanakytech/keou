// Keou — open-source edition: no money changes hands here.
//
// You bring your own provider key and pay the provider directly, so there is
// nothing to price. This module exists only because the generation pipeline
// counts units for its internal quota accounting, and it always counts 1.
//
// The commercial edition replaces this file with a real credit engine
// (per-action costs, prepaid packs). That file stays private because it holds
// our provider costs and margins — not because it holds any feature you are
// missing. Nothing in the studio is gated on it.

export const CREDIT_COSTS = { image: 1, video: { _default: 1 } };

/** Flat: 1 unit per action. Quota accounting only, never money. */
export function creditCost() {
  return 1;
}

export const CREDIT_PACKS = [];

export function publicPricing() {
  return { unit: 'generation', actions: { image: 1, video: {} }, packs: [] };
}

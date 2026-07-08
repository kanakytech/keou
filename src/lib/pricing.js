// Keou open-source edition — no billing. You bring your own provider key and
// pay the provider directly; there is no credit system in this edition.
// (The prepaid credit engine ships with Keou Enterprise — https://keou.systems)

export const CREDIT_COSTS = { image: 1, video: { _default: 1 } };

/** Flat cost: 1 unit per action. Quota accounting only, never money. */
export function creditCost() {
  return 1;
}

export const CREDIT_PACKS = [];

export function publicPricing() {
  return { unit: 'generation', actions: { image: 1, video: {} }, packs: [] };
}

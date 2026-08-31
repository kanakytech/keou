/**
 * Provider Router — picks KIE or Fal based on config
 *
 * Priority: defaultProvider → fallback to whichever has a key
 * API keys: DB settings table first, env var fallback (cached 60s)
 */

import * as kie from './kie.js';
import * as fal from './fal.js';
import * as comfy from './comfy.js';
import { config } from '../../config.js';
import { queryOne } from '../../db.js';
import { decryptKey } from '../../utils/crypto.js';
import { getRequestProviderKey } from '../../utils/requestContext.js';
import { isByok } from '../../middleware/edition.js';

// ─── Provider Selection ───

// Cache default provider from DB (refreshed on clearKeyCache)
let _defaultProviderCache = { value: null, exp: 0 };

export async function getProvider() {
  // Le moteur local prime quand l'exploitant l'a EXPLICITEMENT configuré
  // (URL posée + préférence 'local') — y compris en édition BYOK : un
  // self-host community avec son ComfyUI n'a aucune raison d'exiger une clé
  // cloud pour générer des images. Sur l'instance hébergée, LOCAL_ENGINE_URL
  // n'est jamais posée, donc ce chemin est mort par construction.
  if (config.localEngine?.url && config.defaultProvider === 'local') return comfy;

  // On RESPECTE la préférence de l'exploitant : DEFAULT_PROVIDER=fal était
  // ignoré ici, ce qui rendait Fal.ai inatteignable dans toute l'édition
  // publiée alors que le README l'annonce comme fournisseur possible.
  // L'en-tête ne dit pas de quel fournisseur vient la clé — c'est cette
  // variable qui tranche, et elle vaut « kie » par défaut.
  if (isByok()) return config.defaultProvider === 'fal' ? fal : kie;

  // Determine which keys are available (DB or env)
  let hasKie = !!(config.kie?.apiKey || config.kie?.keys?.image);
  let hasFal = !!config.fal?.apiKey;

  // Also check DB for keys
  try {
    if (!hasKie) {
      const row = await queryOne("SELECT value FROM settings WHERE key = 'kie_api_key'");
      if (row?.value) hasKie = true;
    }
    if (!hasFal) {
      const row = await queryOne("SELECT value FROM settings WHERE key = 'fal_api_key'");
      if (row?.value) hasFal = true;
    }
  } catch (err) { console.error('[PROVIDER KEY CHECK]', err.message); }

  // Get default provider preference (DB → env → 'kie')
  let pref = config.defaultProvider || 'kie';
  const now = Date.now();
  if (_defaultProviderCache.value && now < _defaultProviderCache.exp) {
    pref = _defaultProviderCache.value;
  } else {
    try {
      const row = await queryOne("SELECT value FROM settings WHERE key = 'default_provider'");
      if (row?.value) {
        pref = row.value;
        _defaultProviderCache = { value: pref, exp: now + 60_000 };
      }
    } catch (err) { console.error('[PROVIDER PREF]', err.message); }
  }

  if (pref === 'local' && config.localEngine?.url) return comfy;
  if (pref === 'fal' && hasFal) return fal;
  if (pref === 'kie' && hasKie) return kie;

  // Fallback
  if (hasFal) return fal;
  if (hasKie) return kie;

  throw new Error('No API key configured — add your KIE.AI or Fal.ai API key in Settings');
}

// ─── API Key Resolution (DB → env, cached 60s) ───

const _cache = { kie: { key: null, exp: 0 }, fal: { key: null, exp: 0 } };

export async function getProviderApiKey(providerName) {
  if (!['kie', 'fal', 'local'].includes(providerName)) {
    throw new Error(`Unknown provider: ${providerName}`);
  }

  // Le moteur local n'a pas de clé : le « fournisseur » est la machine de
  // l'exploitant. On retourne une chaîne vide plutôt que de jeter — le
  // poller et les routes traitent la clé comme un opaque qu'ils repassent
  // au module provider, qui l'ignore.
  if (providerName === 'local') return '';

  // BYOK editions: the only accepted key is the one the caller sent on this
  // request (X-Provider-Key). Nothing is read from DB/env and nothing is
  // cached — keys from different visitors must never bleed into each other.
  if (isByok()) {
    // La clé du visiteur prime toujours. C'est la garantie du produit : sur
    // l'instance hébergée, aucune clé serveur n'est configurée, donc seule
    // celle du visiteur est jamais utilisée.
    const key = getRequestProviderKey();
    if (key) return key;

    // Repli explicite pour un déploiement PRIVÉ. Sans lui, KIE_API_KEY était
    // documentée mais morte, et le poller ne pouvait clore aucune tâche —
    // la documentation promettait donc quelque chose que le code ne faisait pas.
    // Un opérateur qui pose sa propre clé sur son propre serveur choisit
    // sciemment de payer pour ses utilisateurs ; le démarrage le lui rappelle.
    const envKey = providerName === 'fal' ? config.fal?.apiKey : config.kie?.apiKey;
    if (envKey) return envKey;

    const nom = providerName === 'fal' ? 'Fal.ai' : 'KIE.AI';
    throw new Error(`API key required — paste your ${nom} key in the studio to generate`);
  }

  const now = Date.now();
  const c = _cache[providerName];
  if (c && c.key && now < c.exp) return c.key;

  // Try DB settings table
  const settingsKey = providerName === 'fal' ? 'fal_api_key' : 'kie_api_key';
  try {
    const row = await queryOne('SELECT value FROM settings WHERE key = $1', [settingsKey]);
    if (row?.value) {
      const decrypted = decryptKey(row.value);
      _cache[providerName] = { key: decrypted, exp: now + 60_000 };
      return decrypted;
    }
  } catch (err) { console.error('[PROVIDER DB KEY]', err.message); }

  // Fallback to env
  let key;
  if (providerName === 'fal') {
    key = config.fal?.apiKey;
  } else {
    key = config.kie?.apiKey || config.kie?.keys?.image || config.kie?.keys?.video;
  }

  if (!key) throw new Error(`${providerName.toUpperCase()} API key not configured — go to Dashboard → Settings or set env var`);

  _cache[providerName] = { key, exp: now + 60_000 };
  return key;
}

/** Clear cache (useful when admin updates key or provider in settings) */
export function clearKeyCache() {
  _cache.kie = { key: null, exp: 0 };
  _cache.fal = { key: null, exp: 0 };
  _defaultProviderCache = { value: null, exp: 0 };
}

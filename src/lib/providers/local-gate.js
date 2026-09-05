/**
 * Local Engine Gate — la porte entre le studio et une machine de rendu
 *
 * `comfy.js` sait PARLER à ComfyUI. Ce module décide QUAND on lui parle.
 *
 * Sans lui, `getProvider()` rendait le moteur local dès que l'URL était
 * posée — sans jamais vérifier que la machine répond. Une box éteinte, un
 * pod serverless froid, un réseau coupé : chaque génération partait vers une
 * adresse morte et échouait. La sonde existait déjà (`probeLocalEngine`),
 * mais elle ne tournait qu'au démarrage : le serveur apprenait l'état de la
 * machine une fois, puis ne le revérifiait plus jamais côté routage.
 *
 * Trois garanties, dans cet ordre :
 *
 *  1. LE GATE NE BLOQUE JAMAIS. `isLocalUsable()` lit un verdict mémoïsé et
 *     répond en 0 ms. Quand le verdict est périmé, on sert l'ancien et on
 *     resonde EN ARRIÈRE-PLAN. Une machine morte ne doit jamais ajouter 30 s
 *     de latence à une requête utilisateur — c'est exactement le piège qu'on
 *     évite en ne sondant jamais dans le chemin critique.
 *
 *  2. ON N'INSISTE PAS SUR UN CADAVRE. Backoff exponentiel : 5 s après le
 *     premier échec, jusqu'à 2 min quand la machine est franchement morte.
 *     Un succès remet le compteur à zéro.
 *
 *  3. UNE PANNE EN COURS DE JOB COMPTE. `trackFailures()` enveloppe le
 *     module provider : si une action échoue pour cause de réseau, la box
 *     est marquée injoignable IMMÉDIATEMENT, sans attendre la prochaine
 *     sonde. L'erreur continue de remonter telle quelle — on n'invente
 *     aucun retry, on ne rejoue rien, on ne facture rien deux fois. On
 *     apprend juste plus vite, pour la requête SUIVANTE.
 *
 * Ce module ne connaît RIEN aux éditions ni aux clés : il répond « la
 * machine est-elle debout ? ». C'est `providers/index.js` qui décide quoi
 * faire de la réponse — replier sur le cloud ou refuser net.
 */

import { config } from '../../config.js';
import { probeLocalEngine } from './comfy.js';

// Durée de vie d'un verdict POSITIF. 30 s par défaut : assez court pour
// repérer une box qui tombe, assez long pour ne pas sonder à chaque
// génération d'une rafale. Réglable — un endpoint serverless qui s'éteint
// tout seul mérite plus court qu'une machine allumée en permanence.
const okTtl = () => config.localEngine?.probeTtlMs || 30_000;

// Backoff sur échec : 5 s, 10 s, 20 s… plafonné à 2 min.
const FAIL_TTL_BASE = 5_000;
const FAIL_TTL_MAX = 120_000;

// Erreurs qui signifient « la machine ne répond pas ». Tout le reste (modèle
// absent, graphe invalide, prompt refusé) prouve au contraire qu'elle répond :
// ça ne doit PAS la faire passer pour éteinte, sinon /api/engine ment.
const RESEAU = /unreachable|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ECONNRESET|socket hang up|aborted|fetch failed|ComfyUI 50[234]/i;

// Les actions dont l'échec réseau vaut un signal. `calculateCost` et les
// helpers synchrones n'ont rien à dire sur la santé de la machine.
const ACTIONS_SUIVIES = new Set([
  'generateImage', 'textToImage', 'polish', 'remix', 'adapt',
  'upscaleImage', 'generateVideo', 'pollTask',
]);

let _etat = { configured: false, reachable: false, probedAt: 0 };
let _exp = 0;
let _echecs = 0;
let _enCours = null;

function configure() {
  return !!config.localEngine?.url;
}

/**
 * Sonde la machine et met l'état à jour. Déduplique les appels concurrents :
 * dix requêtes qui arrivent ensemble sur un cache périmé ne déclenchent
 * qu'une seule sonde.
 *
 * @returns {Promise<object>} l'état après sondage
 */
export async function refreshLocalEngine() {
  if (!configure()) {
    _etat = { configured: false, reachable: false, probedAt: Date.now() };
    _exp = Date.now() + okTtl();
    return _etat;
  }
  if (_enCours) return _enCours;

  _enCours = (async () => {
    let etat;
    try {
      etat = await probeLocalEngine();
    } catch (err) {
      // probeLocalEngine avale déjà ses erreurs, mais on ne parie pas
      // l'orchestration entière sur cette promesse.
      etat = { configured: true, reachable: false, error: err?.message || 'probe failed' };
    }

    const maintenant = Date.now();
    _etat = { ...etat, probedAt: maintenant };

    if (etat.reachable) {
      if (_echecs > 0) {
        console.log(`  [LOCAL GATE] moteur local de nouveau joignable @ ${config.localEngine.url}`);
      }
      _echecs = 0;
      _exp = maintenant + okTtl();
    } else {
      _echecs += 1;
      const ttl = Math.min(FAIL_TTL_BASE * 2 ** (_echecs - 1), FAIL_TTL_MAX);
      _exp = maintenant + ttl;
      console.warn(
        `  [LOCAL GATE] moteur local injoignable @ ${config.localEngine.url} — ` +
        `${etat.error || 'pas de réponse'} (échec ${_echecs}, prochaine sonde dans ${Math.round(ttl / 1000)} s)`
      );
    }
    return _etat;
  })().finally(() => { _enCours = null; });

  return _enCours;
}

/**
 * La porte. Ne bloque jamais, ne jette jamais.
 *
 * Verdict frais → on répond. Verdict périmé → on répond avec l'ANCIEN et on
 * resonde en arrière-plan. Aucun verdict du tout (le serveur n'a pas encore
 * sondé au boot) → on sonde pour de vrai, une seule fois : c'est le seul
 * moment où cet appel peut attendre.
 *
 * @returns {Promise<boolean>}
 */
export async function isLocalUsable() {
  if (!configure()) return false;

  const maintenant = Date.now();

  // Premier appel de la vie du process : il faut bien un verdict.
  if (!_etat.probedAt) {
    const etat = await refreshLocalEngine();
    return !!etat.reachable;
  }

  if (maintenant >= _exp) {
    // Périmé : on rafraîchit derrière et on sert l'ancien verdict tout de
    // suite. `void` est délibéré — personne n'attend cette promesse.
    void refreshLocalEngine();
  }

  return !!_etat.reachable;
}

/**
 * Signale un échec constaté PENDANT un job. Seules les erreurs réseau font
 * basculer l'état : une erreur « checkpoint absent » prouve que la machine
 * répond, donc elle reste joignable — on garde juste la trace.
 */
export function noteLocalFailure(err) {
  if (!configure()) return;
  const message = err?.message || String(err || '');
  if (!RESEAU.test(message)) {
    _etat = { ..._etat, lastError: message };
    return;
  }
  const maintenant = Date.now();
  _echecs += 1;
  _etat = { ..._etat, configured: true, reachable: false, error: message, probedAt: maintenant };
  _exp = maintenant + Math.min(FAIL_TTL_BASE * 2 ** (_echecs - 1), FAIL_TTL_MAX);
  console.warn(`  [LOCAL GATE] panne en cours de job — moteur local marqué injoignable : ${message}`);
}

/** Une action a abouti : la machine est vivante, on repart de zéro. */
export function noteLocalSuccess() {
  if (!configure() || _etat.reachable) return;
  _etat = { ..._etat, configured: true, reachable: true, error: undefined };
  _echecs = 0;
  _exp = Date.now() + okTtl();
}

/**
 * Enveloppe un module provider pour que ses pannes réseau nourrissent le
 * gate. Ne change AUCUN comportement observable : les erreurs remontent
 * inchangées, rien n'est rejoué. On ne fait qu'écouter.
 */
export function trackFailures(mod) {
  return new Proxy(mod, {
    get(cible, prop, recepteur) {
      const valeur = Reflect.get(cible, prop, recepteur);
      if (typeof valeur !== 'function' || !ACTIONS_SUIVIES.has(prop)) return valeur;
      return async function (...args) {
        try {
          const resultat = await valeur.apply(cible, args);
          noteLocalSuccess();
          return resultat;
        } catch (err) {
          noteLocalFailure(err);
          throw err;
        }
      };
    },
  });
}

/** Instantané pour /health, /api/engine et le log de démarrage. */
export function getLocalEngineState() {
  if (!configure()) return { configured: false };
  return {
    ..._etat,
    active: config.defaultProvider === 'local',
    fallback: !!config.localEngine.fallback,
    failStreak: _echecs,
    nextProbeIn: Math.max(0, _exp - Date.now()),
  };
}

/** Remet le gate à neuf — l'admin qui change l'URL ou le provider par défaut. */
export function clearLocalGateCache() {
  _etat = { configured: configure(), reachable: false, probedAt: 0 };
  _exp = 0;
  _echecs = 0;
}

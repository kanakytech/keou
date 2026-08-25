/**
 * Limiteur de débit en mémoire, sans Redis.
 *
 * ─── Pourquoi ce fichier a été réécrit le 25/08/2026 ───
 *
 * Le studio anonyme rendait « Too many requests » à des visiteurs qui n'avaient
 * rien demandé de déraisonnable : un lot de cinq variantes suffisait. La cause
 * n'était pas la limite, c'était la CLÉ du compteur.
 *
 * `req.ip` derrière Railway ne vaut l'adresse du visiteur que si `trust proxy`
 * correspond EXACTEMENT au nombre de proxys traversés. Le serveur pose 1, en
 * supposant une seule couche ; la topologie réelle en compte davantage, si bien
 * que `req.ip` rendait une adresse interne — LA MÊME pour tout le monde. Le
 * commentaire de server.js:43 décrivait déjà précisément ce risque : « all users
 * share one rate-limit bucket ». C'est ce qui se produisait : n'importe quel
 * visiteur consommait le budget de tous les autres, et les bloquait dix minutes.
 *
 * On ne devine donc plus la profondeur du proxy : on lit la PREMIÈRE entrée de
 * X-Forwarded-For, celle que le premier proxy a inscrite, c'est-à-dire le
 * client. Cette valeur est falsifiable par un client qui envoie son propre
 * en-tête — mais falsifier ne donne rien d'autre que le droit de contourner SA
 * PROPRE limite, et le vrai garde-fou de charge est ailleurs : la file d'essai
 * borne les travaux simultanés et la taille totale. Un compteur juste pour tous
 * vaut mieux qu'un compteur infalsifiable qui punit les innocents.
 */

const windows = new Map(); // clé → { count, resetAt }

// Un seul minuteur de ménage pour toutes les instances de limiteur.
let _cleanupStarted = false;
function ensureCleanup() {
  if (_cleanupStarted) return;
  _cleanupStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of windows) {
      if (now > entry.resetAt) windows.delete(key);
    }
  }, 5 * 60 * 1000).unref();
}

/** Une adresse qui ressemble à une IPv4 ou une IPv6, sans prétendre valider. */
const RESSEMBLE_A_UNE_IP = /^[0-9a-fA-F:.]{3,45}$/;

/**
 * L'adresse du visiteur, telle que le premier proxy l'a vue.
 *
 * X-Forwarded-For s'écrit « client, proxy1, proxy2 » : la première entrée est
 * l'origine. On la préfère à `req.ip`, qui dépend d'un réglage `trust proxy`
 * que personne ne peut garder exact quand la plateforme change sa topologie.
 */
export function clientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const premier = xff.split(',')[0].trim();
    if (RESSEMBLE_A_UNE_IP.test(premier)) return premier;
  }
  return req.ip || req.connection?.remoteAddress || 'inconnu';
}

/**
 * @param {number} maxRequests  requêtes autorisées dans la fenêtre
 * @param {number} windowMs     durée de la fenêtre
 * @param {string} [nom]        nom du seau, renvoyé au client quand il bloque —
 *                              sans lui, un 429 ne dit pas QUELLE limite a joué,
 *                              et le diagnostic prend une heure au lieu d'une
 *                              minute.
 */
export function rateLimit(maxRequests = 10, windowMs = 15 * 60 * 1000, nom = null) {
  ensureCleanup();

  // Préfixe unique par instance de limiteur, pour éviter les collisions de clé.
  const prefix = `rl_${maxRequests}_${windowMs}_`;

  return (req, res, next) => {
    const key = prefix + clientIp(req);
    const now = Date.now();
    let entry = windows.get(key);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      windows.set(key, entry);
    }

    entry.count++;

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - entry.count));

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        error: nom
          ? `Trop de requêtes (${nom}) — réessayez dans ${retryAfter} s.`
          : `Trop de requêtes — réessayez dans ${retryAfter} s.`,
        retryAfter,
        ...(nom ? { limite: nom } : {}),
      });
    }

    next();
  };
}

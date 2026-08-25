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
 * Adresse d'infrastructure : celle d'un proxy, pas celle d'un visiteur.
 * Couvre les plages privées IPv4, la boucle locale, le lien-local et les
 * adresses uniques locales IPv6 — plus la forme « ::ffff:10.0.0.1 » que
 * Node rend sur une pile double.
 */
function estInterne(ip) {
  const a = ip.toLowerCase().replace(/^::ffff:/, '');
  return (
    a === '::1' || a === 'localhost'
    || /^127\./.test(a)
    || /^10\./.test(a)
    || /^192\.168\./.test(a)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(a)
    || /^169\.254\./.test(a)
    || /^f[cd][0-9a-f]{2}:/.test(a)
    || /^fe80:/.test(a)
  );
}

/** Au-delà, l'en-tête est fabriqué : on ne le lit pas plus loin. */
const MAX_MAILLONS = 20;

/**
 * L'adresse du visiteur — celle qu'un proxy de confiance a inscrite.
 *
 * ─── Deux erreurs successives, et pourquoi celle-ci est la bonne ───
 *
 * 1) On a d'abord fait confiance à `req.ip`, qui dépend d'un réglage
 *    `trust proxy` devant correspondre EXACTEMENT au nombre de proxys
 *    traversés. La topologie réelle en comptait davantage : `req.ip` rendait
 *    une adresse interne, LA MÊME pour tout le monde, et un visiteur consommait
 *    le budget de tous les autres. C'est ce qui a produit les « Too many
 *    requests » du 25/08 sur un simple lot de cinq images.
 *
 * 2) On a alors lu la PREMIÈRE entrée de X-Forwarded-For. C'était pire, et
 *    mesuré : cette entrée est écrite par le CLIENT. Une seule machine qui la
 *    change à chaque requête a fait passer 63 générations d'affilée et rempli
 *    la file — après quoi tout visiteur honnête recevait « réessayez dans
 *    trente minutes ». Un studio public fermable depuis un seul poste.
 *
 * L'en-tête s'écrit « client, proxy1, proxy2 » : chaque proxy AJOUTE À DROITE
 * l'adresse dont il a reçu la requête. Tout ce qu'un attaquant fabrique se
 * retrouve donc forcément À GAUCHE de ce que notre proxy a inscrit. On lit
 * l'en-tête EN PARTANT DE LA DROITE et on retient la première adresse publique
 * : les maillons d'infrastructure sont sautés, et les valeurs forgées restent
 * hors d'atteinte quel qu'en soit le nombre.
 *
 * Cette lecture ne demande à connaître ni le nombre de proxys ni leurs
 * adresses — c'est précisément ce qui la rend robuste au jour où la plateforme
 * change sa topologie sans prévenir.
 */
export function clientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    /* On garde les DERNIERS maillons, pas les premiers.
     *
     * `split(',', 20)` rend les vingt PREMIERS éléments — c'est-à-dire
     * précisément ceux qu'un client peut fabriquer, puisque les proxys de
     * confiance écrivent à DROITE. Un en-tête de vingt-cinq fausses adresses
     * suffisait donc à faire disparaître le vrai maillon et à rendre la
     * lecture par la droite inopérante : le plafond redevenait contournable.
     * On découpe donc tout, puis on ne conserve que la queue. */
    const bruts = xff.split(',');
    const maillons = bruts.slice(Math.max(0, bruts.length - MAX_MAILLONS)).map((v) => v.trim());
    for (let i = maillons.length - 1; i >= 0; i--) {
      const m = maillons[i];
      if (RESSEMBLE_A_UNE_IP.test(m) && !estInterne(m)) return m;
    }
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

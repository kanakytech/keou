import pg from 'pg';
const { Pool } = pg;

/**
 * SSL config for Postgres.
 * - Railway/Heroku managed Postgres uses internal CAs that don't validate against
 *   public roots. rejectUnauthorized:false is the documented setup for these hosts.
 * - DATABASE_SSL_STRICT=1 lets you opt back into strict CA validation if you bring
 *   your own CA bundle (DATABASE_CA in PEM) — recommended once you outgrow Railway.
 */
function buildSSL() {
  // Le Dockerfile pose NODE_ENV=production. Sans cette échappatoire, le
  // `docker run` documenté ne peut pas joindre un PostgreSQL local sans TLS —
  // le cas le plus courant d'un premier auto-hébergement.
  if (process.env.DATABASE_SSL === '0' || process.env.DATABASE_SSL === 'false') return false;
  if (process.env.NODE_ENV !== 'production') return false;
  if (process.env.DATABASE_CA) {
    return { ca: process.env.DATABASE_CA, rejectUnauthorized: true };
  }
  if (process.env.DATABASE_SSL_STRICT === '1') {
    return { rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

/* Deux pannes distinctes se lisaient dans les journaux de production, et
 * chacune avait sa cause.
 *
 * « Connection terminated unexpectedly » — une connexion posée dans le pool et
 * laissée inactive se fait couper par un intermédiaire réseau (Railway, un
 * pare-feu, un NAT). Sans keepalive TCP, personne ne s'en aperçoit : le socket
 * est mort, le pool le croit vivant, et l'erreur ne sort qu'au moment où un
 * visiteur s'en sert. D'où `keepAlive`.
 *
 * « Connection terminated due to connection timeout » — l'ÉTABLISSEMENT de la
 * connexion dépasse le délai. J'ai d'abord accusé la saturation du pool ; un
 * banc l'a réfuté, chaque tâche relâchant sa connexion entre deux requêtes. La
 * base est simplement parfois lente ou brièvement injoignable. Cinq secondes
 * étaient trop courtes pour l'absorber, d'où douze — et surtout, une requête ne
 * doit plus mourir d'un raté d'une seconde : voir la reprise plus bas.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: buildSSL(),
  max: Number(process.env.DATABASE_POOL_MAX) || 16,
  idleTimeoutMillis: 30000,
  // Cinq secondes suffisaient tant que le pool avait de la marge. Sous charge,
  // attendre un peu vaut mieux que rendre une erreur au visiteur.
  connectionTimeoutMillis: 12000,
  // Le socket est sondé régulièrement : une coupure se voit tout de suite et la
  // connexion morte est remplacée, au lieu d'être servie à un visiteur.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  // Cap any individual statement so a runaway query can't pin a connection
  statement_timeout: 30000,
});

/* Une erreur sur un client INACTIF du pool n'interrompt aucune requête : pg
 * jette le client et en ouvrira un autre. On la journalise avec le compte de
 * connexions, parce que le chiffre dit tout de suite s'il s'agit d'une coupure
 * isolée ou d'un pool qui s'effondre. */
pool.on('error', (err) => {
  console.error(`  [DB] connexion inactive perdue : ${err.message} `
    + `(pool : ${pool.totalCount} ouvertes, ${pool.idleCount} libres, ${pool.waitingCount} en attente)`);
});

/* Une reprise, et seulement là où elle ne peut RIEN casser.
 *
 * Les journaux de production montrent deux ratés de connexion : un client
 * inactif coupé par le réseau, et un établissement de connexion qui dépasse le
 * délai. Dans les deux cas la base va très bien une seconde plus tard — mais le
 * cycle du poller mourait entier, et un visiteur recevait une erreur.
 *
 * On ne réessaie que dans deux situations où l'on SAIT qu'aucune instruction n'a
 * pu partir ni s'appliquer :
 *
 *  - « connection timeout » : le pool n'a jamais rendu de client, donc rien n'a
 *    été envoyé. Sûr quelle que soit la requête.
 *  - « terminated unexpectedly » sur une LECTURE seule. Une écriture, elle, a pu
 *    s'appliquer avant que le socket ne tombe : la rejouer créerait un doublon,
 *    et sur ce produit un doublon est une génération facturée deux fois.
 *
 * Une seule reprise, après une courte pause. Au-delà, ce n'est plus un raté de
 * réseau, c'est une base en panne — et il faut le dire, pas l'enterrer.
 */
/* Les formulations réelles d'une connexion perdue, relevées à l'exécution.
 * PostgreSQL, le pilote et le système d'exploitation ne disent pas la même
 * chose : « terminating connection due to administrator command » a été raté par
 * un premier motif trop étroit, sur un banc qui coupait les connexions pour de
 * vrai. On liste donc ce qu'ils disent, pas ce qu'on imagine. */
const RATE_CONNEXION = new RegExp([
  'connection timeout',
  'Connection terminated',
  'terminating connection',
  'server closed the connection',
  'Client has encountered a connection error',
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'socket hang up',
  'read ECONNRESET', 'Connection ended unexpectedly',
].join('|'), 'i');
const ETABLISSEMENT = /connection timeout/i;

/** Une requête qui ne modifie rien peut être rejouée sans risque. */
function estLecture(texte) {
  return /^\s*(?:WITH\b[\s\S]*?\)\s*)?SELECT\b/i.test(String(texte))
    && !/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(String(texte));
}

async function executer(texte, params) {
  try {
    return await pool.query(texte, params);
  } catch (err) {
    const msg = err?.message || '';
    if (!RATE_CONNEXION.test(msg)) throw err;
    const sur = ETABLISSEMENT.test(msg) || estLecture(texte);
    if (!sur) {
      console.error('  [DB] connexion perdue pendant une écriture — pas de reprise :', msg.slice(0, 90));
      throw err;
    }
    console.warn('  [DB] raté de connexion, une reprise :', msg.slice(0, 90));
    await new Promise((r) => setTimeout(r, 250));
    return pool.query(texte, params);
  }
}

/** Run a query — returns full result { rows, rowCount } */
export async function query(text, params) {
  return executer(text, params);
}

/** Run a query — returns first row or null */
export async function queryOne(text, params) {
  const result = await executer(text, params);
  return result.rows[0] || null;
}

/** Run a query — returns all rows */
export async function queryAll(text, params) {
  const result = await executer(text, params);
  return result.rows;
}

export default pool;

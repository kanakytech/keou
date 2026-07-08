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
  if (process.env.NODE_ENV !== 'production') return false;
  if (process.env.DATABASE_CA) {
    return { ca: process.env.DATABASE_CA, rejectUnauthorized: true };
  }
  if (process.env.DATABASE_SSL_STRICT === '1') {
    return { rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: buildSSL(),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // Cap any individual statement so a runaway query can't pin a connection
  statement_timeout: 30000,
});

pool.on('error', (err) => {
  console.error('  [DB] Unexpected pool error:', err.message);
});

/** Run a query — returns full result { rows, rowCount } */
export async function query(text, params) {
  return pool.query(text, params);
}

/** Run a query — returns first row or null */
export async function queryOne(text, params) {
  const result = await pool.query(text, params);
  return result.rows[0] || null;
}

/** Run a query — returns all rows */
export async function queryAll(text, params) {
  const result = await pool.query(text, params);
  return result.rows;
}

export default pool;

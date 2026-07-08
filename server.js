// Keou — open-source edition server.
// Basic studio only: image + video generation, bring-your-own provider key,
// no accounts. The full suite (tools, teams, packs, white-label, credits)
// ships with Keou Enterprise — https://keou.systems
//
// Entry point is index.js, which pins EDITION=opensource before any module
// (and therefore config.js) is evaluated. Do not run this file directly.

import { config } from './src/config.js';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import compression from 'compression';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runMigrations, seedAgency, migrateCampaigns, cleanupSessions, cleanupExpiredGenerations, cleanupExpiredShareLinks } from './src/migrate.js';
import { startPoller, stopPoller } from './src/poller.js';
import { rateLimit } from './src/middleware/rateLimit.js';
import pool from './src/db.js';

// Routes (open-source surface only)
import authRoutes from './src/routes/auth.js';
import generateRoutes from './src/routes/generate.js';
import uploadRoutes from './src/routes/upload.js';
import downloadRoutes from './src/routes/download.js';
import projectRoutes from './src/routes/projects.js';
import campaignRoutes from './src/routes/campaigns.js';
import { requestContext } from './src/utils/requestContext.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Single TLS-terminating proxy (Railway/Fly/nginx). Required for correct
// per-client rate limiting and secure-cookie detection.
app.set('trust proxy', 1);

// ─── Security headers ───
const r2PublicOrigin = (() => {
  try { return config.r2.publicUrl ? new URL(config.r2.publicUrl).origin : null; }
  catch { return null; }
})();
const IMG_SOURCES = [
  "'self'", "data:", "blob:",
  "https://*.kie.ai", "https://*.aiquickdraw.com",
  "https://*.cloudflarestorage.com", "https://*.cloudflare.com",
  "https://*.googleapis.com", "https://*.amazonaws.com",
  "https://*.cloudfront.net", "https://*.r2.dev",
  ...(r2PublicOrigin ? [r2PublicOrigin] : []),
];
const MEDIA_SOURCES = [
  "'self'", "blob:",
  "https://*.kie.ai", "https://*.aiquickdraw.com",
  "https://*.cloudflarestorage.com",
  "https://*.googleapis.com", "https://*.amazonaws.com",
  "https://*.cloudfront.net",
  "https://*.r2.dev",
  ...(r2PublicOrigin ? [r2PublicOrigin] : []),
];

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: IMG_SOURCES,
      mediaSrc: MEDIA_SOURCES,
      connectSrc: ["'self'", "https:", "wss:"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ─── Middleware ───
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true,
  lastModified: true,
}));

// ─── Health check ───
let _healthCache = { ok: false, ts: 0 };
const HEALTH_TTL_MS = 2000;
app.get('/health', async (req, res) => {
  const now = Date.now();
  if (now - _healthCache.ts < HEALTH_TTL_MS) {
    return res.status(_healthCache.ok ? 200 : 503).json(_healthCache.body);
  }
  try {
    const { queryOne } = await import('./src/db.js');
    await queryOne('SELECT 1');
    const body = { ok: true, uptime: process.uptime() };
    _healthCache = { ok: true, ts: now, body };
    res.json(body);
  } catch {
    const body = { ok: false, error: 'Database unavailable' };
    _healthCache = { ok: false, ts: now, body };
    res.status(503).json(body);
  }
});

// ─── Per-request context (carries the caller's provider key) ───
app.use('/api', requestContext);

// ─── Rate limiting ───
app.use('/api/auth', rateLimit(30, 60 * 1000));
app.use('/api/upload', rateLimit(200, 60 * 1000));
app.use('/api', rateLimit(600, 60 * 1000));

// ─── Database ───
async function bootDatabase(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await runMigrations();
      await seedAgency();
      await migrateCampaigns();
      await cleanupSessions();
      await cleanupExpiredGenerations();
      await cleanupExpiredShareLinks();
      return;
    } catch (err) {
      console.error(`  [DB] Migration attempt ${i + 1}/${retries} failed:`, err.message);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 3000));
      else throw err;
    }
  }
}
await bootDatabase();

// ─── Self-seed (no accounts in this edition) ───
// The schema still needs one internal user row (generations, sessions, FK's)
// and a default project. Created automatically with an unusable password —
// nothing to configure.
{
  const { queryOne, query } = await import('./src/db.js');
  const anyUser = await queryOne('SELECT id FROM users LIMIT 1');
  if (!anyUser) {
    const { hashPassword } = await import('./src/utils/hash.js');
    const { randomBytes } = await import('crypto');
    const hash = await hashPassword(randomBytes(32).toString('hex'));
    const u = await queryOne(
      `INSERT INTO users (email, password_hash, name, role, status)
       VALUES ('studio@localhost', $1, 'Studio', 'member', 'active') RETURNING id`,
      [hash]
    );
    const p = await queryOne(
      `INSERT INTO projects (name, description, color, created_by)
       VALUES ('General', 'Default project', '#6B7280', $1) RETURNING id`,
      [u.id]
    );
    await query(
      `INSERT INTO campaigns (project_id, name, description, color, created_by)
       VALUES ($1, 'General', 'Default campaign', '#6B7280', $2)`,
      [p.id, u.id]
    );
    console.log('  [SEED] Local studio user + default project created');
  }
}

// ─── Hourly cleanup ───
const purgeTimer = setInterval(async () => {
  try {
    await cleanupExpiredGenerations();
    await cleanupExpiredShareLinks();
  } catch (err) {
    console.error('  [CLEANUP] Purge error:', err.message);
  }
}, 60 * 60 * 1000);

// ─── Background poller ───
if (process.env.DISABLE_POLLER !== 'true') {
  startPoller();
}

// ─── API routes ───
app.use('/api/auth', authRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/download', downloadRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api', generateRoutes);

// ─── Root: straight to the studio (no accounts in this edition) ───
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'studio.html'));
});

// ─── 404 ───
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Start ───
const server = app.listen(config.port, () => {
  console.log('');
  console.log('  Keou — open-source edition');
  console.log(`  http://localhost:${config.port}`);
  console.log('  [MODE] No accounts — paste your provider API key in the studio');
  console.log('');
});

// ─── Graceful shutdown ───
async function shutdown(signal) {
  console.log(`\n  [SHUTDOWN] ${signal} received`);
  clearInterval(purgeTimer);
  stopPoller();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

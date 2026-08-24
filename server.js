import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import compression from 'compression';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from './src/config.js';
import { runMigrations, seedAgency, migrateCampaigns, cleanupSessions, cleanupExpiredGenerations, cleanupExpiredShareLinks, cleanupStaleEssai } from './src/migrate.js';
import { startPoller, stopPoller } from './src/poller.js';
import { rateLimit } from './src/middleware/rateLimit.js';
import pool from './src/db.js';

// Routes
import authRoutes from './src/routes/auth.js';
import generateRoutes from './src/routes/generate.js';
import uploadRoutes from './src/routes/upload.js';
import downloadRoutes from './src/routes/download.js';
import dashboardRoutes from './src/routes/dashboard.js';
import historyRoutes from './src/routes/history.js';
import profileRoutes from './src/routes/profile.js';
import adminRoutes from './src/routes/admin.js';
import teamRoutes from './src/routes/team.js';
import projectRoutes from './src/routes/projects.js';
import campaignRoutes from './src/routes/campaigns.js';
import activityRoutes from './src/routes/activity.js';
import toolsRoutes from './src/routes/tools.js';
import analyticsRoutes from './src/routes/analytics.js';
import jarvisRoutes from './src/routes/jarvis.js';
import conversationRoutes from './src/routes/conversations.js';
import shareRoutes, { renderSharePage } from './src/routes/share.js';
import keysRoutes from './src/routes/keys.js';
import essaiRoutes from './src/routes/essai.js';
import { requireEnterprise, requireMembership } from './src/middleware/edition.js';
import { requestContext } from './src/utils/requestContext.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Railway terminates TLS at a single proxy layer. Without this, req.ip is the
// proxy's IP for every client — all users share one rate-limit bucket and the
// brute-force protection is inert. Also required for `secure` cookie detection.
app.set('trust proxy', 1);

// Provenance: quiet origin signature on every response.
app.use((_req, res, next) => { res.setHeader('X-Origin-Sig', 'S2FuYWt5IFRlY2ggwrcgaHR0cHM6Ly9rYW5ha3kueHl6IMK3IG9yaWdpbjprZW91'); next(); });

// Une clé fournisseur côté serveur en édition BYOK signifie que l'opérateur
// paie les générations de ses visiteurs. C'est un choix légitime en privé, et
// un accident coûteux en public : on le dit à voix haute au démarrage.
if ((config.edition === 'opensource' || config.edition === 'community')
    && (config.kie?.apiKey || config.fal?.apiKey)) {
  console.warn('  [BYOK] Une clé fournisseur serveur est configurée : CE DÉPLOIEMENT PAIE');
  console.warn('  [BYOK] les générations de ses visiteurs. Retirez KIE_API_KEY / FAL_API_KEY');
  console.warn('  [BYOK] pour que chacun apporte la sienne.');
}

// Le studio vit désormais sous studio.kanaky.xyz — même toit que le reste de
// l'écosystème (myshop.kanaky.xyz, kanaky.xyz). L'ancien domaine reste branché
// sur ce même service et redirige en 301 : les liens déjà partagés continuent
// de marcher, et les moteurs suivent le déménagement sans perdre l'indexation.
app.use((req, res, next) => {
  if (req.hostname === 'studio.keou.systems') {
    return res.redirect(301, `https://studio.kanaky.xyz${req.originalUrl}`);
  }
  next();
});

// ─── Security Headers (helmet) ───
// Build CSP img/media allowlist — include the client's R2 public domain dynamically
// so custom domains like "assets.client.com" work without hardcoding them.
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
  "https://*.cloudfront.net", "https://*.elevenlabs.io",
  "https://*.r2.dev",
  ...(r2PublicOrigin ? [r2PublicOrigin] : []),
];

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],   // Allow onclick=, onmouseenter=, etc.
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: IMG_SOURCES,
      mediaSrc: MEDIA_SOURCES,
      frameSrc: ["'self'", "https://streamable.com"],
      connectSrc: ["'self'", "https:", "wss:"],
    },
  },
  // HSTS — Railway terminates TLS at its proxy; with `trust proxy` set, helmet
  // still emits the header on every response and the browser pins HTTPS for a
  // year. No `preload` (irreversible commitment) — submit to hstspreload.org
  // deliberately if ever wanted.
  hsts: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginEmbedderPolicy: false, // Allow loading CDN images
}));

// Permissions-Policy — helmet does not set it. Deny powerful browser features
// the app never uses; a compromised script can't silently reach the camera,
// microphone, location or payment APIs.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=()');
  next();
});

if (r2PublicOrigin) console.log(`  [CSP] R2 public domain allowed: ${r2PublicOrigin}`);

// ─── Middleware ───
app.use(compression());          // gzip/brotli — 60-70% smaller responses
app.use(cookieParser());

// Stripe webhook MUST receive the raw body to verify the signature.
// This route is mounted BEFORE express.json() so the body remains a Buffer.
// Billing webhook: commercial deployments only — not part of the open-source edition.

app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0, // Cache static assets 1h in prod, no cache in dev
  etag: true,                    // ETag for conditional requests (304 Not Modified)
  lastModified: true,            // Last-Modified headers
  // Only the community edition serves the marketing landing at "/". Enterprise
  // (white-label client instances) and opensource fall through to the explicit
  // root handler below (login page / studio).
  index: config.edition === 'community' ? 'index.html' : false,
}));

// ─── Demo video redirect (presigned R2 URL, always fresh) ───
app.get('/api/demo-video', async (req, res) => {
  try {
    const { getPresignedUrl } = await import('./src/lib/r2.js');
    const url = await getPresignedUrl('assets/demo-production-engine.mp4', 3600); // 1h TTL
    res.redirect(302, url);
  } catch {
    res.status(404).json({ error: 'Demo video not available' });
  }
});

// ─── Health check (no auth, no rate limit) ───
// Cached 2s to prevent DOS via repeated DB pings (Railway probes us every 30s,
// but external uptime monitors and containers can hit this much more often).
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

// ─── Per-request context (BYOK provider key in opensource edition) ───
app.use('/api', requestContext);

// ─── Rate limiting per route category ───
app.use('/api/auth', rateLimit(15, 60 * 1000));        // auth: strict
app.use('/api/upload', rateLimit(200, 60 * 1000));      // uploads: supports batch studio (30+ images)
app.use('/api/jarvis', rateLimit(30, 60 * 1000));       // chat: moderate
app.use('/api/share', rateLimit(20, 60 * 1000));        // share create / list / delete (auth)
app.use('/api/platform', rateLimit(30, 60 * 1000));     // operator endpoints: strict
// Essai communautaire (anonyme) — generer très strict par IP, signaler modéré ;
// statut/galerie/image retombent sur le bucket générique /api ci-dessous.
app.use('/api/essai/generer', rateLimit(5, 10 * 60 * 1000));
app.use('/api/essai/signaler', rateLimit(10, 60 * 1000));
// Studio anonyme — uploads sources et lancements d'opérations (POST) limités
// par IP ; le polling GET /studio/status retombe sur le bucket générique /api.
// La file essai (ESSAI_MAX_PER_IP) reste le garde-fou dur de concurrence.
app.use('/api/essai/upload', rateLimit(20, 10 * 60 * 1000));
const essaiStudioLimit = rateLimit(30, 10 * 60 * 1000);
app.use('/api/essai/studio', (req, res, next) => (req.method === 'POST' ? essaiStudioLimit(req, res, next) : next()));
// Public share consumption — separate strict bucket to prevent token enum + view_count spam
app.get('/share/:token', rateLimit(30, 60 * 1000));
app.use('/api', rateLimit(600, 60 * 1000));              // everything else: batch polling-safe (30 jobs × 8s polls)

// ─── Database (with retry) ───
async function bootDatabase(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await runMigrations();
      await seedAgency();
      await migrateCampaigns();
      await cleanupSessions();
      await cleanupExpiredGenerations();
      await cleanupExpiredShareLinks();
      await cleanupStaleEssai();
      return;
    } catch (err) {
      console.error(`  [DB] Migration attempt ${i + 1}/${retries} failed:`, err.message);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 3000));
      else throw err;
    }
  }
}
await bootDatabase();

// ─── Auto-purge expired generations every hour ───
const purgeTimer = setInterval(async () => {
  try {
    await cleanupExpiredGenerations();
    await cleanupExpiredShareLinks();
  } catch (err) {
    console.error('  [CLEANUP] Purge error:', err.message);
  }
}, 60 * 60 * 1000);

// ─── Background Poller ───
// La documentation dit « DISABLE_POLLER=1 » à quatre endroits. Le code
// n'acceptait que 'true' : un opérateur qui suivait la doc lançait donc un
// poller sur CHAQUE réplique, doublait ses appels fournisseur et brûlait ses
// crédits — l'accident exact que la doc prétendait éviter. On accepte les deux.
const _pollerOff = process.env.DISABLE_POLLER;
if (_pollerOff !== 'true' && _pollerOff !== '1') {
  startPoller();
}

// ─── API Routes ───
app.use('/api/auth', authRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/download', downloadRoutes);
// Product surfaces — free in the community edition (per-user scoped, BYOK).
app.use('/api/dashboard', requireMembership, dashboardRoutes);
app.use('/api/history', requireMembership, historyRoutes);
app.use('/api/profile', requireMembership, profileRoutes);
app.use('/api/admin', requireMembership, adminRoutes);
app.use('/api/team', requireMembership, teamRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/activity', requireMembership, activityRoutes);
app.use('/api/tools', requireMembership, toolsRoutes);
app.use('/api/analytics', requireMembership, analyticsRoutes);
app.use('/api/share', requireMembership, shareRoutes);
app.use('/api/keys', requireMembership, keysRoutes);
// L'assistant est une fonctionnalité produit, pas une surface commerciale : il
// tourne sur la clé Anthropic du déploiement (la nôtre chez nous, la sienne en
// auto-hébergé) et rend une erreur explicite quand aucune clé n'est configurée.
app.use('/api/jarvis', jarvisRoutes);
app.use('/api/conversations', conversationRoutes);
// /api/billing and /api/platform run our hosted commercial instance and are
// not part of the open-source edition. Everything else above ships in full.
// Essai communautaire — anonyme (BYOK par requête), édition community uniquement
// (le gate 404 vit dans la route). La clé du visiteur transite via X-Provider-Key
// (requestContext, déjà monté sur /api) et n'est jamais persistée.
app.use('/api/essai', essaiRoutes);

// ─── « Launch Keou » — entrée propre vers l'expérience anonyme ───
// URL marketing stable → LE STUDIO COMPLET (studio.html), sans compte : la page
// détecte l'absence de session en édition community et bascule en mode anonyme
// BYOK (adaptateur /shared/anon.js → endpoints /api/essai/studio/*). Un visiteur
// déjà connecté retrouve son studio normal. L'ancienne page /essai.html reste
// servie directement (galerie communautaire + essai texte→image).
// Servie dans TOUTES les éditions : c'est l'appel à l'action principal de la
// page d'accueil, qui est désormais publiée. L'expérience anonyme, elle, reste
// bornée à community — mais côté client : AnonMode.tryInstall() lit
// /api/auth/agency, voit une édition qui n'est pas community et rend false, puis
// Auth.guard() renvoie au login. Un 404 ici casserait le bouton « Launch Keou »
// de tout déploiement auto-hébergé.
app.get('/launch', (req, res) => {
  // La redirection perdait la chaîne de requête : un lien partagé en
  // « /launch?lang=fr » atterrissait en anglais, sans que rien ne le signale.
  // On ne recopie que les paramètres connus — recopier aveuglément ferait de
  // cette route un relais de paramètres arbitraires.
  const garde = new URLSearchParams();
  for (const clef of ['lang', 'ref', 'utm_source', 'utm_medium', 'utm_campaign']) {
    const v = req.query[clef];
    if (typeof v === 'string' && v.length <= 64) garde.set(clef, v);
  }
  const q = garde.toString();
  res.redirect(302, '/studio.html' + (q ? '?' + q : ''));
});

// Public-facing clean share URL with server-rendered OG meta (social preview cards).
// Must come after express.static — static is mounted earlier, so /share.html keeps
// working as a file, while /share/<token> hits this route.
app.get('/share/:token', renderSharePage);
app.use('/api', generateRoutes);

// ─── SPA Fallback ───
// Enterprise ET opensource : la racine est la page de connexion. L'édition
// open source servait le studio directement, du temps où elle délivrait une
// session sans identifiant ; cette session a été retirée pour raison de
// sécurité. Servir le studio à la racine donnait depuis une page vide sans
// message ni lien de retour, car redirectToLogin() s'abstient sur « / ».
// Le studio anonyme reste atteignable par /launch.
// Community : produit public — la racine est la page d'accueil.
app.get('/', (req, res) => {
  const page = config.edition === 'community' ? 'index.html' : 'login.html';
  res.sendFile(join(__dirname, 'public', page));
});

// ─── 404 Handler (unknown API routes) ───
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Global Error Handler ───
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.stack || err.message || err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Unhandled Rejections / Exceptions ───
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  // Give time to flush logs, then exit
  setTimeout(() => process.exit(1), 1000);
});

// ─── Start ───
const PORT = config.port;
const server = app.listen(PORT, () => {
  console.log(`\n  KEOU Agency — B2B Platform`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  [DB] PostgreSQL connected`);
  console.log(`  [AUTH] JWT + refresh cookie`);
  console.log(`  [SEC] Helmet + rate limiting enabled`);
  console.log(`  [PERF] gzip compression + 1h static cache enabled`);
  console.log(`  [ROUTES] auth, generate, upload, download, dashboard, history, profile, admin, team, projects, campaigns, activity, tools, analytics, jarvis\n`);
});

// ─── Graceful Shutdown ───
function gracefulShutdown(signal) {
  console.log(`\n  [SHUTDOWN] ${signal} received — closing gracefully...`);
  stopPoller();
  clearInterval(purgeTimer);
  server.close(async () => {
    await pool.end();              // Drain DB connections
    console.log('  [SHUTDOWN] HTTP server + DB pool closed');
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => {
    console.error('  [SHUTDOWN] Forced exit after timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

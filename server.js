import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import compression from 'compression';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

// Railway termine le TLS derrière ses propres proxys. `trust proxy` reste posé
// pour la détection des cookies `secure` — mais on ne s'y FIE PLUS pour
// identifier un visiteur : la valeur 1 suppose une seule couche, la topologie
// réelle en compte davantage, et req.ip rendait alors une adresse interne
// IDENTIQUE pour tout le monde. Résultat observé le 25/08/2026 : un lot de cinq
// variantes rendait « Too many requests », parce que le budget avait été
// consommé par d'autres visiteurs. Les limiteurs et la file d'essai utilisent
// désormais clientIp() (src/middleware/rateLimit.js), qui lit la première
// entrée de X-Forwarded-For.
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
      // Helmet ajoute upgrade-insecure-requests d'office — WebKit/Safari
      // l'applique même sur localhost (Chrome l'exempte) : en dev http, tous
      // les assets basculaient en https → TLS error → page nue. Prod le garde.
      ...(process.env.NODE_ENV === 'production' ? {} : { upgradeInsecureRequests: null }),
    },
  },
  // HSTS — Railway terminates TLS at its proxy; with `trust proxy` set, helmet
  // still emits the header on every response and the browser pins HTTPS for a
  // year. No `preload` (irreversible commitment) — submit to hstspreload.org
  // deliberately if ever wanted.
  // Coupé hors production : WebKit/Safari honore HSTS même sur localhost
  // (Chrome l'exempte) — un dev qui teste en http://localhost voyait Safari
  // forcer https sur styles.css/auth.js → TLS error → page nue. Vécu le 01/09.
  hsts: process.env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
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
  // Aucune édition ne sert de page d'index automatiquement : c'est la route
  // explicite plus bas qui décide de ce qu'est la racine. Depuis le 02/09 la
  // racine community est LE STUDIO, pas la page de présentation — un visiteur
  // qui arrive doit tomber dans l'outil, pas devant une brochure.
  index: false,
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

// ─── Capacités média du conteneur : sondées UNE fois, au démarrage ───
/*
 * /health ne rendait que { ok, uptime }. Personne, depuis l'extérieur, ne
 * pouvait donc vérifier que ffmpeg tourne VRAIMENT dans le conteneur — alors
 * que le README public promet que la vidéo du studio anonyme sort filigranée,
 * et que cette promesse ne tient qu'à un paquet apt (Dockerfile) qu'un rebuild
 * peut perdre sans un bruit. Quand ffmpeg manque, src/lib/watermark-video.js
 * rend la vidéo NUE, écrit une ligne de log que personne ne lit, et le service
 * continue de répondre « ok ». Une promesse publique invérifiable finit
 * toujours par ne plus être tenue.
 *
 * Sondé une seule fois puis mémorisé : le HEALTHCHECK du conteneur appelle
 * cette route toutes les 30 s, Railway aussi, et les moniteurs externes bien
 * plus souvent — lancer un processus à chaque appel coûterait plus cher que ce
 * qu'on mesure. La sonde part au chargement du module et se termine pendant
 * que la base migre : elle n'ajoute rien au temps de démarrage.
 *
 * Elle ne fait JAMAIS échouer /health : sans ffmpeg le service fonctionne, il
 * filigrane seulement moins. Rendre 503 sortirait l'instance de la rotation
 * pour un badge — exactement le contraire du service qu'on veut rendre.
 *
 * (watermark-video.js a bien son propre test de présence, mais il est privé,
 * paresseux, et ne rend qu'un booléen : on veut ici la version, et on la veut
 * avant la première vidéo plutôt qu'après.)
 */
const mediaCaps = { ffmpeg: null, sharp: null, police: null, filigraneVideoReel: false };

/* Le filigrane vidéo fonctionne-t-il VRAIMENT ?
 *
 * Vérifier que ffmpeg répond et qu'une police existe ne prouve rien : le
 * 26/08, les deux étaient vrais et la vidéo sortait pourtant nue. Le module de
 * filigrane rend la vidéo d'origine dès qu'il échoue — c'est voulu, une vidéo
 * nue vaut mieux qu'une génération perdue — mais cette prudence rend la panne
 * MUETTE. La sonde a donc annoncé « videoWatermark: true » pendant qu'aucune
 * vidéo n'était marquée.
 *
 * On fait donc le vrai geste, une fois au démarrage : une vidéo minuscule
 * fabriquée sur place, passée dans le MÊME chemin que la production, et on
 * regarde si les octets ont changé. Trois cents millisecondes payées une fois
 * pour ne plus jamais annoncer une protection qui n'existe pas.
 */
async function sondeFiligraneVideo() {
  if (mediaCaps.ffmpeg === null) return false;
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: joindre } = await import('node:path');
  let dossier;
  try {
    dossier = await mkdtemp(joindre(tmpdir(), 'keou-sonde-'));
    const temoin = joindre(dossier, 't.mp4');
    await new Promise((resolve, reject) => {
      const c = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'color=c=gray:s=320x180:d=1:r=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', temoin],
        { stdio: 'ignore' });
      const t = setTimeout(() => { c.kill('SIGKILL'); reject(new Error('timeout')); }, 10000);
      c.on('error', (e) => { clearTimeout(t); reject(e); });
      c.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error('ffmpeg ' + code)); });
    });
    const avant = await readFile(temoin);
    const { watermarkVideo } = await import('./src/lib/watermark-video.js');
    const apres = await watermarkVideo(avant);
    return Buffer.isBuffer(apres) && !apres.equals(avant);
  } catch (e) {
    console.warn('[SONDE filigrane vidéo]', (e?.message || 'inconnu').slice(0, 120));
    return false;
  } finally {
    if (dossier) await rm(dossier, { recursive: true, force: true }).catch(() => {});
  }
}

/* La police du filigrane est-elle réellement sur le disque ?
 *
 * Debian minimal n'embarque AUCUNE police. Le filigrane vidéo sortait donc en
 * production comme dix-sept rectangles vides — le glyphe de remplacement — là
 * où il devait lire studio.kanaky.xyz. Vu à l'image sur une vraie génération du
 * 26/08 : la seule protection du travail publié était un rang de carrés, et
 * rien ne le signalait. Le Dockerfile installe maintenant DejaVu ; cette sonde
 * rend l'oubli impossible à commettre en silence une seconde fois.
 */
const CHEMINS_POLICE = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/System/Library/Fonts/Helvetica.ttc',            // poste de développement macOS
];
function sondePolice() {
  for (const c of CHEMINS_POLICE) {
    try { if (existsSync(c)) return c.split('/').pop(); } catch { /* ignore */ }
  }
  return null;
}

/** Version de ffmpeg, ou null s'il est absent / muet / trop lent. */
function probeFfmpeg() {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('ffmpeg', ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null); // binaire introuvable : spawn peut jeter en synchrone
    }
    // Un ffmpeg qui ne rend pas la main en 5 s au « -version » est cassé de
    // toute façon ; on ne retient pas le démarrage du serveur pour lui.
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 5000);
    child.stdout.on('data', (d) => { if (out.length < 200) out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      // « ffmpeg version 6.1.1-3ubuntu5 Copyright (c) … » → « 6.1.1-3ubuntu5 »
      const m = out.match(/^ffmpeg version (\S+)/);
      resolve(m ? m[1] : 'present');
    });
  });
}

/** Version de sharp, même logique : c'est lui qui filigrane les images. */
async function probeSharp() {
  try {
    const { default: sharp } = await import('sharp');
    return sharp?.versions?.sharp || 'present';
  } catch {
    return null; // binaire natif absent ou incompatible : les images sortiront nues
  }
}

const mediaProbe = (async () => {
  mediaCaps.ffmpeg = await probeFfmpeg();
  mediaCaps.sharp = await probeSharp();
  mediaCaps.police = sondePolice();
  mediaCaps.filigraneVideoReel = await sondeFiligraneVideo();
  if (!mediaCaps.ffmpeg) {
    console.warn('  [MEDIA] ffmpeg ABSENT — la video du studio anonyme sortira SANS filigrane');
  }
  if (!mediaCaps.sharp) {
    console.warn('  [MEDIA] sharp ABSENT — les images sortiront SANS filigrane');
  }
})();

/** Bloc `media` de /health : constant après la sonde, donc sans coût. */
function mediaHealth() {
  return {
    ffmpeg: mediaCaps.ffmpeg,               // version, ou null si absent
    sharp: mediaCaps.sharp,
    police: mediaCaps.police,               // le filigrane écrit des carrés sans elle
    // Un filigrane n'est « vrai » que si l'outil ET la police sont là : sans
    // police, sharp et ffmpeg composent parfaitement… des rectangles vides.
    // Prouvé au démarrage sur une vidéo témoin, pas déduit de la présence des outils.
    videoWatermark: mediaCaps.filigraneVideoReel,
    imageWatermark: mediaCaps.sharp !== null && mediaCaps.police !== null,
  };
}

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
    // `media` est informatif, jamais bloquant : un conteneur sans ffmpeg reste
    // « ok ». C'est la seule façon de rendre le filigrane vérifiable de
    // l'extérieur sans transformer un badge manquant en panne.
    const body = { ok: true, uptime: process.uptime(), media: mediaHealth() };
    // Même principe que `media` : informatif, jamais bloquant. L'opérateur qui
    // a posé LOCAL_ENGINE_URL voit ici si son ComfyUI répond et avec combien
    // de modèles — au lieu de le découvrir à la première génération.
    if (config.localEngine?.url) body.localEngine = localEngineState;
    _healthCache = { ok: true, ts: now, body };
    res.json(body);
  } catch {
    // Même en panne de base on rend `media` : c'est au moment où l'on
    // diagnostique qu'on a besoin de savoir ce que le conteneur embarque.
    const body = { ok: false, error: 'Database unavailable', media: mediaHealth() };
    _healthCache = { ok: false, ts: now, body };
    res.status(503).json(body);
  }
});

// ─── Per-request context (BYOK provider key in opensource edition) ───
app.use('/api', requestContext);

/* ─── Rate limiting per route category ───
 *
 * ─── Le principe, pour que les chiffres ci-dessous se relisent ───
 *
 * Le vrai garde-fou de charge n'est PAS ici : c'est la file d'essai
 * (src/lib/essai-queue.js), qui borne les travaux simultanés (ESSAI_CONCURRENCY
 * = 3), la taille totale (60) et le nombre de jobs par IP (ESSAI_MAX_PER_IP =
 * 20). Elle sait attendre, elle chiffre l'attente qu'elle annonce, et elle
 * n'invente pas de faute.
 *
 * Un limiteur de débit, lui, ne sait que claquer la porte pour dix minutes. Il
 * ne doit donc JAMAIS refuser avant la file : quand c'est lui qui parle en
 * premier, le visiteur reçoit un « trop de requêtes » là où il aurait dû
 * recevoir « votre place est la quatrième, comptez trois minutes ».
 *
 * ─── Le lot de 20 variantes, compté sur dix minutes ───
 *
 * 20 variantes est le plus grand lot que propose le studio (public/studio.html,
 * data-variants) et c'est aussi la valeur d'ESSAI_MAX_PER_IP. Ce lot coûte :
 *
 *   · envoi de la source  : 1 requête. Les 20 variantes partagent la même
 *     photo et public/studio.html dédoublonne l'upload par Promise. Un lot de
 *     20 photos DIFFERENTES coûte 20 uploads — et jusqu'à 60 si chacun doit
 *     être réessayé (boucle `for tries < 3` du studio).
 *   · lancement           : 20 POST /api/essai/studio/*. Le studio relance
 *     automatiquement une fois les soumissions échouées : 40 au pire.
 *   · sondage de statut   : GET, donc hors du seau « anonymous studio ». Le
 *     studio sonde 10 tâches de front (POLL_CONCURRENCY) toutes les 8 s, soit
 *     75 requêtes/minute au plus, quelle que soit la taille du lot. Contre les
 *     600/minute du seau général : 12 % — il ne saute jamais le premier.
 *
 * Qui sautait en premier, avant cette revue : les DEUX seaux d'envoi, pas la
 * file.
 *
 *   · « anonymous upload » à 20/10 min : 20 photos distinctes le remplissaient
 *     exactement, et un seul réessai d'upload le faisait déborder — alors que
 *     la file, elle, acceptait les 20 jobs.
 *   · « anonymous studio » à 60/10 min : trois lots. Or un lot de 20 SONS
 *     (tts/sfx, une quinzaine de secondes pièce) vide la file en deux minutes ;
 *     le visiteur peut donc en enchaîner cinq honnêtement dans la fenêtre, et
 *     c'est le limiteur qui le refusait au 61e alors que la file était vide.
 *
 * Les nouveaux chiffres viennent du débit maximal qu'une IP peut réellement
 * obtenir de la file en dix minutes, pas d'une intuition :
 *
 *     ESSAI_CONCURRENCY (3) × 600 s ÷ durée plancher d'un job (~15 s, un
 *     bruitage) = 120 jobs.
 *
 * Au-delà de 120 lancements en dix minutes, la file n'aurait de toute façon
 * rien pu absorber : le plafond reste un plafond, il a seulement cessé de
 * parler avant elle. Même raisonnement pour les uploads : 20 photos × 3
 * tentatives = 60.
 */
/* Le seau « sign-in » existe contre le brute-force de connexion. Depuis que la
 * RACINE sert le studio anonyme, chaque chargement de page consommait 2 jetons
 * (agency + refresh) : au 8e rechargement le studio rendait une page BLANCHE,
 * parce que redirectToLogin() ne fait rien sur « / ». La lecture publique de
 * l'édition n'a rien à faire dans ce seau. */
app.use('/api/auth', (req, res, next) => (
  req.method === 'GET' && req.path === '/agency'
) ? next() : rateLimit(15, 60 * 1000, 'sign-in')(req, res, next));
app.use('/api/upload', rateLimit(200, 60 * 1000, 'upload'));   // lots du studio : 30+ images
app.use('/api/jarvis', rateLimit(30, 60 * 1000, 'assistant'));
app.use('/api/share', rateLimit(20, 60 * 1000, 'share'));
app.use('/api/platform', rateLimit(30, 60 * 1000, 'operator'));
// Essai communautaire (anonyme) — generer très strict par IP, signaler modéré ;
// statut/galerie/image retombent sur le bucket générique /api ci-dessous.
app.use('/api/essai/generer', rateLimit(5, 10 * 60 * 1000, 'quick trial'));
app.use('/api/essai/signaler', rateLimit(10, 60 * 1000, 'report'));
// Studio anonyme — uploads sources et lancements d'opérations (POST) limités
// par IP ; le polling GET /studio/status retombe sur le bucket générique /api.
// La file essai (ESSAI_MAX_PER_IP) reste le garde-fou dur de concurrence.
// 60 = 20 photos distinctes × les 3 tentatives d'upload du studio (voir le
// calcul ci-dessus) : à 20, un seul réessai réseau fermait la porte.
app.use('/api/essai/upload', rateLimit(60, 10 * 60 * 1000, 'anonymous upload'));
// 120 = le débit maximal qu'une IP peut obtenir de la file en dix minutes
// (3 travaux de front × 600 s ÷ ~15 s pour le job le plus court). Le limiteur
// ne peut donc plus refuser avant la file, et il plafonne toujours.
const essaiStudioLimit = rateLimit(120, 10 * 60 * 1000, 'anonymous studio');
app.use('/api/essai/studio', (req, res, next) => (req.method === 'POST' ? essaiStudioLimit(req, res, next) : next()));
// Public share consumption — separate strict bucket to prevent token enum + view_count spam
app.get('/share/:token', rateLimit(30, 60 * 1000, 'share page'));
app.use('/api', rateLimit(600, 60 * 1000, 'general'));   // le reste : compatible avec le sondage des lots (30 tâches × 8 s)

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
      if (/does not support SSL/i.test(err.message || '')) {
        console.error('  [DB] Votre Postgres parle en clair et NODE_ENV=production impose le TLS — posez DATABASE_SSL=0 (le docker-compose fourni le fait par défaut).');
      }
      if (i < retries - 1) await new Promise(r => setTimeout(r, 3000));
      else throw err;
    }
  }
}
await bootDatabase();

// La sonde média est partie au chargement du module : elle a tourné pendant les
// migrations et rend la main tout de suite. On l'attend quand même ici, pour que
// /health ne puisse pas répondre « ffmpeg absent » simplement parce qu'il a été
// interrogé une milliseconde trop tôt — un faux négatif sur cette route serait
// exactement le genre de bruit qui fait ignorer les vrais.
await mediaProbe;

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
// ─── SEO / GEO ───
// Trois routes DYNAMIQUES, jamais des fichiers dans public/ : public/ est
// partagé par toutes les éditions (déploiements clients white-label, build
// OSS via scripts/build-oss.mjs qui embarque tout public/) — un robots.txt
// statique pointant vers studio.kanaky.xyz fuiterait chez chaque client et
// chaque self-host. Community = version SEO complète ; enterprise = instances
// privées clients, tout est interdit aux robots ; opensource = neutre, chaque
// self-host décide pour lui-même.
const SEO_HOST = 'https://studio.kanaky.xyz';
const SEO_PAGES = [
  ['/', 'weekly', '1.0'],
  ['/about', 'weekly', '0.95'],
  ['/product-images.html', 'monthly', '0.9'],
  ['/video.html', 'monthly', '0.9'],
  ['/self-host.html', 'monthly', '0.9'],
  ['/docs.html', 'monthly', '0.8'],
  ['/essai.html', 'monthly', '0.7'],
  ['/install.html', 'monthly', '0.7'],
  ['/custom.html', 'yearly', '0.5'],
  ['/help.html', 'monthly', '0.4'],
  ['/donate.html', 'yearly', '0.3'],
];

app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  if (config.edition === 'community') {
    // Retrieval ET entraînement bienvenus : être cité par les moteurs IA est
    // un objectif, pas un risque — le produit est open source et gratuit.
    res.send(
      'User-agent: *\nAllow: /\nDisallow: /api/\n\n' +
      `Sitemap: ${SEO_HOST}/sitemap.xml\n`,
    );
  } else if (config.edition === 'enterprise') {
    res.send('User-agent: *\nDisallow: /\n');
  } else {
    res.send('User-agent: *\nAllow: /\n');
  }
});

app.get('/sitemap.xml', (req, res) => {
  if (config.edition !== 'community') return res.status(404).end();
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = SEO_PAGES.map(([p, freq, prio]) =>
    `  <url><loc>${SEO_HOST}${p}</loc><lastmod>${lastmod}</lastmod><changefreq>${freq}</changefreq><priority>${prio}</priority></url>`,
  ).join('\n');
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  );
});

app.get('/llms.txt', (req, res) => {
  if (config.edition === 'enterprise') return res.status(404).end();
  res.type('text/plain; charset=utf-8');
  if (config.edition !== 'community') {
    // Self-host : on pointe vers le projet, pas vers notre instance.
    return res.send(
      '# Keou\n\n> Open-source AI product-visual studio (MIT). ' +
      'This is a self-hosted instance.\n\n- Project: https://github.com/kanakytech/keou\n',
    );
  }
  res.send(`# Keou Studio

> Open-source (MIT) AI creative production engine: product images with
> pixel-locked product fidelity, cinematic video, voice and sound — free
> online without an account, or self-hosted with your own API keys (BYOK).

Keou Studio is built by Kanaky Tech (https://kanaky.xyz), Auckland. The hosted
instance at ${SEO_HOST} is free and requires no signup; the same software is
MIT-licensed and self-hostable.

## Key pages

- [Studio (no signup)](${SEO_HOST}/launch): use it now.
- [AI product images](${SEO_HOST}/product-images.html): pixel-locked product photos.
- [AI product video](${SEO_HOST}/video.html): the video engines and how they work.
- [Self-hosting](${SEO_HOST}/self-host.html): Docker/Railway, BYOK, MIT license.
- [Documentation](${SEO_HOST}/docs.html)
- [MCP install (agents)](${SEO_HOST}/install.html): use Keou from Claude via MCP.
- [Source code](https://github.com/kanakytech/keou)

## Facts

- License: MIT. Repository: https://github.com/kanakytech/keou
- Pricing of the hosted community instance: free, no account required.
- Generation engines: external model APIs with your own keys (BYOK), or a
  fully local ComfyUI instance (self-hosted installs, LOCAL_ENGINE_URL) —
  images and upscaling always, video too when Wan 2.2 or LTX-Video models are
  installed. Voice and SFX remain cloud-only.
- Contact: contact@kanaky.xyz
`);
});

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
  // Enterprise/opensource : la connexion, comme avant.
  if (config.edition !== 'community') {
    return res.sendFile(join(__dirname, 'public', 'login.html'));
  }
  // Community : le studio directement — c'est le produit, et un lien partagé
  // (Show HN, AlternativeTo, README) doit ouvrir l'outil, pas une brochure.
  // studio.html porte un `noindex` (juste : /studio.html est une copie et les
  // instances white-label ne doivent pas être indexées). Servi à la RACINE
  // publique, ce noindex sortirait l'URL du sitemap (priorité 1.0) de l'index.
  // On le remplace à la volée par le canonical de la racine et une description,
  // sans toucher au fichier — qui reste partagé par toutes les éditions.
  const html = readFileSync(join(__dirname, 'public', 'studio.html'), 'utf8').replace(
    '<meta name="robots" content="noindex">',
    `<link rel="canonical" href="${SEO_HOST}/">\n<meta name="description" content="Keou Studio — free, open-source AI product images, cinematic video, voice and sound. No account: paste your own KIE.AI key and produce. Self-hostable under MIT.">`,
  );
  res.type('html').send(html);
});

// La page de présentation garde une adresse propre et indexable. Elle reste
// servie telle quelle par express.static à /index.html ; /about est l'URL
// canonique qu'on publie (sitemap, liens internes).
app.get('/about', (req, res) => {
  // Community seulement : une instance en marque blanche ne doit pas servir
  // notre page de présentation avec notre marque et nos liens.
  if (config.edition !== 'community') return res.status(404).end();
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// État moteur pour le front (studio) : public mais minimal — pas de chemins,
// pas de versions détaillées. Permet au studio d'afficher « Local · ComfyUI »
// et de ne pas réclamer une clé cloud quand le moteur local est actif.
app.get('/api/engine', (req, res) => {
  res.json({
    provider: (config.localEngine?.url && config.defaultProvider === 'local') ? 'local' : config.defaultProvider,
    localEngine: config.localEngine?.url
      ? { configured: true, reachable: !!localEngineState.reachable, checkpoints: localEngineState.checkpoints || 0, active: config.defaultProvider === 'local' }
      : { configured: false },
  });
});

// Sous docker compose sans R2, l'URL de résultat http://comfyui:8188/view?…
// est un hostname interne que le navigateur ne résout pas : ce proxy rend le
// résultat atteignable. Réservé au moteur local configuré, paramètres bornés.
app.get('/api/local-view', async (req, res) => {
  if (!config.localEngine?.url) return res.status(404).end();
  const { filename, subfolder = '', type = 'output' } = req.query;
  if (typeof filename !== 'string' || !/^[\w.-]{1,200}$/.test(filename)) return res.status(400).json({ error: 'bad filename' });
  if (typeof subfolder !== 'string' || subfolder.length > 200 || subfolder.includes('..')) return res.status(400).json({ error: 'bad subfolder' });
  if (type !== 'output') return res.status(400).json({ error: 'bad type' });
  try {
    const params = new URLSearchParams({ filename, subfolder, type });
    const upstream = await fetch(`${config.localEngine.url.replace(/\/+$/, '')}/view?${params}`);
    if (!upstream.ok) return res.status(upstream.status).end();
    res.set('Content-Type', upstream.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(502).json({ error: 'local engine unreachable' });
  }
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
// ─── Moteur local — sonde au boot (même principe que ffmpeg) ───
// L'état est mémoïsé et resondé toutes les 60 s : /health et /api/engine le
// servent sans re-frapper ComfyUI à chaque requête.
let localEngineState = { configured: false };
async function refreshLocalEngine() {
  if (!config.localEngine?.url) return;
  try {
    const { probeLocalEngine } = await import('./src/lib/providers/comfy.js');
    localEngineState = await probeLocalEngine();
  } catch (err) {
    localEngineState = { configured: true, reachable: false, error: err.message };
  }
}
if (config.localEngine?.url) {
  await refreshLocalEngine();
  setInterval(refreshLocalEngine, 60_000).unref();
}

const server = app.listen(PORT, () => {
  console.log(`\n  KEOU Agency — B2B Platform`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  [DB] PostgreSQL connected`);
  console.log(`  [AUTH] JWT + refresh cookie`);
  console.log(`  [SEC] Helmet + rate limiting enabled`);
  console.log(`  [PERF] gzip compression + 1h static cache enabled`);
  // Le même couple que rend /health : ce que le conteneur peut filigraner. Écrit
  // au démarrage pour qu'un opérateur qui lit ses logs de déploiement voie
  // immédiatement ce qu'une image reconstruite a perdu en route.
  console.log(`  [MEDIA] ffmpeg ${mediaCaps.ffmpeg || 'absent'} (video watermark: ${mediaCaps.ffmpeg ? 'on' : 'OFF'})`
    + ` | sharp ${mediaCaps.sharp || 'absent'} (image watermark: ${mediaCaps.sharp ? 'on' : 'OFF'})`);
  // Même principe que [MEDIA] : l'état du moteur local se lit au boot, pas à
  // la première génération ratée.
  if (config.localEngine?.url) {
    if (localEngineState.reachable) {
      const video = localEngineState.video?.length ? `, vidéo: ${localEngineState.video.join('+')}` : ', vidéo: aucun modèle (Wan 2.2 / LTX absents)';
      console.log(`  [LOCAL] ComfyUI @ ${config.localEngine.url} — ${localEngineState.checkpoints} checkpoint(s), ${localEngineState.upscaleModels} upscale model(s)${video}`
        + (config.defaultProvider === 'local' ? ' — ACTIF (DEFAULT_PROVIDER=local)' : ' — configuré mais INACTIF : posez DEFAULT_PROVIDER=local pour l\'utiliser'));
    } else {
      console.warn(`  [LOCAL] ComfyUI injoignable @ ${config.localEngine.url} — ${localEngineState.error || 'pas de réponse'}`);
    }
  } else if (config.defaultProvider === 'local') {
    console.warn(`  [LOCAL] DEFAULT_PROVIDER=local mais LOCAL_ENGINE_URL absent — repli silencieux sur les fournisseurs cloud. Posez LOCAL_ENGINE_URL (ex: http://localhost:8188).`);
  }
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

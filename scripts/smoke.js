/**
 * Smoke test — imports every route and lib module with stub env vars.
 * Catches renames, missing exports, broken import paths, typos in
 * provider references — things `node --check` can't see.
 *
 * Does NOT boot the server or touch the DB. Queries only fire when
 * routes are called, which never happens here.
 *
 * Run: npm test
 */

process.env.JWT_SECRET = 'smoke-test-jwt-secret-long-enough-for-validation';
process.env.DATABASE_URL = 'postgresql://smoke:smoke@localhost:5432/smoke';
process.env.ADMIN_EMAIL = 'smoke@test.local';
process.env.ADMIN_PASSWORD = 'smoke-password';
process.env.R2_ACCOUNT_ID = 'smoke';
process.env.R2_ACCESS_KEY = 'smoke';
process.env.R2_SECRET_KEY = 'smoke';
process.env.R2_BUCKET = 'smoke';

const MODULES = [
  // Core
  '../src/config.js',
  '../src/db.js',
  // Libs
  '../src/lib/keou-actions.js',
  '../src/lib/r2.js',
  '../src/lib/essai-queue.js',
  '../src/lib/prompt-filter.js',
  '../src/lib/studio-prompts.js',
  '../src/lib/providers/index.js',
  '../src/lib/providers/kie.js',
  '../src/lib/providers/fal.js',
  // Middleware
  '../src/middleware/auth.js',
  '../src/middleware/credits.js',
  '../src/middleware/rateLimit.js',
  // Utils
  '../src/utils/activity.js',
  '../src/utils/credits.js',
  '../src/utils/crypto.js',
  '../src/utils/expiry.js',
  '../src/utils/hash.js',
  '../src/utils/jwt.js',
  '../src/utils/tagger.js',
  // Routes (the big surface)
  '../src/routes/activity.js',
  '../src/routes/admin.js',
  '../src/routes/analytics.js',
  '../src/routes/auth.js',
  '../src/routes/campaigns.js',
  '../src/routes/conversations.js',
  '../src/routes/dashboard.js',
  '../src/routes/download.js',
  '../src/routes/essai.js',
  '../src/routes/generate.js',
  '../src/routes/history.js',
  '../src/routes/jarvis.js',
  '../src/routes/profile.js',
  '../src/routes/projects.js',
  '../src/routes/share.js',
  '../src/routes/team.js',
  '../src/routes/tools.js',
  '../src/routes/upload.js',
  // Migration + poller
  '../src/migrate.js',
  '../src/poller.js',
];

// Critical named exports that must exist — catches accidental rename/delete
const REQUIRED_EXPORTS = {
  '../src/lib/keou-actions.js': [
    'executeGenerateImage', 'executeGenerateVideo',
    'executePolish', 'executeRemix', 'executeAdapt',
    'executeTts', 'executeSfx',
    'executeImageUpscale', 'executeVideoUpscale',
    'persistAndComplete', 'findIdempotent',
  ],
  '../src/lib/providers/index.js': ['getProvider', 'getProviderApiKey', 'clearKeyCache'],
  '../src/lib/providers/kie.js': [
    'generateImage', 'generateVideo', 'polish', 'remix', 'adapt',
    'tts', 'sfx', 'upscaleImage', 'upscaleVideo', 'pollTask', 'calculateCost',
    'textToImage',
  ],
  '../src/lib/essai-queue.js': ['enqueue', 'positionOf', 'queueStats', 'watermarkImage'],
  '../src/lib/prompt-filter.js': ['checkPrompt'],
  '../src/lib/r2.js': ['persistFromUrl', 'uploadToR2', 'getObjectStream', 'deleteFromR2'],
  '../src/routes/essai.js': ['default'],
  '../src/lib/providers/fal.js': [
    'generateImage', 'generateVideo', 'polish', 'remix', 'adapt',
    'tts', 'sfx', 'upscaleImage', 'upscaleVideo', 'pollTask', 'calculateCost',
  ],
  '../src/utils/crypto.js': ['encryptKey', 'decryptKey'],
  '../src/utils/credits.js': ['deductCredits', 'refundCredits', 'getQuotaRemaining'],
  '../src/routes/share.js': ['default', 'renderSharePage'],
  '../src/migrate.js': ['runMigrations', 'seedAgency', 'cleanupStaleEssai'],
  '../src/poller.js': ['startPoller', 'stopPoller'],
};

let failed = 0;
let checked = 0;

for (const rel of MODULES) {
  try {
    const mod = await import(rel);
    checked++;
    const req = REQUIRED_EXPORTS[rel];
    if (req) {
      const missing = req.filter(name => typeof mod[name] === 'undefined');
      if (missing.length) {
        console.error(`  ✗ ${rel} — missing exports: ${missing.join(', ')}`);
        failed++;
      } else {
        console.log(`  ✓ ${rel} (${req.length} exports verified)`);
      }
    } else {
      console.log(`  ✓ ${rel}`);
    }
  } catch (err) {
    console.error(`  ✗ ${rel} — ${err.message}`);
    failed++;
  }
}

console.log(`\n  ${checked - failed}/${MODULES.length} modules loaded cleanly`);

if (failed > 0) {
  console.error(`\n  ${failed} failure(s) — bailing`);
  process.exit(1);
}

// ─── Runtime sanity checks (cheap, don't touch DB or network) ───
console.log('\n  Running runtime sanity checks...');

const runtimeChecks = [
  async () => {
    // crypto encrypt/decrypt round trip — catches misuse of scrypt-derived key
    const { encryptKey, decryptKey } = await import('../src/utils/crypto.js');
    const sample = 'sk-test-key-1234567890abcdef';
    const encrypted = encryptKey(sample);
    const decrypted = decryptKey(encrypted);
    if (decrypted !== sample) throw new Error('crypto roundtrip failed');
    return 'crypto encryptKey/decryptKey roundtrip';
  },
  async () => {
    // KIE extractUrl handles all known shapes
    const kie = await import('../src/lib/providers/kie.js');
    // Internal helper not exported — verify pollTask is callable by signature
    if (typeof kie.pollTask !== 'function') throw new Error('pollTask not callable');
    return 'KIE provider exports callable';
  },
  async () => {
    // calculateCost returns numbers for all known types
    const kie = await import('../src/lib/providers/kie.js');
    const types = ['image', 'polish', 'remix', 'adapt', 'video', 'img-upscale', 'vid-upscale', 'tts', 'sfx'];
    for (const t of types) {
      const cost = kie.calculateCost(t, { duration: 8, model: 'grok-imagine' });
      if (typeof cost !== 'number' || cost < 0) throw new Error(`cost for ${t} invalid: ${cost}`);
    }
    return 'KIE calculateCost OK on all 9 types';
  },
  async () => {
    // Essai prompt filter — blocks banned categories, passes clean prompts
    const { checkPrompt } = await import('../src/lib/prompt-filter.js');
    if (!checkPrompt('nude portrait').blocked) throw new Error('filter missed sexual content');
    if (!checkPrompt('faux passeport realiste').blocked) throw new Error('filter missed ID documents');
    if (checkPrompt('bouteille de jus tropical sur un rocher').blocked) throw new Error('filter false positive');
    return 'essai prompt filter FR+EN';
  },
  async () => {
    // JWT sign+verify roundtrip
    const { signAccessToken } = await import('../src/utils/jwt.js');
    const jwt = await import('jsonwebtoken');
    const token = signAccessToken({ id: 1, email: 'smoke@test', role: 'admin' });
    const decoded = jwt.default.verify(token, process.env.JWT_SECRET);
    if (decoded.id !== 1) throw new Error('JWT roundtrip mismatch');
    return 'JWT sign+verify roundtrip';
  },
];

let runtimeFailed = 0;
for (const check of runtimeChecks) {
  try {
    const label = await check();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ runtime check failed: ${err.message}`);
    runtimeFailed++;
  }
}

if (runtimeFailed > 0) {
  console.error(`\n  ${runtimeFailed} runtime check(s) failed — bailing`);
  process.exit(1);
}
console.log('  smoke test passed\n');

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

export const config = {
  port: process.env.PORT || 3401,

  databaseUrl: process.env.DATABASE_URL,

  // ─── Edition ───
  // 'enterprise' (default): full platform — accounts, team, all tools, credits.
  // 'opensource': the self-hosted build. Every feature of the suite is
  //   unlocked — nothing is held back. Accounts ARE required: the edition used
  //   to hand out a session with no identifier at all, which was removed for
  //   security, so a deployment seeds its first account from ADMIN_EMAIL /
  //   ADMIN_PASSWORD and signs in normally. Each request carries the caller's
  //   own provider key (BYOK).
  // 'community': hosted free tier — public self-serve signup, same full suite,
  //   BYOK per request (the platform's provider keys are never used).
  // Operator and cost surfaces (billing, platform) stay off outside enterprise.
  edition: ['opensource', 'community'].includes(process.env.EDITION)
    ? process.env.EDITION
    : 'enterprise',

  // ─── Billing mode (enterprise edition only) ───
  // 'quota' (default): legacy image/video quota pools — existing deployments unchanged.
  // 'credits': prepaid Keou credit balance, debited per action via src/lib/pricing.js,
  // topped up manually through /api/platform/credits.
  billingMode: process.env.BILLING_MODE === 'credits' ? 'credits' : 'quota',

  platformAdminToken: null, // commercial deployments only

  agency: {
    name: process.env.AGENCY_NAME || 'Agency',
    imageQuota: parseInt(process.env.AGENCY_IMAGE_QUOTA) || 500,
    videoQuota: parseInt(process.env.AGENCY_VIDEO_QUOTA) || 50,
  },

  admin: {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    expires: process.env.JWT_EXPIRES || '15m',
    refreshExpires: process.env.REFRESH_EXPIRES || '7d',
  },

  kie: {
    baseUrl: 'https://api.kie.ai/api/v1/jobs',
    // Single universal key (preferred) or legacy per-type keys
    apiKey: process.env.KIE_API_KEY,
    keys: {
      image: process.env.KIE_IMAGE_KEY || process.env.KIE_API_KEY,
      video: process.env.KIE_VIDEO_KEY || process.env.KIE_API_KEY,
      upscale: process.env.KIE_UPSCALE_KEY || process.env.KIE_API_KEY,
      polish: process.env.KIE_POLISH_KEY || process.env.KIE_API_KEY,
    },
  },

  fal: {
    apiKey: process.env.FAL_API_KEY,
  },

  // Moteur local (self-host) : une instance ComfyUI que CE serveur peut
  // joindre. Jamais actif sur l'instance hébergée — le serveur ne peut pas
  // atteindre le localhost d'un visiteur. Images + upscale en v1.
  localEngine: {
    url: process.env.LOCAL_ENGINE_URL || process.env.COMFYUI_URL || '',
    checkpoint: process.env.LOCAL_CHECKPOINT || '',       // sinon : premier modèle installé
    upscaleModel: process.env.LOCAL_UPSCALE_MODEL || '',  // sinon : premier modèle installé
  },

  defaultProvider: process.env.DEFAULT_PROVIDER || 'kie', // "kie" | "fal" | "local"

  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
    bucket: process.env.R2_BUCKET || 'keou-uploads',
    // L'endpoint était figé sur Cloudflare : un auto-hébergeur sans compte
    // Cloudflare ne pouvait brancher NI MinIO, NI AWS S3, NI Backblaze, NI
    // Wasabi — il devait éditer le code source pour franchir le premier geste
    // du produit. Le repli garde Cloudflare, qui reste le chemin documenté.
    endpoint: process.env.S3_ENDPOINT || null,
    publicUrl: process.env.R2_PUBLIC_URL || '', // e.g. https://r2.kanaky.xyz — set after enabling R2 custom domain
  },

  cf: {
    accountId: process.env.R2_ACCOUNT_ID,
    aiToken: process.env.CF_AI_TOKEN,
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },

  // ─── Stripe — instance hébergée uniquement ───
  // Sert à facturer NOTRE déploiement managé. Aucune fonctionnalité du studio
  // ne lit ce bloc ; il est vidé dans la construction open source.
  // sk_live_* in production, sk_test_* in dev. Webhook secret comes from
  // `stripe listen --forward-to ...` for local, or the Stripe dashboard
  // (Webhooks → Add endpoint) for prod.
  // Payment plumbing belongs to our hosted commercial instance and is not
  // part of the open-source edition. Nothing in the studio reads it.
  stripe: {},

};

// ─── Startup validation ───
if (!config.jwt.secret || config.jwt.secret.length < 16) {
  console.error('\n  [FATAL] JWT_SECRET is missing or too short (min 16 chars).');
  console.error('  Set JWT_SECRET in your environment variables.\n');
  process.exit(1);
}
if (!config.databaseUrl) {
  console.error('\n  [FATAL] DATABASE_URL is not configured.\n');
  process.exit(1);
}

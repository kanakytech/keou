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
  // 'opensource': limited self-host/demo build — no login (auto-session),
  // image+video studio only, user brings their own provider key per request.
  // 'community': hosted free tier — public self-serve signup, full creative
  // suite unlocked, BYOK per request (the platform's provider keys are never
  // used). Operator/cost surfaces (assistant, billing, platform) stay off.
  edition: ['opensource', 'community'].includes(process.env.EDITION)
    ? process.env.EDITION
    : 'enterprise',

  // ─── Billing mode (enterprise edition only) ───
  // 'quota' (default): legacy image/video quota pools — existing deployments unchanged.
  // 'credits': prepaid Keou credit balance, debited per action via src/lib/pricing.js,
  // topped up manually through /api/platform/credits.
  billingMode: process.env.BILLING_MODE === 'credits' ? 'credits' : 'quota',

  platformAdminToken: null, // not used in the open-source edition

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

  defaultProvider: process.env.DEFAULT_PROVIDER || 'kie', // "kie" | "fal"

  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
    bucket: process.env.R2_BUCKET || 'keou-uploads',
    publicUrl: process.env.R2_PUBLIC_URL || '', // e.g. https://r2.keou.systems — set after enabling R2 custom domain
  },

  cf: {
    accountId: process.env.R2_ACCOUNT_ID,
    aiToken: process.env.CF_AI_TOKEN,
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },

  // ─── Stripe (Keou Pro subscription) ───
  // sk_live_* in production, sk_test_* in dev. Webhook secret comes from
  // `stripe listen --forward-to ...` for local, or the Stripe dashboard
  // (Webhooks → Add endpoint) for prod.
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    proPriceId: process.env.STRIPE_PRO_PRICE_ID, // recurring $19/mo Stripe Price ID
    portalReturnUrl: process.env.STRIPE_PORTAL_RETURN_URL || 'https://keou.systems/dashboard',
    successUrl: process.env.STRIPE_SUCCESS_URL || 'https://keou.systems/pro?session=success',
    cancelUrl: process.env.STRIPE_CANCEL_URL || 'https://keou.systems/pro?session=cancelled',
  },

  pro: {
    // Pro plan grants: extra image quota per month + unlocks premium tools
    monthlyImageBonus: parseInt(process.env.PRO_MONTHLY_IMAGE_BONUS) || 500,
    monthlyVideoBonus: parseInt(process.env.PRO_MONTHLY_VIDEO_BONUS) || 30,
    // Free trial: how many generations a free user gets before being asked to upgrade
    freeMonthlyImages: parseInt(process.env.FREE_MONTHLY_IMAGES) || 15,
  },
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

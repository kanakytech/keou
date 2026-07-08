import pool, { query, queryOne, queryAll } from './db.js';
import { config } from './config.js';
import { hashPassword } from './utils/hash.js';

const MIGRATIONS = [
  // ═══ AGENCY (singleton) ═══
  `CREATE TABLE IF NOT EXISTS agency (
    id            SERIAL PRIMARY KEY,
    name          TEXT    NOT NULL,
    logo_url      TEXT,
    industry      TEXT,
    style_pref    TEXT    DEFAULT '{}',
    image_quota   INTEGER NOT NULL DEFAULT 500,
    video_quota   INTEGER NOT NULL DEFAULT 50,
    image_used    INTEGER NOT NULL DEFAULT 0,
    video_used    INTEGER NOT NULL DEFAULT 0,
    deployed_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
  )`,

  // ═══ USERS ═══
  `CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'member',
    status        TEXT    NOT NULL DEFAULT 'active',
    invited_by    INTEGER REFERENCES users(id),
    last_login_at TIMESTAMP,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
  )`,

  // ═══ PROJECTS ═══
  `CREATE TABLE IF NOT EXISTS projects (
    id            SERIAL PRIMARY KEY,
    name          TEXT    NOT NULL,
    description   TEXT,
    status        TEXT    NOT NULL DEFAULT 'active',
    color         TEXT    DEFAULT '#0A0A0A',
    created_by    INTEGER NOT NULL REFERENCES users(id),
    created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_proj_status ON projects(status)`,

  // ═══ GENERATIONS ═══
  `CREATE TABLE IF NOT EXISTS generations (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id    INTEGER REFERENCES projects(id),
    type          TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'pending',
    input_url     TEXT,
    result_url    TEXT,
    format        TEXT,
    task_id       TEXT,
    record_id     TEXT,
    credits_used  INTEGER NOT NULL DEFAULT 1,
    error         TEXT,
    metadata      TEXT    DEFAULT '{}',
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gen_user ON generations(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_gen_project ON generations(project_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_gen_status ON generations(status)`,
  `CREATE INDEX IF NOT EXISTS idx_gen_status_task ON generations(status, task_id, created_at DESC)`,

  // ═══ CREDIT TRANSACTIONS ═══
  `CREATE TABLE IF NOT EXISTS credit_transactions (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type          TEXT    NOT NULL,
    amount        INTEGER NOT NULL,
    reason        TEXT    NOT NULL,
    generation_id INTEGER REFERENCES generations(id),
    performed_by  INTEGER REFERENCES users(id),
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ctx_user ON credit_transactions(user_id, created_at DESC)`,

  // ═══ SESSIONS ═══
  `CREATE TABLE IF NOT EXISTS sessions (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token TEXT    NOT NULL UNIQUE,
    expires_at    TIMESTAMP NOT NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sess_token ON sessions(refresh_token)`,

  // ═══ ACTIVITY LOG ═══
  `CREATE TABLE IF NOT EXISTS activity_log (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    action        TEXT    NOT NULL,
    entity_type   TEXT,
    entity_id     INTEGER,
    details       TEXT    DEFAULT '{}',
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_time ON activity_log(created_at DESC)`,

  // ═══ SETTINGS (key-value store for admin config) ═══
  `CREATE TABLE IF NOT EXISTS settings (
    key           TEXT PRIMARY KEY,
    value         TEXT NOT NULL,
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
  )`,

  // ═══ CAMPAIGNS ═══
  `CREATE TABLE IF NOT EXISTS campaigns (
    id            SERIAL PRIMARY KEY,
    project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name          TEXT    NOT NULL,
    description   TEXT,
    status        TEXT    NOT NULL DEFAULT 'active',
    color         TEXT    DEFAULT '#06B6D4',
    created_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_campaign_project ON campaigns(project_id)`,

  // ═══ MIGRATIONS (safe re-runs) ═══
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS image_quota INTEGER DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS video_quota INTEGER DEFAULT NULL`,
  `ALTER TABLE generations ADD COLUMN IF NOT EXISTS campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL`,
  `CREATE INDEX IF NOT EXISTS idx_gen_campaign ON generations(campaign_id)`,

  // ═══ AUTO-TAGGING ═══
  `ALTER TABLE generations ADD COLUMN IF NOT EXISTS tags TEXT DEFAULT '[]'`,

  // ═══ PRODUCTION TIME TRACKING ═══
  `ALTER TABLE generations ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP`,
  `CREATE INDEX IF NOT EXISTS idx_gen_completed ON generations(completed_at)`,

  // Backfill: estimate completed_at for existing completed generations
  // Uses type-based estimation: image=2min, video=3min, polish=1.5min, etc.
  `UPDATE generations SET completed_at = created_at + INTERVAL '2 minutes'
   WHERE status = 'completed' AND completed_at IS NULL AND type IN ('image','polish','img-upscale')`,
  `UPDATE generations SET completed_at = created_at + INTERVAL '3 minutes'
   WHERE status = 'completed' AND completed_at IS NULL AND type IN ('video','vid-upscale')`,
  `UPDATE generations SET completed_at = created_at + INTERVAL '1 minute'
   WHERE status = 'completed' AND completed_at IS NULL AND type IN ('tts','sfx')`,
  // Catch-all for any remaining types
  `UPDATE generations SET completed_at = created_at + INTERVAL '2 minutes'
   WHERE status = 'completed' AND completed_at IS NULL`,

  // ═══ FK CASCADE fixes (safe re-run) ═══
  `DO $$ BEGIN
    ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_user_id_fkey;
    ALTER TABLE activity_log ADD CONSTRAINT activity_log_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END $$`,
  `DO $$ BEGIN
    ALTER TABLE credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_performed_by_fkey;
    ALTER TABLE credit_transactions ADD CONSTRAINT credit_transactions_performed_by_fkey
      FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE SET NULL;
  END $$`,
  `DO $$ BEGIN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_invited_by_fkey;
    ALTER TABLE users ADD CONSTRAINT users_invited_by_fkey
      FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL;
  END $$`,
  // Fix: credit_transactions.generation_id needs ON DELETE CASCADE for cleanup
  `DO $$ BEGIN
    ALTER TABLE credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_generation_id_fkey;
    ALTER TABLE credit_transactions ADD CONSTRAINT credit_transactions_generation_id_fkey
      FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE CASCADE;
  END $$`,
  // Performance: indexes for dashboard/analytics aggregation queries
  `CREATE INDEX IF NOT EXISTS idx_gen_type_status ON generations(type, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_gen_completed ON generations(completed_at) WHERE completed_at IS NOT NULL`,
  // R2 permanent storage — track which results are persisted
  `ALTER TABLE generations ADD COLUMN IF NOT EXISTS r2_key TEXT`,
  // ═══ CONVERSATIONS (chat history) ═══
  `CREATE TABLE IF NOT EXISTS conversations (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT DEFAULT 'New conversation',
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS conversation_messages (
    id              SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    image_url       TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_conv_msg ON conversation_messages(conversation_id, created_at)`,
  // ═══ CHAT MEDIA PERSISTENCE ═══
  `ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS generation_ids TEXT DEFAULT '[]'`,
  // ═══ SHARE LINKS (client portal) ═══
  `CREATE TABLE IF NOT EXISTS share_links (
    id          SERIAL PRIMARY KEY,
    token       TEXT NOT NULL UNIQUE,
    project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT DEFAULT 'Shared Assets',
    access_code TEXT,
    expires_at  TIMESTAMP NOT NULL,
    view_count  INTEGER DEFAULT 0,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS share_link_items (
    id            SERIAL PRIMARY KEY,
    share_link_id INTEGER NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
    generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_share_token ON share_links(token)`,
  `CREATE INDEX IF NOT EXISTS idx_share_items ON share_link_items(share_link_id)`,

  // ═══ API COST TRACKING (per-generation real cost) ═══
  `ALTER TABLE generations ADD COLUMN IF NOT EXISTS api_cost DECIMAL(10,4) DEFAULT 0`,

  // ═══ UNIQUE CONSTRAINT: one campaign name per project ═══
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_project_name ON campaigns(project_id, name)`,

  // ═══ IDEMPOTENCY (prevent duplicate generations on retries) ═══
  `ALTER TABLE generations ADD COLUMN IF NOT EXISTS idempotency_key TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_gen_idempotency ON generations(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,

  // ═══ COMPOSITE INDEXES (frequent filter combos) ═══
  // routes/history.js, routes/analytics.js filter by (user_id, status)
  `CREATE INDEX IF NOT EXISTS idx_gen_user_status ON generations(user_id, status, created_at DESC)`,
  // routes/share.js joins share_link_items → generations, ordered by created_at
  `CREATE INDEX IF NOT EXISTS idx_share_items_link ON share_link_items(share_link_id, generation_id)`,

  // ═══ FK CASCADE — project hard-delete should not orphan generations ═══
  // Existing campaign_id already has ON DELETE SET NULL — match for project_id.
  `DO $$ BEGIN
    ALTER TABLE generations DROP CONSTRAINT IF EXISTS generations_project_id_fkey;
    ALTER TABLE generations ADD CONSTRAINT generations_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
  END $$`,

  // ═══ CLIENT FEEDBACK ON SHARE PAGES ═══
  // Client (the agency's customer) can Approve / Reject / Comment per asset
  // without creating an account. Reviewer name is captured once per session
  // and stored alongside each entry for the agency's audit trail.
  `CREATE TABLE IF NOT EXISTS share_feedback (
    id              SERIAL PRIMARY KEY,
    share_link_id   INTEGER NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
    generation_id   INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    type            TEXT NOT NULL CHECK (type IN ('approve','reject','comment')),
    comment         TEXT,
    reviewer_name   TEXT,
    reviewer_email  TEXT,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMP,
    resolved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_share_fb_link ON share_feedback(share_link_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_share_fb_gen ON share_feedback(generation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_share_fb_status ON share_feedback(status) WHERE status = 'open'`,

  // ═══ EXPORT PACK GROUPING ═══
  // Adapted variants generated together as a deliverable pack share a pack_id
  // so we can group them for ZIP download and naming convention.
  `ALTER TABLE generations ADD COLUMN IF NOT EXISTS pack_id TEXT`,
  `ALTER TABLE generations ADD COLUMN IF NOT EXISTS pack_format_label TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_gen_pack ON generations(pack_id) WHERE pack_id IS NOT NULL`,

  // ═══ FEEDBACK NOTIFICATIONS ═══
  // Per-user "last time I checked the bell". Anything in share_feedback
  // with created_at > this timestamp is unread for that user. NULL = the
  // user has never opened the bell yet, so all feedback is unread.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS feedback_seen_at TIMESTAMP`,

  // ═══ KEOU PRO SUBSCRIPTIONS (Stripe-backed) ═══
  // One row per user with an active or past subscription. Free users have
  // no row at all — `users.plan = 'free'` is the source of truth for plan
  // tier, while this table tracks Stripe-side state for billing operations.
  // Status values mirror Stripe Subscription.status.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_period_end TIMESTAMP`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id                       SERIAL PRIMARY KEY,
    user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stripe_subscription_id   TEXT    NOT NULL UNIQUE,
    stripe_customer_id       TEXT    NOT NULL,
    stripe_price_id          TEXT    NOT NULL,
    status                   TEXT    NOT NULL,
    current_period_start     TIMESTAMP,
    current_period_end       TIMESTAMP,
    cancel_at_period_end     BOOLEAN NOT NULL DEFAULT FALSE,
    canceled_at              TIMESTAMP,
    created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sub_user ON subscriptions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sub_status ON subscriptions(status)`,

  // ═══ API KEYS (MCP / programmatic access) ═══
  // Long-lived bearer tokens issued per-user for headless clients (Claude MCP, scripts).
  // key_hash stores SHA-256(plaintext) — lookup is O(1), no bcrypt needed since plaintext
  // is 128 bits of CSPRNG randomness (no rainbow-table risk).
  // key_prefix shows the first 12 chars in UI ("keou_xK3a…") so users can identify keys
  // without exposing the secret. Revoke = DELETE row.
  `CREATE TABLE IF NOT EXISTS api_keys (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash      TEXT    NOT NULL UNIQUE,
    key_prefix    TEXT    NOT NULL,
    label         TEXT    NOT NULL,
    last_used_at  TIMESTAMP,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_apikey_user ON api_keys(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_apikey_hash ON api_keys(key_hash)`,

  // ═══ PREPAID KEOU CREDITS (BILLING_MODE=credits) ═══
  // Single agency-level prepaid balance, topped up manually by the platform
  // operator via /api/platform/credits after a bank transfer. Debits and
  // refunds are journaled in credit_transactions (reason: generation|refund|
  // purchase|adjustment) with the resulting balance for auditability.
  `ALTER TABLE agency ADD COLUMN IF NOT EXISTS credit_balance INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS balance_after INTEGER`,
  `ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS note TEXT`,
];

export async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const sql of MIGRATIONS) {
      await client.query(sql);
    }
    await client.query('COMMIT');
    console.log('  [DB] Migrations complete — 9 tables ready');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('  [DB] Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

/** Seed agency row + admin user on first boot */
export async function seedAgency() {
  const existing = await queryOne('SELECT id FROM agency LIMIT 1');
  if (!existing) {
    await query(
      'INSERT INTO agency (name, image_quota, video_quota) VALUES ($1, $2, $3)',
      [config.agency.name, config.agency.imageQuota, config.agency.videoQuota]
    );
    console.log(`  [SEED] Agency "${config.agency.name}" created (${config.agency.imageQuota} img / ${config.agency.videoQuota} vid)`);
  }

  // Re-hash admin password if env var changed (one-time sync on deploy)
  if (config.admin.email && config.admin.password) {
    const admin = await queryOne('SELECT id, password_hash FROM users WHERE LOWER(email) = LOWER($1) AND role = $2', [config.admin.email, 'admin']);
    if (admin) {
      const { comparePassword } = await import('./utils/hash.js');
      const match = await comparePassword(config.admin.password, admin.password_hash);
      if (!match) {
        const newHash = await hashPassword(config.admin.password);
        await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, admin.id]);
        console.log('  [SEED] Admin password synced from environment');
      }
    }
  }

  const adminExists = await queryOne('SELECT id FROM users LIMIT 1');
  if (!adminExists && config.admin.email && config.admin.password) {
    const hash = await hashPassword(config.admin.password);
    const adminResult = await query(
      `INSERT INTO users (email, password_hash, name, role, status) VALUES ($1, $2, 'Admin', 'admin', 'active') RETURNING id`,
      [config.admin.email.toLowerCase().trim(), hash]
    );
    console.log(`  [SEED] Admin user created: ${config.admin.email}`);

    // Create default "General" project + campaign
    const adminId = adminResult.rows[0].id;
    const projResult = await query(
      `INSERT INTO projects (name, description, color, created_by) VALUES ('General', 'Default project for unsorted generations', '#6B7280', $1) RETURNING id`,
      [adminId]
    );
    await query(
      `INSERT INTO campaigns (project_id, name, description, color, created_by) VALUES ($1, 'General', 'Default campaign', '#6B7280', $2)`,
      [projResult.rows[0].id, adminId]
    );
    console.log('  [SEED] Default project "General" + campaign created');
  }

  // Ensure default project exists (for existing deployments upgrading)
  const defaultProject = await queryOne("SELECT id FROM projects WHERE name = 'General' LIMIT 1");
  if (!defaultProject) {
    const admin = await queryOne('SELECT id FROM users WHERE role = $1 LIMIT 1', ['admin']);
    if (admin) {
      const projRes = await query(
        `INSERT INTO projects (name, description, color, created_by) VALUES ('General', 'Default project for unsorted generations', '#6B7280', $1) RETURNING id`,
        [admin.id]
      );
      await query(
        `INSERT INTO campaigns (project_id, name, description, color, created_by) VALUES ($1, 'General', 'Default campaign', '#6B7280', $2)`,
        [projRes.rows[0].id, admin.id]
      );
      console.log('  [SEED] Default project "General" + campaign created (upgrade)');
    }
  }
}

/** Ensure every project has a "General" campaign + backfill orphan generations */
export async function migrateCampaigns() {
  // Get all projects that don't have a "General" campaign yet
  const projects = await queryAll(`
    SELECT p.id, p.created_by FROM projects p
    WHERE NOT EXISTS (
      SELECT 1 FROM campaigns c WHERE c.project_id = p.id AND c.name = 'General'
    )
  `);

  if (projects.length > 0) {
    for (const p of projects) {
      await query(
        `INSERT INTO campaigns (project_id, name, description, color, created_by)
         VALUES ($1, 'General', 'Default campaign', '#6B7280', $2)`,
        [p.id, p.created_by]
      );
    }
    console.log(`  [DB] Created "General" campaign for ${projects.length} project(s)`);
  }

  // Backfill: assign orphan generations (have project_id but no campaign_id) to their project's General campaign
  const updated = await query(`
    UPDATE generations g SET campaign_id = c.id
    FROM campaigns c
    WHERE g.project_id = c.project_id
      AND c.name = 'General'
      AND g.campaign_id IS NULL
      AND g.project_id IS NOT NULL
  `);
  if (updated.rowCount > 0) {
    console.log(`  [DB] Backfilled ${updated.rowCount} generation(s) into General campaigns`);
  }
}

export async function cleanupSessions() {
  const result = await query('DELETE FROM sessions WHERE expires_at < NOW()');
  if (result.rowCount > 0) {
    console.log(`  [DB] Cleaned ${result.rowCount} expired session(s)`);
  }
}

/** Delete generations older than 14 days (KIE.AI file expiry) — credit_transactions cascade automatically */
export async function cleanupExpiredGenerations() {
  try {
    const result = await query(`DELETE FROM generations WHERE created_at < NOW() - INTERVAL '14 days'`);
    if (result.rowCount > 0) {
      console.log(`  [DB] Purged ${result.rowCount} expired generations (14d+)`);
    }
  } catch (err) {
    console.error('  [DB] Cleanup error:', err.message);
  }
}

/** Delete expired share links */
export async function cleanupExpiredShareLinks() {
  try {
    const result = await query('DELETE FROM share_links WHERE expires_at < NOW()');
    if (result.rowCount > 0) {
      console.log(`  [DB] Purged ${result.rowCount} expired share link(s)`);
    }
  } catch (err) {
    console.error('  [DB] Share cleanup error:', err.message);
  }
}

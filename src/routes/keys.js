/**
 * API Keys — long-lived bearer tokens for programmatic access (MCP, scripts).
 *
 * Plaintext is shown ONCE on creation, then only the SHA-256 hash is stored.
 * Format: keou_<32 hex> (128 bits entropy — safe without bcrypt-style KDF).
 * Lookup is O(1) via key_hash UNIQUE index.
 */

import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { query, queryOne, queryAll } from '../db.js';
import { logActivity } from '../utils/activity.js';

const router = Router();
const MAX_KEYS_PER_USER = 10;

function generateKey() {
  const plaintext = `keou_${crypto.randomBytes(16).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  const prefix = plaintext.slice(0, 12);
  return { plaintext, hash, prefix };
}

// POST /api/keys — create a new API key (returns plaintext ONCE)
router.post('/', requireAuth, async (req, res) => {
  try {
    const label = (req.body?.label || '').trim();
    if (!label) return res.status(400).json({ error: 'label required' });
    if (label.length > 80) return res.status(400).json({ error: 'label too long (max 80)' });

    const count = await queryOne('SELECT COUNT(*)::int AS c FROM api_keys WHERE user_id = $1', [req.user.id]);
    if (count.c >= MAX_KEYS_PER_USER) {
      return res.status(429).json({ error: `Max ${MAX_KEYS_PER_USER} API keys per user — revoke an old one first` });
    }

    const { plaintext, hash, prefix } = generateKey();
    const row = await queryOne(
      `INSERT INTO api_keys (user_id, key_hash, key_prefix, label)
       VALUES ($1, $2, $3, $4)
       RETURNING id, key_prefix, label, created_at`,
      [req.user.id, hash, prefix, label]
    );

    await logActivity(req.user.id, 'api_key.create', 'api_key', row.id, { label });
    res.status(201).json({
      id: row.id,
      key: plaintext, // shown ONCE — never returned again
      prefix: row.key_prefix,
      label: row.label,
      createdAt: row.created_at,
    });
  } catch (e) {
    console.error('[KEYS] Create error:', e);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// GET /api/keys — list keys (no plaintext)
router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(
      `SELECT id, key_prefix, label, last_used_at, created_at
         FROM api_keys WHERE user_id = $1
        ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ keys: rows.map(r => ({
      id: r.id, prefix: r.key_prefix, label: r.label,
      lastUsedAt: r.last_used_at, createdAt: r.created_at,
    })) });
  } catch (e) {
    console.error('[KEYS] List error:', e);
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

// DELETE /api/keys/:id — revoke
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const result = await query('DELETE FROM api_keys WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Key not found' });
    await logActivity(req.user.id, 'api_key.revoke', 'api_key', id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[KEYS] Delete error:', e);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

export default router;

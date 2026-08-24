import { Router } from 'express';
import { queryOne, queryAll } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

// ─── Activity Feed ───
router.get('/', requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 30));
    const offset = (page - 1) * limit;

    const totalRow = await queryOne('SELECT COUNT(*) as count FROM activity_log');
    const total = parseInt(totalRow.count);

    const items = await queryAll(`
      SELECT a.*, u.name as "userName", u.email as "userEmail"
      FROM activity_log a
      JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    // Parse details JSON (pg returns JSONB as object already, but handle TEXT fallback)
    const parsed = items.map(item => {
      let details = item.details || {};
      if (typeof item.details === 'string') {
        // H9 — one malformed/legacy `details` row must not 500 the whole feed.
        try { details = JSON.parse(item.details || '{}'); } catch { details = {}; }
      }
      return { ...item, details };
    });

    res.json({
      items: parsed,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (e) {
    console.error('Activity error:', e);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

export default router;

import { Router } from 'express';
import { query, queryOne, queryAll } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { addExpiryInfo } from '../utils/expiry.js';
import { refreshR2Url } from '../lib/r2.js';

const router = Router();

// ─── Paginated History with expiry + filters (excludes failed) ───
router.get('/', requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const type = req.query.type;
    const userId = req.query.userId;
    const projectId = req.query.projectId;
    const campaignId = req.query.campaignId;

    let where = "WHERE g.status != 'failed'";
    const params = [];
    let paramIdx = 1;

    if (req.user.role !== 'admin') {
      where += ` AND g.user_id = $${paramIdx++}`;
      params.push(req.user.id);
    } else if (userId) {
      where += ` AND g.user_id = $${paramIdx++}`;
      params.push(parseInt(userId));
    }

    if (type === 'audio') {
      where += ` AND g.type IN ('tts', 'sfx')`;
    } else if (type && ['image', 'video', 'polish', 'tts', 'sfx'].includes(type)) {
      where += ` AND g.type = $${paramIdx++}`;
      params.push(type);
    }

    if (projectId) {
      where += ` AND g.project_id = $${paramIdx++}`;
      params.push(parseInt(projectId));
    }

    if (campaignId) {
      where += ` AND g.campaign_id = $${paramIdx++}`;
      params.push(parseInt(campaignId));
    }

    const tag = req.query.tag;
    if (tag) {
      // Support comma-separated tags (AND logic)
      for (const t of tag.split(',')) {
        const trimmed = t.trim();
        if (trimmed) {
          where += ` AND g.tags LIKE $${paramIdx++}`;
          params.push(`%"${trimmed}"%`);
        }
      }
    }

    const countResult = await queryOne(`SELECT COUNT(*) as count FROM generations g ${where}`, params);
    const total = parseInt(countResult.count);

    const items = await queryAll(`
      SELECT g.id, g.type, g.status, g.input_url, g.result_url, g.format,
             g.credits_used, g.error, g.tags, g.created_at, g.completed_at, g.project_id, g.campaign_id, g.metadata, g.r2_key,
             u.name as "userName", p.name as "projectName",
             ca.name as "campaignName"
      FROM generations g
      JOIN users u ON u.id = g.user_id
      LEFT JOIN projects p ON p.id = g.project_id
      LEFT JOIN campaigns ca ON ca.id = g.campaign_id
      ${where}
      ORDER BY g.created_at DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `, [...params, limit, offset]);

    // Filter lists for the UI
    const users = req.user.role === 'admin'
      ? await queryAll('SELECT id, name FROM users ORDER BY name')
      : [];
    const projects = await queryAll("SELECT id, name FROM projects WHERE status != 'archived' ORDER BY name");

    // Refresh stored R2 input URLs in case the original presigned URL expired.
    // No-op for KIE/external URLs and for newly-uploaded inputs (already long-lived).
    const refreshed = await Promise.all(items.map(async (item) => ({
      ...item,
      input_url: await refreshR2Url(item.input_url),
    })));

    res.json({
      items: addExpiryInfo(refreshed),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      filters: { users, projects },
    });
  } catch (e) {
    console.error('History error:', e);
    res.status(500).json({ error: 'Failed to load history' });
  }
});

// ─── Get all unique tags ───
router.get('/tags', requireAuth, async (req, res) => {
  try {
    // Aggregate distinct tags in SQL via JSONB unnest instead of loading all rows
    // and parsing JSON in a JS loop. Scales O(distinct tags) not O(rows × tags).
    const userFilter = req.user.role === 'admin' ? '' : 'AND user_id = $1';
    const params = req.user.role === 'admin' ? [] : [req.user.id];
    // C2 — only cast rows that are actually JSON-array-shaped. One malformed/legacy
    // `tags` value would otherwise abort the whole statement (platform-wide 500).
    // The filter runs in a subquery so the ::jsonb cast only ever sees '['-prefixed rows.
    const rows = await queryAll(`
      SELECT DISTINCT jsonb_array_elements_text(t.tags::jsonb) AS tag
        FROM (
          SELECT tags FROM generations
           WHERE tags IS NOT NULL AND tags ~ '^\\[' AND tags != '[]' ${userFilter}
        ) t
       ORDER BY tag ASC
    `, params);

    res.json({ tags: rows.map(r => r.tag) });
  } catch (e) {
    console.error('Tags error:', e);
    res.status(500).json({ error: 'Failed to load tags' });
  }
});

// ─── Get a single generation by ID ───
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const genId = parseInt(req.params.id);
    if (!genId) return res.status(400).json({ error: 'Invalid ID' });
    let genQuery = `SELECT g.id, g.user_id, g.type, g.status, g.input_url, g.result_url, g.format, g.created_at, g.metadata,
              p.name as project_name
       FROM generations g
       LEFT JOIN projects p ON g.project_id = p.id
       WHERE g.id = $1`;
    const genParams = [genId];

    if (req.user.role !== 'admin') {
      genQuery += ' AND g.user_id = $2';
      genParams.push(req.user.id);
    }

    const gen = await queryOne(genQuery, genParams);
    if (!gen) return res.status(404).json({ error: 'Not found' });
    gen.input_url = await refreshR2Url(gen.input_url);
    res.json(gen);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch generation' });
  }
});

// ─── Delete a generation ───
// ─── Bulk-move generations to a project (and optionally a campaign) ───
// Used by Content Library "Move to client" bulk action.
router.post('/bulk-move', requireAuth, async (req, res) => {
  try {
    const { generationIds, projectId, campaignId } = req.body;
    if (!Array.isArray(generationIds) || generationIds.length === 0) {
      return res.status(400).json({ error: 'generationIds required' });
    }
    if (generationIds.length > 500) {
      return res.status(400).json({ error: 'Too many items (max 500 per call)' });
    }
    const ids = generationIds.map(n => parseInt(n)).filter(n => Number.isInteger(n) && n > 0);
    if (ids.length === 0) return res.status(400).json({ error: 'No valid generation IDs' });

    const targetProjectId = projectId ? parseInt(projectId) : null;
    if (!targetProjectId) return res.status(400).json({ error: 'projectId required' });

    // Verify project exists (cross-tenant isolation already at DB level)
    const project = await queryOne('SELECT id FROM projects WHERE id = $1', [targetProjectId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Resolve target campaign — explicit ID, or fall back to project's "General" campaign
    let targetCampaignId = campaignId ? parseInt(campaignId) : null;
    if (targetCampaignId) {
      const camp = await queryOne('SELECT id FROM campaigns WHERE id = $1 AND project_id = $2', [targetCampaignId, targetProjectId]);
      if (!camp) return res.status(400).json({ error: 'Campaign does not belong to this project' });
    } else {
      const general = await queryOne(
        "SELECT id FROM campaigns WHERE project_id = $1 AND name = 'General' ORDER BY id LIMIT 1",
        [targetProjectId]
      );
      targetCampaignId = general?.id || null;
    }

    // Restrict to generations the user owns (or all, if admin)
    const ownershipFilter = req.user.role === 'admin' ? '' : 'AND user_id = $3';
    const params = req.user.role === 'admin'
      ? [targetProjectId, ids]
      : [targetProjectId, ids, req.user.id];
    const campaignClause = targetCampaignId ? `, campaign_id = ${parseInt(targetCampaignId)}` : '';

    const result = await query(
      `UPDATE generations SET project_id = $1${campaignClause}
        WHERE id = ANY($2) ${ownershipFilter}
        RETURNING id`,
      params
    );

    res.json({ ok: true, moved: result.rowCount, projectId: targetProjectId, campaignId: targetCampaignId });
  } catch (e) {
    console.error('Bulk move error:', e);
    res.status(500).json({ error: 'Failed to move assets' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const genId = parseInt(req.params.id);
    const gen = await queryOne('SELECT * FROM generations WHERE id = $1', [genId]);
    if (!gen) return res.status(404).json({ error: 'Not found' });

    if (req.user.role !== 'admin' && gen.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await query('DELETE FROM generations WHERE id = $1', [genId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Delete generation error:', e);
    res.status(500).json({ error: 'Failed to delete' });
  }
});

export default router;

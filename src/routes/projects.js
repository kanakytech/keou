import { Router } from 'express';
import { isCommunity } from '../middleware/edition.js';
import { query, queryOne, queryAll } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { logActivity } from '../utils/activity.js';
import { addExpiryInfo } from '../utils/expiry.js';

const router = Router();

// ─── Create Project ───
const MAX_NAME = 100;
const MAX_DESC = 500;
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, description, color } = req.body;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Project name required' });
    const trimmedName = name.trim();
    if (trimmedName.length === 0) return res.status(400).json({ error: 'Project name cannot be empty' });
    if (trimmedName.length > MAX_NAME) return res.status(400).json({ error: `Project name must be ${MAX_NAME} characters or less` });
    if (description != null && typeof description !== 'string') return res.status(400).json({ error: 'Description must be a string' });
    if (description && description.length > MAX_DESC) return res.status(400).json({ error: `Description must be ${MAX_DESC} characters or less` });
    if (color != null && !HEX_COLOR.test(color)) return res.status(400).json({ error: 'Color must be a hex color (e.g. #3B82F6)' });

    const result = await query(
      'INSERT INTO projects (name, description, color, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [trimmedName, description?.trim() || null, color || '#0A0A0A', req.user.id]
    );
    const projectId = result.rows[0].id;

    // Auto-create "General" campaign for the new project
    await query(
      `INSERT INTO campaigns (project_id, name, description, color, created_by) VALUES ($1, 'General', 'Default campaign', '#6B7280', $2)`,
      [projectId, req.user.id]
    );

    logActivity(req.user.id, 'project_create', 'project', projectId, { name });

    res.json({ ok: true, projectId });
  } catch (e) {
    console.error('Project create error:', e);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// ─── List Projects ───
router.get('/', requireAuth, async (req, res) => {
  try {
    const { status } = req.query;
    let statusFilter = "p.status != 'archived'";
    const params = [];

    if (status) {
      statusFilter = 'p.status = $1';
      params.push(status);
    }

    // Community edition: accounts are isolated — members only see their own
    // projects. Enterprise keeps the shared agency workspace (by design).
    if (isCommunity() && req.user.role !== 'admin') {
      params.push(req.user.id);
      statusFilter += ` AND p.created_by = $${params.length}`;
    }

    const projects = await queryAll(`
      SELECT p.*,
        u.name as "createdByName",
        COUNT(DISTINCT g.id) as "genCount",
        SUM(CASE WHEN g.type IN ('image','polish','remix','adapt') THEN 1 ELSE 0 END) as "imageCount",
        SUM(CASE WHEN g.type = 'video' THEN 1 ELSE 0 END) as "videoCount",
        (SELECT COUNT(*) FROM campaigns c WHERE c.project_id = p.id AND c.status != 'archived') as "campaignCount"
      FROM projects p
      JOIN users u ON u.id = p.created_by
      LEFT JOIN generations g ON g.project_id = p.id AND g.status = 'completed'
      WHERE ${statusFilter}
      GROUP BY p.id, u.name
      ORDER BY p.updated_at DESC
    `, params);

    res.json({ projects });
  } catch (e) {
    console.error('Project list error:', e);
    res.status(500).json({ error: 'Failed to load projects' });
  }
});

// ─── Get Project Detail ───
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const project = await queryOne(`
      SELECT p.*, u.name as "createdByName",
        COUNT(g.id) FILTER (WHERE g.status = 'completed' AND g.type IN ('image','polish')) as "images",
        COUNT(g.id) FILTER (WHERE g.status = 'completed' AND g.type = 'video') as "videos",
        COUNT(g.id) FILTER (WHERE g.status = 'completed') as "totalGens",
        COUNT(g.id) FILTER (WHERE g.status = 'completed' AND g.created_at > NOW() - INTERVAL '14 days') as "activeGens"
      FROM projects p
      JOIN users u ON u.id = p.created_by
      LEFT JOIN generations g ON g.project_id = p.id
      WHERE p.id = $1 ${isCommunity() && req.user.role !== 'admin' ? 'AND p.created_by = $2' : ''}
      GROUP BY p.id, u.name
    `, isCommunity() && req.user.role !== 'admin' ? [req.params.id, req.user.id] : [req.params.id]);

    if (!project) return res.status(404).json({ error: 'Project not found' });

    res.json({ project });
  } catch (e) {
    console.error('Project detail error:', e);
    res.status(500).json({ error: 'Failed to load project' });
  }
});

// ─── Update Project (admin or project owner) ───
const VALID_STATUSES = ['active', 'completed', 'archived'];
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { name, description, color, status } = req.body;
    if (name != null && (typeof name !== 'string' || name.length > MAX_NAME)) return res.status(400).json({ error: `Project name must be a string of ${MAX_NAME} chars max` });
    if (description != null && (typeof description !== 'string' || description.length > MAX_DESC)) return res.status(400).json({ error: `Description must be ${MAX_DESC} characters or less` });
    if (color != null && !HEX_COLOR.test(color)) return res.status(400).json({ error: 'Color must be a hex color' });
    if (status != null && !VALID_STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of: ${VALID_STATUSES.join(', ')}` });

    const project = await queryOne('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Only admin or project creator can update
    if (req.user.role !== 'admin' && project.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to modify this project' });
    }

    await query(`
      UPDATE projects SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        color = COALESCE($3, color),
        status = COALESCE($4, status),
        updated_at = NOW()
      WHERE id = $5
    `, [name || null, description || null, color || null, status || null, req.params.id]);

    res.json({ ok: true });
  } catch (e) {
    console.error('Project update error:', e);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

// ─── Archive Project (admin or project owner) ───
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const project = await queryOne('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (req.user.role !== 'admin' && project.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to archive this project' });
    }

    await query("UPDATE projects SET status = 'archived', updated_at = NOW() WHERE id = $1", [req.params.id]);
    logActivity(req.user.id, 'project_archive', 'project', parseInt(req.params.id), { name: project.name });

    res.json({ ok: true });
  } catch (e) {
    console.error('Project archive error:', e);
    res.status(500).json({ error: 'Failed to archive project' });
  }
});

// ─── Assign Generation to Project (must own the generation) ───
router.post('/:id/assign', requireAuth, async (req, res) => {
  try {
    const { generationId } = req.body;
    if (!generationId) return res.status(400).json({ error: 'generationId required' });

    // Verify the generation belongs to this user (or user is admin)
    const gen = await queryOne('SELECT user_id FROM generations WHERE id = $1', [generationId]);
    if (!gen) return res.status(404).json({ error: 'Generation not found' });
    if (req.user.role !== 'admin' && gen.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to move this generation' });
    }

    // Verify project exists
    const project = await queryOne('SELECT id FROM projects WHERE id = $1', [req.params.id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // If campaignId provided, use it; otherwise assign to "General" campaign of the project
    let campaignId = req.body.campaignId;
    if (!campaignId) {
      const generalCampaign = await queryOne(
        "SELECT id FROM campaigns WHERE project_id = $1 AND name = 'General' ORDER BY id ASC LIMIT 1",
        [req.params.id]
      );
      campaignId = generalCampaign?.id || null;
    }

    await query('UPDATE generations SET project_id = $1, campaign_id = $2 WHERE id = $3',
      [req.params.id, campaignId, generationId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Assign error:', e);
    res.status(500).json({ error: 'Failed to assign generation' });
  }
});

export default router;

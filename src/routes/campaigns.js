import { Router } from 'express';
import { query, queryOne, queryAll } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { logActivity } from '../utils/activity.js';

const router = Router();

// ─── Create Campaign ───
const MAX_NAME = 100;
const MAX_DESC = 500;
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

router.post('/', requireAuth, async (req, res) => {
  try {
    const { projectId, name, description, color } = req.body;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Campaign name required' });
    const trimmedName = name.trim();
    if (trimmedName.length === 0) return res.status(400).json({ error: 'Campaign name cannot be empty' });
    if (trimmedName.length > MAX_NAME) return res.status(400).json({ error: `Campaign name must be ${MAX_NAME} characters or less` });
    if (description != null && typeof description !== 'string') return res.status(400).json({ error: 'Description must be a string' });
    if (description && description.length > MAX_DESC) return res.status(400).json({ error: `Description must be ${MAX_DESC} characters or less` });
    if (color != null && !HEX_COLOR.test(color)) return res.status(400).json({ error: 'Color must be a hex color' });

    // Verify project exists
    const project = await queryOne('SELECT id FROM projects WHERE id = $1', [projectId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const result = await query(
      'INSERT INTO campaigns (project_id, name, description, color, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [projectId, trimmedName, description?.trim() || null, color || '#06B6D4', req.user.id]
    );
    const campaignId = result.rows[0].id;

    logActivity(req.user.id, 'campaign_create', 'campaign', campaignId, { name, projectId });

    res.json({ ok: true, campaignId });
  } catch (e) {
    console.error('Campaign create error:', e);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// ─── List Campaigns (for a project) ───
router.get('/', requireAuth, async (req, res) => {
  try {
    const { projectId, status } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId query param required' });

    let statusFilter = "c.status != 'archived'";
    const params = [parseInt(projectId)];

    if (status) {
      statusFilter = 'c.status = $2';
      params.push(status);
    }

    const campaigns = await queryAll(`
      SELECT c.*,
        u.name as "createdByName",
        COUNT(g.id) FILTER (WHERE g.status = 'completed') as "genCount",
        COUNT(g.id) FILTER (WHERE g.status = 'completed' AND g.type IN ('image','polish','img-upscale')) as "imageCount",
        COUNT(g.id) FILTER (WHERE g.status = 'completed' AND g.type = 'video') as "videoCount",
        COUNT(g.id) FILTER (WHERE g.status = 'completed' AND g.type IN ('tts','sfx')) as "audioCount"
      FROM campaigns c
      JOIN users u ON u.id = c.created_by
      LEFT JOIN generations g ON g.campaign_id = c.id
      WHERE c.project_id = $1 AND ${statusFilter}
      GROUP BY c.id, u.name
      ORDER BY c.created_at DESC
    `, params);

    res.json({ campaigns });
  } catch (e) {
    console.error('Campaign list error:', e);
    res.status(500).json({ error: 'Failed to load campaigns' });
  }
});

// ─── Get Campaign Detail ───
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const campaign = await queryOne(`
      SELECT c.*, u.name as "createdByName",
        p.name as "projectName", p.id as "projectId",
        COUNT(g.id) FILTER (WHERE g.status = 'completed' AND g.type IN ('image','polish','img-upscale')) as "images",
        COUNT(g.id) FILTER (WHERE g.status = 'completed' AND g.type = 'video') as "videos",
        COUNT(g.id) FILTER (WHERE g.status = 'completed' AND g.type IN ('tts','sfx')) as "audio",
        COUNT(g.id) FILTER (WHERE g.status = 'completed') as "totalGens",
        COUNT(g.id) FILTER (WHERE g.status = 'completed' AND g.created_at > NOW() - INTERVAL '14 days') as "activeGens"
      FROM campaigns c
      JOIN users u ON u.id = c.created_by
      JOIN projects p ON p.id = c.project_id
      LEFT JOIN generations g ON g.campaign_id = c.id
      WHERE c.id = $1
      GROUP BY c.id, u.name, p.name, p.id
    `, [req.params.id]);

    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    res.json({ campaign });
  } catch (e) {
    console.error('Campaign detail error:', e);
    res.status(500).json({ error: 'Failed to load campaign' });
  }
});

// ─── Update Campaign ───
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { name, description, color, status } = req.body;
    const campaign = await queryOne('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    if (req.user.role !== 'admin' && campaign.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to modify this campaign' });
    }

    await query(`
      UPDATE campaigns SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        color = COALESCE($3, color),
        status = COALESCE($4, status),
        updated_at = NOW()
      WHERE id = $5
    `, [name || null, description || null, color || null, status || null, req.params.id]);

    res.json({ ok: true });
  } catch (e) {
    console.error('Campaign update error:', e);
    res.status(500).json({ error: 'Failed to update campaign' });
  }
});

// ─── Archive Campaign ───
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const campaign = await queryOne('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    if (req.user.role !== 'admin' && campaign.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to archive this campaign' });
    }

    await query("UPDATE campaigns SET status = 'archived', updated_at = NOW() WHERE id = $1", [req.params.id]);
    logActivity(req.user.id, 'campaign_archive', 'campaign', parseInt(req.params.id), { name: campaign.name });

    res.json({ ok: true });
  } catch (e) {
    console.error('Campaign archive error:', e);
    res.status(500).json({ error: 'Failed to archive campaign' });
  }
});

// ─── Assign Generation to Campaign ───
router.post('/:id/assign', requireAuth, async (req, res) => {
  try {
    const { generationId } = req.body;
    if (!generationId) return res.status(400).json({ error: 'generationId required' });

    const gen = await queryOne('SELECT user_id FROM generations WHERE id = $1', [generationId]);
    if (!gen) return res.status(404).json({ error: 'Generation not found' });
    if (req.user.role !== 'admin' && gen.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to move this generation' });
    }

    const campaign = await queryOne('SELECT id, project_id FROM campaigns WHERE id = $1', [req.params.id]);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Update both project_id and campaign_id
    await query('UPDATE generations SET project_id = $1, campaign_id = $2 WHERE id = $3',
      [campaign.project_id, campaign.id, generationId]);

    res.json({ ok: true });
  } catch (e) {
    console.error('Campaign assign error:', e);
    res.status(500).json({ error: 'Failed to assign generation' });
  }
});

export default router;

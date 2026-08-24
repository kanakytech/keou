import { Router } from 'express';
import { queryOne, queryAll } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { getQuotaSummary } from '../utils/credits.js';
import { addExpiryInfo } from '../utils/expiry.js';

const router = Router();

// ─── Agency Dashboard ───
router.get('/', requireAdmin, async (req, res) => {
  try {
    const quota = await getQuotaSummary();

    const teamStats = await queryOne(`
      SELECT
        COUNT(*) as "totalMembers",
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as "activeMembers",
        SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) as "suspendedMembers"
      FROM users
    `);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const genStats = await queryOne(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN type = 'image' AND status = 'completed' THEN 1 ELSE 0 END) as images,
        SUM(CASE WHEN type = 'video' AND status = 'completed' THEN 1 ELSE 0 END) as videos,
        SUM(CASE WHEN type = 'polish' AND status = 'completed' THEN 1 ELSE 0 END) as polished,
        SUM(CASE WHEN type = 'img-upscale' AND status = 'completed' THEN 1 ELSE 0 END) as "imgUpscale",
        SUM(CASE WHEN type = 'vid-upscale' AND status = 'completed' THEN 1 ELSE 0 END) as "vidUpscale",
        SUM(CASE WHEN type = 'tts' AND status = 'completed' THEN 1 ELSE 0 END) as tts,
        SUM(CASE WHEN type = 'sfx' AND status = 'completed' THEN 1 ELSE 0 END) as sfx,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM generations
      WHERE created_at >= $1
    `, [thirtyDaysAgo]);

    const leaderboard = await queryAll(`
      SELECT u.id, u.name, u.email, COUNT(g.id) as "genCount"
      FROM users u
      JOIN generations g ON g.user_id = u.id
      WHERE g.created_at >= $1 AND g.status = 'completed'
      GROUP BY u.id, u.name, u.email
      ORDER BY "genCount" DESC
      LIMIT 5
    `, [thirtyDaysAgo]);

    const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString();
    const usageByDay = await queryAll(`
      SELECT
        DATE(created_at) as day,
        SUM(CASE WHEN type IN ('image','polish') THEN 1 ELSE 0 END) as images,
        SUM(CASE WHEN type = 'video' THEN 1 ELSE 0 END) as videos
      FROM generations
      WHERE created_at >= $1
      GROUP BY DATE(created_at)
      ORDER BY day ASC
    `, [fourteenDaysAgo]);

    const recentActivity = await queryAll(`
      SELECT a.*, u.name as "userName"
      FROM activity_log a
      JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC
      LIMIT 10
    `);

    const recentGens = await queryAll(`
      SELECT g.id, g.type, g.status, g.result_url, g.format, g.created_at, g.completed_at, g.metadata, g.r2_key, u.name as "userName"
      FROM generations g
      JOIN users u ON u.id = g.user_id
      ORDER BY g.created_at DESC
      LIMIT 8
    `);

    const activeProjects = await queryOne("SELECT COUNT(*) as count FROM projects WHERE status = 'active'");

    res.json({
      quota,
      teamStats,
      genStats,
      leaderboard,
      usageByDay,
      recentActivity,
      recentGenerations: addExpiryInfo(recentGens),
      activeProjects: parseInt(activeProjects.count),
    });
  } catch (e) {
    console.error('Dashboard error:', e);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

export default router;

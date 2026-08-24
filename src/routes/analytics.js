import { Router } from 'express';
import { queryOne, queryAll } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

/* ═══════════════════════════════════════════
   KEOU AGENCY — Analytics API
   Business-oriented metrics for agencies
   ═══════════════════════════════════════════ */

// ── Market reference: CONSERVATIVE estimates (what agencies actually pay) ──
// Based on: freelancer rates for product photography in NZ/AU/US mid-market
// Photographer doing 50 product photos = ~$800-1200 → $16-24/photo
// Basic product video (10-15s loop) = $50-80
// These are intentionally LOW to stay credible — better to underpromise
const MARKET = {
  image:         { cost: 18,  time: 25 },   // $18/photo (shoot + basic edit), 25 min
  polish:        { cost: 8,   time: 10 },   // $8/retouch, 10 min
  video:         { cost: 65,  time: 45 },   // $65/product video, 45 min
  'img-upscale': { cost: 5,   time: 3 },    // $5/upscale, 3 min
  'vid-upscale': { cost: 20,  time: 10 },   // $20/vid upscale, 10 min
  tts:           { cost: 15,  time: 15 },   // $15/voiceover, 15 min
  sfx:           { cost: 10,  time: 10 },   // $10/sound effect, 10 min
};

// Keou time per visual (upload + generate + download) in minutes
const KEOU_TIME = {
  image: 2, polish: 1.5, video: 3,
  'img-upscale': 1, 'vid-upscale': 2,
  tts: 1, sfx: 1,
};

// API costs (what Keou actually costs per generation)
const API_COST = {
  image: 0.09, polish: 0.09, video: 0.15,
  'img-upscale': 0.12, 'vid-upscale': 0.70,
  tts: 0.05, sfx: 0.05,
};

// ─── 1. ROI Overview (30d) ───
router.get('/roi', requireAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const stats = await queryAll(`
      SELECT type, COUNT(*) as count,
        COALESCE(SUM(EXTRACT(EPOCH FROM (completed_at - created_at)) / 60), 0) as "realTimeMin"
      FROM generations
      WHERE status = 'completed' AND created_at >= $1
      GROUP BY type
    `, [since]);

    let totalVisuals = 0;
    let traditionalTimeMin = 0;
    let realKeouTimeMin = 0;
    let marketCost = 0;
    let keouCost = 0;
    const breakdown = {};

    for (const row of stats) {
      const t = row.type;
      const c = parseInt(row.count);
      const ref = MARKET[t] || { cost: 15, time: 15 };
      const apiCost = API_COST[t] || 0.09;
      const realTime = parseFloat(row.realTimeMin || 0);

      totalVisuals += c;
      traditionalTimeMin += c * ref.time;
      realKeouTimeMin += realTime;
      marketCost += c * ref.cost;
      keouCost += c * apiCost;
      breakdown[t] = { count: c, marketCost: c * ref.cost, keouCost: c * apiCost, traditionalTime: c * ref.time, realKeouTime: Math.round(realTime * 10) / 10 };
    }

    // Override with real tracked costs when available
    try {
      const rc = await queryOne(
        `SELECT COALESCE(SUM(CASE WHEN api_cost > 0 THEN api_cost ELSE 0 END), 0) as tracked,
                COUNT(CASE WHEN api_cost > 0 THEN 1 END) as tracked_count
         FROM generations WHERE status = 'completed' AND created_at >= $1`,
        [since]
      );
      if (parseInt(rc.tracked_count) > 0) {
        // Use tracked costs for new gens + fallback estimate for old untracked gens
        const untrackedCount = totalVisuals - parseInt(rc.tracked_count);
        const avgEstimate = totalVisuals > 0 ? keouCost / totalVisuals : 0.09;
        keouCost = parseFloat(rc.tracked) + (untrackedCount * avgEstimate);
        keouCost = Math.round(keouCost * 100) / 100;
      }
    } catch (err) { console.error('[ANALYTICS COST]', err.message); }

    const keouTimeMin = Math.round(realKeouTimeMin * 10) / 10;
    const timeSavedMin = traditionalTimeMin - keouTimeMin;

    // All-time totals for comparison
    const allTime = await queryOne(`
      SELECT COUNT(*) as count FROM generations WHERE status = 'completed'
    `);

    res.json({
      period: days,
      totalVisuals,
      traditionalTimeMin,
      traditionalTimeHours: Math.round(traditionalTimeMin / 60 * 10) / 10,
      keouTimeMin,
      keouTimeHours: Math.round(keouTimeMin / 60 * 10) / 10,
      timeSavedMin,
      timeSavedHours: Math.round(timeSavedMin / 60 * 10) / 10,
      timeReduction: traditionalTimeMin > 0 ? Math.round((timeSavedMin / traditionalTimeMin) * 100) : 0,
      marketCost: Math.round(marketCost),
      keouCost: Math.round(keouCost * 100) / 100,
      savings: Math.round(marketCost - keouCost),
      savingsPercent: marketCost > 0 ? Math.round(((marketCost - keouCost) / marketCost) * 100) : 0,
      breakdown,
      allTimeVisuals: parseInt(allTime.count),
    });
  } catch (e) {
    console.error('Analytics ROI error:', e);
    res.status(500).json({ error: 'Failed to load ROI data' });
  }
});

// ─── 2. Per-Client (Project) Stats ───
router.get('/clients', requireAdmin, async (req, res) => {
  try {
    const clients = await queryAll(`
      SELECT
        p.id, p.name, p.color, p.status, p.created_at,
        COUNT(DISTINCT c.id) as "campaignCount",
        COUNT(g.id) FILTER (WHERE g.status = 'completed') as "totalVisuals",
        COUNT(g.id) FILTER (WHERE g.status = 'completed' AND g.type IN ('image','polish','img-upscale')) as "images",
        COUNT(g.id) FILTER (WHERE g.status = 'completed' AND g.type = 'video') as "videos",
        COUNT(g.id) FILTER (WHERE g.status = 'completed' AND g.type IN ('tts','sfx')) as "audio",
        MAX(g.created_at) FILTER (WHERE g.status = 'completed') as "lastActivity",
        COALESCE(SUM(EXTRACT(EPOCH FROM (g.completed_at - g.created_at)) / 60) FILTER (WHERE g.status = 'completed'), 0) as "realKeouTimeMin"
      FROM projects p
      LEFT JOIN campaigns c ON c.project_id = p.id
      LEFT JOIN generations g ON g.project_id = p.id
      GROUP BY p.id
      ORDER BY "totalVisuals" DESC
    `);

    // Fetch real tracked costs per project
    const projectCosts = await queryAll(`
      SELECT project_id,
        COALESCE(SUM(CASE WHEN api_cost > 0 THEN api_cost ELSE 0 END), 0) as tracked,
        COUNT(CASE WHEN api_cost > 0 THEN 1 END) as tracked_count
      FROM generations WHERE status = 'completed' AND project_id IS NOT NULL
      GROUP BY project_id
    `);
    const costByProject = {};
    for (const pc of projectCosts) {
      costByProject[pc.project_id] = { tracked: parseFloat(pc.tracked), trackedCount: parseInt(pc.tracked_count) };
    }

    // Enrich with cost + time (real Keou time from DB)
    const enriched = clients.map(client => {
      const imgs = parseInt(client.images || 0);
      const vids = parseInt(client.videos || 0);
      const audio = parseInt(client.audio || 0);
      const total = parseInt(client.totalVisuals || 0);

      const marketCost = imgs * MARKET.image.cost + vids * MARKET.video.cost + audio * MARKET.tts.cost;
      let keouCost = imgs * API_COST.image + vids * API_COST.video + audio * API_COST.tts;
      const traditionalTime = imgs * MARKET.image.time + vids * MARKET.video.time + audio * MARKET.tts.time;
      const keouTime = Math.round(parseFloat(client.realKeouTimeMin || 0) * 10) / 10;

      // Override with real tracked costs when available
      const pc = costByProject[client.id];
      if (pc && pc.trackedCount > 0) {
        const untrackedCount = total - pc.trackedCount;
        const avgEstimate = total > 0 ? keouCost / total : 0.09;
        keouCost = pc.tracked + (untrackedCount * avgEstimate);
        keouCost = Math.round(keouCost * 100) / 100;
      }

      return {
        ...client,
        totalVisuals: total,
        images: imgs,
        videos: vids,
        audio,
        campaignCount: parseInt(client.campaignCount || 0),
        marketCost: Math.round(marketCost),
        keouCost: Math.round(keouCost * 100) / 100,
        savings: Math.round(marketCost - keouCost),
        traditionalTimeMin: traditionalTime,
        keouTimeMin: keouTime,
        timeSavedMin: traditionalTime - keouTime,
      };
    });

    res.json({ clients: enriched });
  } catch (e) {
    console.error('Analytics clients error:', e);
    res.status(500).json({ error: 'Failed to load client stats' });
  }
});

// ─── 3. Production Velocity (daily output + trends) ───
router.get('/velocity', requireAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    // Daily production
    const daily = await queryAll(`
      SELECT
        DATE(created_at) as day,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE type IN ('image','polish','img-upscale')) as images,
        COUNT(*) FILTER (WHERE type = 'video') as videos,
        COUNT(*) FILTER (WHERE type IN ('tts','sfx')) as audio
      FROM generations
      WHERE status = 'completed' AND created_at >= $1
      GROUP BY DATE(created_at)
      ORDER BY day ASC
    `, [since]);

    // Average processing time (completed tasks that had a task_id)
    // H10 — real processing time = completed_at - created_at. (The old self-join
    // g2.id = g.id compared a row to itself → always 0.)
    const avgTime = await queryOne(`
      SELECT
        ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - created_at)))) as "avgSeconds"
      FROM generations
      WHERE status = 'completed'
        AND completed_at IS NOT NULL
        AND task_id IS NOT NULL
        AND created_at >= $1
    `, [since]);

    // This vs previous period comparison
    const prevSince = new Date(Date.now() - days * 2 * 86400000).toISOString();
    const comparison = await queryAll(`
      SELECT
        CASE WHEN created_at >= $1 THEN 'current' ELSE 'previous' END as period,
        COUNT(*) as total
      FROM generations
      WHERE status = 'completed' AND created_at >= $2
      GROUP BY period
    `, [since, prevSince]);

    const current = parseInt(comparison.find(c => c.period === 'current')?.total || 0);
    const previous = parseInt(comparison.find(c => c.period === 'previous')?.total || 0);
    const trend = previous > 0 ? Math.round(((current - previous) / previous) * 100) : (current > 0 ? 100 : 0);

    // Peak day
    const peak = daily.reduce((best, d) => (parseInt(d.total) > parseInt(best.total || 0) ? d : best), { total: 0 });

    res.json({
      period: days,
      daily,
      avgPerDay: daily.length > 0 ? Math.round(daily.reduce((s, d) => s + parseInt(d.total), 0) / daily.length) : 0,
      peakDay: peak.day || null,
      peakCount: parseInt(peak.total || 0),
      trend,
      currentPeriod: current,
      previousPeriod: previous,
    });
  } catch (e) {
    console.error('Analytics velocity error:', e);
    res.status(500).json({ error: 'Failed to load velocity data' });
  }
});

// ─── 4. Campaign Performance ───
router.get('/campaigns', requireAdmin, async (req, res) => {
  try {
    const campaigns = await queryAll(`
      SELECT
        c.id, c.name, c.color, c.status, c.created_at,
        p.name as "projectName", p.id as "projectId",
        COUNT(g.id) FILTER (WHERE g.status = 'completed') as "totalVisuals",
        COUNT(g.id) FILTER (WHERE g.status = 'completed' AND g.type IN ('image','polish','img-upscale')) as "images",
        COUNT(g.id) FILTER (WHERE g.status = 'completed' AND g.type = 'video') as "videos",
        COUNT(g.id) FILTER (WHERE g.status = 'completed' AND g.type IN ('tts','sfx')) as "audio",
        COUNT(g.id) FILTER (WHERE g.status = 'failed') as "failed",
        MIN(g.created_at) FILTER (WHERE g.status = 'completed') as "firstGen",
        MAX(g.created_at) FILTER (WHERE g.status = 'completed') as "lastGen"
      FROM campaigns c
      JOIN projects p ON p.id = c.project_id
      LEFT JOIN generations g ON g.campaign_id = c.id
      GROUP BY c.id, p.name, p.id
      HAVING COUNT(g.id) FILTER (WHERE g.status = 'completed') > 0
      ORDER BY "totalVisuals" DESC
    `);

    const enriched = campaigns.map(camp => {
      const imgs = parseInt(camp.images || 0);
      const vids = parseInt(camp.videos || 0);
      const total = parseInt(camp.totalVisuals || 0);
      const keouCost = imgs * API_COST.image + vids * API_COST.video;
      const marketCost = imgs * MARKET.image.cost + vids * MARKET.video.cost;

      // Duration in days
      let durationDays = null;
      if (camp.firstGen && camp.lastGen) {
        durationDays = Math.max(1, Math.ceil((new Date(camp.lastGen) - new Date(camp.firstGen)) / 86400000));
      }

      return {
        ...camp,
        totalVisuals: total,
        images: imgs,
        videos: vids,
        audio: parseInt(camp.audio || 0),
        failed: parseInt(camp.failed || 0),
        keouCost: Math.round(keouCost * 100) / 100,
        marketCost: Math.round(marketCost),
        durationDays,
        avgPerDay: durationDays ? Math.round(total / durationDays * 10) / 10 : total,
      };
    });

    res.json({ campaigns: enriched });
  } catch (e) {
    console.error('Analytics campaigns error:', e);
    res.status(500).json({ error: 'Failed to load campaign stats' });
  }
});

// ─── 5. Savings Report (monthly summary) ───
router.get('/savings', requireAdmin, async (req, res) => {
  try {
    // Monthly breakdown (last 6 months)
    const months = await queryAll(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') as month,
        type,
        COUNT(*) as count,
        COALESCE(SUM(EXTRACT(EPOCH FROM (completed_at - created_at)) / 60), 0) as "realTimeMin"
      FROM generations
      WHERE status = 'completed'
        AND created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '5 months'
      GROUP BY month, type
      ORDER BY month ASC
    `);

    // Group by month
    const byMonth = {};
    for (const row of months) {
      if (!byMonth[row.month]) {
        byMonth[row.month] = { month: row.month, types: {}, totalVisuals: 0, marketCost: 0, keouCost: 0, traditionalTimeMin: 0, realKeouTimeMin: 0 };
      }
      const m = byMonth[row.month];
      const c = parseInt(row.count);
      const ref = MARKET[row.type] || { cost: 15, time: 15 };
      const apiCost = API_COST[row.type] || 0.09;

      m.types[row.type] = c;
      m.totalVisuals += c;
      m.marketCost += c * ref.cost;
      m.keouCost += c * apiCost;
      m.traditionalTimeMin += c * ref.time;
      m.realKeouTimeMin += parseFloat(row.realTimeMin || 0);
    }

    const monthlyData = Object.values(byMonth).map(m => ({
      ...m,
      marketCost: Math.round(m.marketCost),
      keouCost: Math.round(m.keouCost * 100) / 100,
      savings: Math.round(m.marketCost - m.keouCost),
      traditionalTimeHours: Math.round(m.traditionalTimeMin / 60 * 10) / 10,
      keouTimeHours: Math.round(m.realKeouTimeMin / 60 * 10) / 10,
      timeSavedMin: m.traditionalTimeMin - m.realKeouTimeMin,
      timeSavedHours: Math.round((m.traditionalTimeMin - m.realKeouTimeMin) / 60 * 10) / 10,
    }));

    // Current month highlight
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const current = monthlyData.find(m => m.month === currentMonth) || {
      month: currentMonth, totalVisuals: 0, marketCost: 0, keouCost: 0, savings: 0, timeSavedHours: 0,
    };

    // All-time totals (with real measured time)
    const allTime = await queryOne(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE type IN ('image','polish','img-upscale')) as images,
        COUNT(*) FILTER (WHERE type = 'video') as videos,
        COUNT(*) FILTER (WHERE type IN ('tts','sfx')) as audio,
        COALESCE(SUM(EXTRACT(EPOCH FROM (completed_at - created_at)) / 60), 0) as "realKeouTimeMin"
      FROM generations
      WHERE status = 'completed'
    `);

    const allImgs = parseInt(allTime.images || 0);
    const allVids = parseInt(allTime.videos || 0);
    const allAudio = parseInt(allTime.audio || 0);
    const allTradTime = allImgs * MARKET.image.time + allVids * MARKET.video.time + allAudio * MARKET.tts.time;
    const allRealKeouTime = parseFloat(allTime.realKeouTimeMin || 0);

    res.json({
      currentMonth: current,
      monthly: monthlyData,
      allTime: {
        visuals: parseInt(allTime.total || 0),
        images: allImgs,
        videos: allVids,
        audio: allAudio,
        marketCost: Math.round(allImgs * MARKET.image.cost + allVids * MARKET.video.cost + allAudio * MARKET.tts.cost),
        keouCost: Math.round((allImgs * API_COST.image + allVids * API_COST.video + allAudio * API_COST.tts) * 100) / 100,
        traditionalTimeMin: allTradTime,
        keouTimeMin: Math.round(allRealKeouTime * 10) / 10,
        timeSavedHours: Math.round((allTradTime - allRealKeouTime) / 60 * 10) / 10,
      },
      marketRates: MARKET,
    });
  } catch (e) {
    console.error('Analytics savings error:', e);
    res.status(500).json({ error: 'Failed to load savings data' });
  }
});

export default router;

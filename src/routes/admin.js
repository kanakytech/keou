import { Router } from 'express';
import multer from 'multer';
import { query, queryOne, queryAll } from '../db.js';
import { config } from '../config.js';
import { requireAdmin } from '../middleware/auth.js';
import { logActivity } from '../utils/activity.js';
import { clearKieKeyCache } from './generate.js';
import { clearKeyCache } from '../lib/providers/index.js';
import { encryptKey, decryptKey } from '../utils/crypto.js';
import { clearAgencyCache } from '../utils/credits.js';

/* Le rapport d'usage est du HTML assemblé à la main. Le nom d'agence y entre
   dans le <title> : il est choisi par l'exploitant, mais un titre de document
   n'a aucune raison d'accepter du balisage. Aucune fonction d'échappement
   n'existait dans ce fichier — on la pose ici plutôt que d'emprunter un
   global qui n'y est pas. */
const escapeHtml = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Escape CSV field — quote if contains comma, quote, or newline */
const csvEsc = (v) => { const s = String(v ?? ''); return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s; };

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ─── Agency Stats ───
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const agency = await queryOne('SELECT * FROM agency LIMIT 1');
    const totalMembers = (await queryOne('SELECT COUNT(*) as count FROM users')).count;
    const activeMembers = (await queryOne("SELECT COUNT(*) as count FROM users WHERE status = 'active'")).count;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const monthlyGens = (await queryOne("SELECT COUNT(*) as count FROM generations WHERE status = 'completed' AND created_at >= $1", [thirtyDaysAgo])).count;
    const totalGens = (await queryOne('SELECT COUNT(*) as count FROM generations')).count;
    const activeProjects = (await queryOne("SELECT COUNT(*) as count FROM projects WHERE status = 'active'")).count;

    res.json({
      agency,
      totalMembers: parseInt(totalMembers),
      activeMembers: parseInt(activeMembers),
      monthlyGens: parseInt(monthlyGens),
      totalGens: parseInt(totalGens),
      activeProjects: parseInt(activeProjects),
    });
  } catch (e) {
    console.error('Admin stats error:', e);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ─── Adjust Quota ───
router.post('/quota', requireAdmin, async (req, res) => {
  try {
    const { imageQuota, videoQuota } = req.body;
    if ((imageQuota !== undefined && (!Number.isInteger(imageQuota) || imageQuota < 0)) ||
        (videoQuota !== undefined && (!Number.isInteger(videoQuota) || videoQuota < 0))) {
      return res.status(400).json({ error: 'Quotas must be positive integers' });
    }
    const updates = [];
    const params = [];
    let paramIdx = 1;

    if (imageQuota !== undefined) { updates.push(`image_quota = $${paramIdx++}`); params.push(imageQuota); }
    if (videoQuota !== undefined) { updates.push(`video_quota = $${paramIdx++}`); params.push(videoQuota); }

    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    updates.push('updated_at = NOW()');
    await query(`UPDATE agency SET ${updates.join(', ')} WHERE id = 1`, params);
    clearAgencyCache();

    logActivity(req.user.id, 'quota_adjust', 'agency', 1, { imageQuota, videoQuota });
    console.log(`  [ADMIN] ${req.user.email} adjusted quota: img=${imageQuota}, vid=${videoQuota}`);

    res.json({ ok: true });
  } catch (e) {
    console.error('Admin quota error:', e);
    res.status(500).json({ error: 'Failed to adjust quota' });
  }
});

// ─── Reset Usage Counters ───
router.post('/quota/reset', requireAdmin, async (req, res) => {
  try {
    await query('UPDATE agency SET image_used = 0, video_used = 0, updated_at = NOW() WHERE id = 1');
    clearAgencyCache();
    logActivity(req.user.id, 'quota_reset', 'agency', 1);
    console.log(`  [ADMIN] ${req.user.email} reset usage counters`);
    res.json({ ok: true });
  } catch (e) {
    console.error('Admin reset error:', e);
    res.status(500).json({ error: 'Failed to reset usage' });
  }
});

// ─── Enable Unlimited Mode (BYO API Key) ───
router.post('/quota/unlimited', requireAdmin, async (req, res) => {
  try {
    await query(
      'UPDATE agency SET image_quota = 999999, video_quota = 999999, image_used = 0, video_used = 0, updated_at = NOW() WHERE id = 1'
    );
    clearAgencyCache();
    logActivity(req.user.id, 'quota_unlimited', 'agency', 1);
    console.log(`  [ADMIN] ${req.user.email} enabled unlimited mode`);
    res.json({ ok: true, message: 'Unlimited mode enabled — usage tracked for analytics only' });
  } catch (e) {
    console.error('Admin unlimited error:', e);
    res.status(500).json({ error: 'Failed to enable unlimited mode' });
  }
});

// ─── Update Agency Profile ───
router.put('/agency', requireAdmin, async (req, res) => {
  try {
    const { name, industry, stylePref } = req.body;
    await query(`
      UPDATE agency SET
        name = COALESCE($1, name),
        industry = COALESCE($2, industry),
        style_pref = COALESCE($3, style_pref),
        updated_at = NOW()
      WHERE id = 1
    `, [name || null, industry || null, stylePref ? JSON.stringify(stylePref) : null]);
    clearAgencyCache();

    logActivity(req.user.id, 'agency_update', 'agency', 1, { name, industry });
    res.json({ ok: true });
  } catch (e) {
    console.error('Admin agency update error:', e);
    res.status(500).json({ error: 'Failed to update agency' });
  }
});

// ─── Upload Agency Logo ───
router.post('/agency/logo', requireAdmin, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    // Derive extension from MIME type (already validated) — never from client filename.
    // Client-provided filename could contain path traversal ("../..") or unexpected chars.
    const MIME_TO_EXT = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
    };
    const ext = MIME_TO_EXT[req.file.mimetype];
    if (!ext) {
      return res.status(400).json({ error: 'Unsupported format. Use JPEG, PNG, WebP or SVG.' });
    }

    const { uploadPermanent, getMimeType, getPresignedUrl } = await import('../lib/r2.js');
    const key = `logos/agency_logo_${Date.now()}.${ext}`;
    await uploadPermanent(req.file.buffer, key, getMimeType(req.file));

    // Store the R2 key (not the presigned URL) so we can re-sign on read
    await query('UPDATE agency SET logo_url = $1, updated_at = NOW() WHERE id = 1', [key]);
    clearAgencyCache();

    // Return a fresh presigned URL for immediate display
    const logoUrl = await getPresignedUrl(key, 604800);
    res.json({ logoUrl });
  } catch (e) {
    console.error('Logo upload error:', e);
    res.status(500).json({ error: 'Failed to upload logo' });
  }
});

// ─── Per-User Usage ───
router.get('/usage', requireAdmin, async (req, res) => {
  try {
    const users = await queryAll(`
      SELECT
        u.id, u.name, u.email, u.role, u.status, u.last_login_at,
        COUNT(g.id) as "totalGens",
        SUM(CASE WHEN g.type = 'image' AND g.status = 'completed' THEN 1 ELSE 0 END) as images,
        SUM(CASE WHEN g.type = 'video' AND g.status = 'completed' THEN 1 ELSE 0 END) as videos,
        SUM(CASE WHEN g.type = 'polish' AND g.status = 'completed' THEN 1 ELSE 0 END) as polished
      FROM users u
      LEFT JOIN generations g ON g.user_id = u.id
      GROUP BY u.id, u.name, u.email, u.role, u.status, u.last_login_at
      ORDER BY "totalGens" DESC
    `);

    res.json({ users });
  } catch (e) {
    console.error('Admin usage error:', e);
    res.status(500).json({ error: 'Failed to load usage' });
  }
});

// ─── Export Usage Report CSV ───
router.get('/export', requireAdmin, async (req, res) => {
  try {
    const API_COST = { image: 0.09, polish: 0.09, video: 0.15, 'img-upscale': 0.12, 'vid-upscale': 0.70, tts: 0.05, sfx: 0.05, remix: 0.09, adapt: 0.09 };
    const MARKET_COST = { image: 18, polish: 8, video: 65, 'img-upscale': 5, 'vid-upscale': 20, tts: 15, sfx: 10, remix: 18, adapt: 5 };

    // Date filter — default 365 days, "all" to disable, or custom "?days=180"
    const daysParam = req.query.days;
    const days = daysParam === 'all' ? null : Math.max(1, Math.min(3650, parseInt(daysParam) || 365));
    const dateFilter = days ? `AND g.created_at >= NOW() - INTERVAL '${days} days'` : '';
    const dateFilterNoAlias = days ? `AND created_at >= NOW() - INTERVAL '${days} days'` : '';

    // ── Overall stats ──
    const overall = await queryAll(`
      SELECT type, COUNT(*) as count
      FROM generations g WHERE status = 'completed' ${dateFilter}
      GROUP BY type ORDER BY count DESC
    `);

    // ── Per-member stats ──
    const members = await queryAll(`
      SELECT u.name, u.email,
        COUNT(g.id) as total,
        SUM(CASE WHEN g.type IN ('image','polish','remix','adapt') THEN 1 ELSE 0 END) as images,
        SUM(CASE WHEN g.type = 'video' THEN 1 ELSE 0 END) as videos,
        MIN(g.created_at) as first_gen, MAX(g.created_at) as last_gen
      FROM users u
      LEFT JOIN generations g ON g.user_id = u.id AND g.status = 'completed' ${dateFilter}
      GROUP BY u.id, u.name, u.email ORDER BY total DESC
    `);

    // ── Per-client stats ──
    const clients = await queryAll(`
      SELECT p.name as project, COUNT(g.id) as total,
        SUM(CASE WHEN g.type IN ('image','polish','remix','adapt') THEN 1 ELSE 0 END) as images,
        SUM(CASE WHEN g.type = 'video' THEN 1 ELSE 0 END) as videos
      FROM projects p
      LEFT JOIN generations g ON g.project_id = p.id AND g.status = 'completed' ${dateFilter}
      WHERE p.status = 'active'
      GROUP BY p.id, p.name ORDER BY total DESC
    `);

    // ── Monthly breakdown ──
    const monthly = await queryAll(`
      SELECT TO_CHAR(created_at, 'YYYY-MM') as month, type, COUNT(*) as count
      FROM generations WHERE status = 'completed' ${dateFilterNoAlias}
      GROUP BY month, type ORDER BY month DESC, count DESC
    `);

    // ── Build CSV ──
    const lines = [];
    const date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

    // Section 1: Overview
    lines.push('KEOU STUDIO — USAGE REPORT');
    lines.push(`Generated: ${date}`);
    lines.push('');
    lines.push('=== OVERALL SUMMARY ===');
    lines.push('Type,Count,API Cost ($),Traditional Cost ($),Savings ($)');

    let totalCount = 0, totalApi = 0, totalMarket = 0;
    for (const row of overall) {
      const c = parseInt(row.count);
      const api = c * (API_COST[row.type] || 0.09);
      const market = c * (MARKET_COST[row.type] || 15);
      totalCount += c; totalApi += api; totalMarket += market;
      lines.push(`${row.type},${c},${api.toFixed(2)},${market.toFixed(2)},${(market - api).toFixed(2)}`);
    }
    lines.push(`TOTAL,${totalCount},${totalApi.toFixed(2)},${totalMarket.toFixed(2)},${(totalMarket - totalApi).toFixed(2)}`);
    lines.push('');
    lines.push(`Total API spend: $${totalApi.toFixed(2)}`);
    lines.push(`Traditional equivalent: $${totalMarket.toFixed(2)}`);
    lines.push(`Total savings: $${(totalMarket - totalApi).toFixed(2)} (${totalMarket > 0 ? Math.round((1 - totalApi / totalMarket) * 100) : 0}%)`);

    // Section 2: Per member
    lines.push('');
    lines.push('=== PER MEMBER ===');
    lines.push('Name,Email,Total Generations,Images,Videos,First Generation,Last Generation,Estimated Cost ($)');
    for (const m of members) {
      const cost = (parseInt(m.total) || 0) * 0.09;
      const first = m.first_gen ? new Date(m.first_gen).toLocaleDateString('en-GB') : '-';
      const last = m.last_gen ? new Date(m.last_gen).toLocaleDateString('en-GB') : '-';
      lines.push(`${csvEsc(m.name)},${csvEsc(m.email)},${m.total || 0},${m.images || 0},${m.videos || 0},${first},${last},${cost.toFixed(2)}`);
    }

    // Section 3: Per client
    lines.push('');
    lines.push('=== PER CLIENT ===');
    lines.push('Client,Total Generations,Images,Videos,Estimated Cost ($),Traditional Cost ($),Savings ($)');
    for (const c of clients) {
      const total = parseInt(c.total) || 0;
      const api = total * 0.09;
      const market = (parseInt(c.images) || 0) * 18 + (parseInt(c.videos) || 0) * 65;
      lines.push(`${csvEsc(c.project)},${total},${c.images || 0},${c.videos || 0},${api.toFixed(2)},${market.toFixed(2)},${(market - api).toFixed(2)}`);
    }

    // Section 4: Monthly
    lines.push('');
    lines.push('=== MONTHLY BREAKDOWN ===');
    lines.push('Month,Type,Count,API Cost ($)');
    for (const m of monthly) {
      const cost = parseInt(m.count) * (API_COST[m.type] || 0.09);
      lines.push(`${m.month},${m.type},${m.count},${cost.toFixed(2)}`);
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=keou-usage-report-${new Date().toISOString().split('T')[0]}.csv`);
    res.send(lines.join('\n'));
  } catch (e) {
    console.error('Export error:', e);
    res.status(500).json({ error: 'Failed to export' });
  }
});

// ─── Export HTML Usage Report ───
router.get('/report', requireAdmin, async (req, res) => {
  try {
    const API_COST = { image: 0.09, polish: 0.09, video: 0.15, 'img-upscale': 0.12, 'vid-upscale': 0.70, tts: 0.05, sfx: 0.05, remix: 0.09, adapt: 0.09 };
    const MARKET_COST = { image: 18, polish: 8, video: 65, 'img-upscale': 5, 'vid-upscale': 20, tts: 15, sfx: 10, remix: 18, adapt: 5 };
    const MARKET_TIME = { image: 25, polish: 10, video: 45, 'img-upscale': 3, 'vid-upscale': 10, tts: 15, sfx: 10, remix: 25, adapt: 5 };
    const TYPE_LABEL = { image: 'Product Photos', polish: 'Photo Polish', video: 'Product Videos', 'img-upscale': 'Image Upscale', 'vid-upscale': 'Video Upscale', tts: 'Text to Speech', sfx: 'Sound Effects', remix: 'Remix', adapt: 'Format Adapt' };

    // A1 — anti stored-XSS: escape user-controlled values before interpolating into the report HTML.
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const safeColor = (c) => (/^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? c : '#3B82F6');

    const agency = await queryOne('SELECT name FROM agency LIMIT 1');
    const agencyName = agency?.name || 'Agency';

    // Bound the report to a date range (default 365 days, "?days=all" to override)
    const daysParam = req.query.days;
    const days = daysParam === 'all' ? null : Math.max(1, Math.min(3650, parseInt(daysParam) || 365));
    const dateFilter = days ? `AND g.created_at >= NOW() - INTERVAL '${days} days'` : '';
    const dateFilterNoAlias = days ? `AND created_at >= NOW() - INTERVAL '${days} days'` : '';

    const overall = await queryAll(`
      SELECT type, COUNT(*) as count,
        COALESCE(SUM(EXTRACT(EPOCH FROM (completed_at - created_at)) / 60), 0) as "realTimeMin"
      FROM generations g WHERE status = 'completed' ${dateFilter}
      GROUP BY type ORDER BY count DESC
    `);

    const members = await queryAll(`
      SELECT u.name, u.email,
        COUNT(g.id) as total,
        SUM(CASE WHEN g.type IN ('image','polish','remix','adapt') THEN 1 ELSE 0 END) as images,
        SUM(CASE WHEN g.type = 'video' THEN 1 ELSE 0 END) as videos,
        MIN(g.created_at) as first_gen, MAX(g.created_at) as last_gen
      FROM users u
      LEFT JOIN generations g ON g.user_id = u.id AND g.status = 'completed' ${dateFilter}
      GROUP BY u.id, u.name, u.email ORDER BY total DESC
    `);

    const clients = await queryAll(`
      SELECT p.name as project, p.color, COUNT(g.id) as total,
        SUM(CASE WHEN g.type IN ('image','polish','remix','adapt') THEN 1 ELSE 0 END) as images,
        SUM(CASE WHEN g.type = 'video' THEN 1 ELSE 0 END) as videos
      FROM projects p
      LEFT JOIN generations g ON g.project_id = p.id AND g.status = 'completed' ${dateFilter}
      WHERE p.status = 'active' AND p.name != 'General'
      GROUP BY p.id, p.name, p.color ORDER BY total DESC
    `);

    const monthly = await queryAll(`
      SELECT TO_CHAR(created_at, 'YYYY-MM') as month,
        COUNT(*) as count,
        SUM(CASE WHEN type IN ('image','polish','remix','adapt') THEN 1 ELSE 0 END) as images,
        SUM(CASE WHEN type = 'video' THEN 1 ELSE 0 END) as videos
      FROM generations WHERE status = 'completed' ${dateFilterNoAlias}
      GROUP BY month ORDER BY month ASC
    `);

    // Compute totals
    let totalCount = 0, totalApi = 0, totalMarket = 0, totalTradTime = 0, totalKeouTime = 0;
    const typeRows = [];
    for (const row of overall) {
      const c = parseInt(row.count);
      const api = c * (API_COST[row.type] || 0.09);
      const market = c * (MARKET_COST[row.type] || 15);
      const tradTime = c * (MARKET_TIME[row.type] || 15);
      const keouTime = parseFloat(row.realTimeMin || 0);
      totalCount += c; totalApi += api; totalMarket += market; totalTradTime += tradTime; totalKeouTime += keouTime;
      typeRows.push({ type: row.type, label: TYPE_LABEL[row.type] || row.type, count: c, api, market, tradTime, keouTime });
    }
    const savingsPct = totalMarket > 0 ? Math.round((1 - totalApi / totalMarket) * 100) : 0;
    const timePct = totalTradTime > 0 ? Math.round((1 - totalKeouTime / totalTradTime) * 100) : 0;

    const fmtTime = (min) => min >= 60 ? `${(min / 60).toFixed(1)}h` : `${Math.round(min)}min`;
    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
    const reportDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Usage Report - ${escapeHtml(agencyName)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Poppins:wght@600;700;800;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',system-ui,sans-serif;background:#fafafa;color:#1a1a1a;line-height:1.6;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:900px;margin:0 auto;padding:48px 40px;background:#fff}
@media print{body{background:#fff}.page{padding:24px;max-width:100%}.no-print{display:none!important}}

/* Header */
.report-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:48px;padding-bottom:32px;border-bottom:3px solid #1a1a1a}
.report-logo{font-family:'Poppins',sans-serif;font-size:24px;font-weight:800;letter-spacing:-0.5px}
.report-logo span{color:#999}
.report-meta{text-align:right;font-size:13px;color:#666}
.report-meta strong{display:block;font-size:16px;color:#1a1a1a;margin-bottom:4px}

/* Section */
.section{margin-bottom:40px}
.section-title{font-family:'Poppins',sans-serif;font-size:18px;font-weight:700;margin-bottom:20px;padding-bottom:8px;border-bottom:2px solid #f0f0f0;text-transform:uppercase;letter-spacing:0.5px}

/* KPI Grid */
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:40px}
.kpi{background:#fafafa;border:1px solid #eee;border-radius:12px;padding:24px;text-align:center}
.kpi-value{font-family:'Poppins',sans-serif;font-size:36px;font-weight:900;letter-spacing:-1px;line-height:1}
.kpi-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#888;margin-top:6px}
.kpi-sub{font-size:12px;color:#aaa;margin-top:2px}
.kpi.highlight{background:#1a1a1a;color:#fff;border-color:#1a1a1a}
.kpi.highlight .kpi-label,.kpi.highlight .kpi-sub{color:rgba(255,255,255,.6)}

/* Comparison bar */
.compare{margin-bottom:40px}
.compare-row{display:flex;align-items:center;gap:16px;margin-bottom:8px}
.compare-label{width:100px;text-align:right;font-size:12px;font-weight:600;color:#888}
.compare-track{flex:1;height:32px;background:#f5f5f5;border-radius:8px;overflow:hidden;position:relative}
.compare-fill{height:100%;border-radius:8px;display:flex;align-items:center;padding:0 12px;font-size:12px;font-weight:700;color:#fff}
.compare-fill.trad{background:#1a1a1a;opacity:.3}
.compare-fill.keou{background:#1a1a1a}
.compare-val{font-size:12px;font-weight:600;color:#888;margin-left:8px;white-space:nowrap}

/* Tables */
table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px}
th{text-align:left;padding:10px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#888;border-bottom:2px solid #eee}
td{padding:10px 12px;border-bottom:1px solid #f5f5f5}
tr:last-child td{border-bottom:none}
.num{text-align:right;font-variant-numeric:tabular-nums}
.bold{font-weight:700}
.total-row td{border-top:2px solid #1a1a1a;font-weight:700;padding-top:12px}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:8px;vertical-align:middle}

/* Monthly chart */
.chart-container{display:flex;align-items:flex-end;gap:6px;height:120px;padding:12px 0;margin-bottom:8px}
.chart-bar{flex:1;background:#1a1a1a;border-radius:4px 4px 0 0;min-height:2px;position:relative;opacity:.75}
.chart-bar:hover{opacity:1}
.chart-label{text-align:center;font-size:10px;color:#999;margin-top:6px}
.chart-labels{display:flex;gap:6px}
.chart-labels span{flex:1;text-align:center;font-size:10px;color:#999}

/* Footer */
.report-footer{margin-top:48px;padding-top:24px;border-top:2px solid #f0f0f0;display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#aaa}
.report-footer strong{color:#1a1a1a}

/* Print button */
.print-btn{position:fixed;bottom:24px;right:24px;background:#1a1a1a;color:#fff;border:none;padding:12px 24px;border-radius:100px;font-family:'Inter',sans-serif;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.2)}
.print-btn:hover{background:#333;transform:translateY(-1px)}
</style>
</head>
<body>
<div class="page">

  <!-- Header -->
  <div class="report-header">
    <div>
      <div class="report-logo">${esc(agencyName)} <span>x Keou</span></div>
      <div style="font-size:13px;color:#888;margin-top:4px">Platform Usage Report</div>
    </div>
    <div class="report-meta">
      <strong>${reportDate}</strong>
      Powered by Keou Studio
    </div>
  </div>

  <!-- KPIs -->
  <div class="kpi-grid">
    <div class="kpi highlight">
      <div class="kpi-value">${totalCount}</div>
      <div class="kpi-label">Visuals Produced</div>
    </div>
    <div class="kpi">
      <div class="kpi-value">$${totalApi.toFixed(2)}</div>
      <div class="kpi-label">Total API Cost</div>
      <div class="kpi-sub">vs $${totalMarket.toLocaleString('en-US')} traditional</div>
    </div>
    <div class="kpi">
      <div class="kpi-value">${savingsPct}%</div>
      <div class="kpi-label">Cost Reduction</div>
      <div class="kpi-sub">$${(totalMarket - totalApi).toLocaleString('en-US')} saved</div>
    </div>
    <div class="kpi">
      <div class="kpi-value">${timePct}%</div>
      <div class="kpi-label">Time Reduction</div>
      <div class="kpi-sub">${fmtTime(totalKeouTime)} vs ${fmtTime(totalTradTime)}</div>
    </div>
  </div>

  <!-- Time Comparison -->
  <div class="section">
    <div class="section-title">Production Time Comparison</div>
    <div class="compare">
      <div class="compare-row">
        <span class="compare-label">Traditional</span>
        <div class="compare-track"><div class="compare-fill trad" style="width:100%"></div></div>
        <span class="compare-val">${fmtTime(totalTradTime)}</span>
      </div>
      <div class="compare-row">
        <span class="compare-label">With Keou</span>
        <div class="compare-track"><div class="compare-fill keou" style="width:${Math.max(2, totalTradTime > 0 ? (totalKeouTime / totalTradTime * 100) : 0).toFixed(0)}%"></div></div>
        <span class="compare-val">${fmtTime(totalKeouTime)}</span>
      </div>
    </div>
  </div>

  <!-- Breakdown by Type -->
  <div class="section">
    <div class="section-title">Generation Breakdown</div>
    <table>
      <thead><tr><th>Type</th><th class="num">Count</th><th class="num">Keou Cost</th><th class="num">Traditional Cost</th><th class="num">Savings</th><th class="num">Time (Traditional)</th><th class="num">Time (Keou)</th></tr></thead>
      <tbody>
        ${typeRows.map(r => `<tr><td class="bold">${r.label}</td><td class="num">${r.count}</td><td class="num">$${r.api.toFixed(2)}</td><td class="num">$${r.market.toLocaleString('en-US')}</td><td class="num bold">$${(r.market - r.api).toLocaleString('en-US')}</td><td class="num">${fmtTime(r.tradTime)}</td><td class="num">${fmtTime(r.keouTime)}</td></tr>`).join('')}
        <tr class="total-row"><td class="bold">Total</td><td class="num bold">${totalCount}</td><td class="num bold">$${totalApi.toFixed(2)}</td><td class="num bold">$${totalMarket.toLocaleString('en-US')}</td><td class="num bold">$${(totalMarket - totalApi).toLocaleString('en-US')}</td><td class="num bold">${fmtTime(totalTradTime)}</td><td class="num bold">${fmtTime(totalKeouTime)}</td></tr>
      </tbody>
    </table>
  </div>

  <!-- Per Client -->
  <div class="section">
    <div class="section-title">Client Performance</div>
    <table>
      <thead><tr><th>Client</th><th class="num">Visuals</th><th class="num">Images</th><th class="num">Videos</th><th class="num">Keou Cost</th><th class="num">Market Value</th><th class="num">Savings</th></tr></thead>
      <tbody>
        ${clients.map(c => {
          const total = parseInt(c.total) || 0;
          const api = total * 0.09;
          const market = (parseInt(c.images) || 0) * 18 + (parseInt(c.videos) || 0) * 65;
          return `<tr><td><span class="dot" style="background:${safeColor(c.color)}"></span><span class="bold">${esc(c.project)}</span></td><td class="num">${total}</td><td class="num">${c.images || 0}</td><td class="num">${c.videos || 0}</td><td class="num">$${api.toFixed(2)}</td><td class="num">$${market.toLocaleString('en-US')}</td><td class="num bold">$${(market - api).toLocaleString('en-US')}</td></tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>

  <!-- Team Activity -->
  <div class="section">
    <div class="section-title">Team Activity</div>
    <table>
      <thead><tr><th>Member</th><th class="num">Total</th><th class="num">Images</th><th class="num">Videos</th><th>First Activity</th><th>Last Activity</th><th class="num">Est. Cost</th></tr></thead>
      <tbody>
        ${members.map(m => {
          const cost = (parseInt(m.total) || 0) * 0.09;
          return `<tr><td><span class="bold">${esc(m.name)}</span><br><span style="font-size:11px;color:#999">${esc(m.email)}</span></td><td class="num">${m.total || 0}</td><td class="num">${m.images || 0}</td><td class="num">${m.videos || 0}</td><td>${fmtDate(m.first_gen)}</td><td>${fmtDate(m.last_gen)}</td><td class="num">$${cost.toFixed(2)}</td></tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>

  <!-- Monthly Trend -->
  ${monthly.length > 0 ? `<div class="section">
    <div class="section-title">Monthly Trend</div>
    <div class="chart-container">
      ${monthly.map(m => {
        const maxCount = Math.max(...monthly.map(x => parseInt(x.count)));
        const pct = maxCount > 0 ? (parseInt(m.count) / maxCount * 100) : 0;
        return `<div class="chart-bar" style="height:${Math.max(2, pct)}%" title="${m.month}: ${m.count} visuals"></div>`;
      }).join('')}
    </div>
    <div class="chart-labels">${monthly.map(m => `<span>${m.month.slice(5)}</span>`).join('')}</div>
    <table style="margin-top:16px">
      <thead><tr><th>Month</th><th class="num">Total</th><th class="num">Images</th><th class="num">Videos</th><th class="num">API Cost</th></tr></thead>
      <tbody>
        ${monthly.map(m => {
          const total = parseInt(m.count);
          const imgs = parseInt(m.images) || 0;
          const vids = parseInt(m.videos) || 0;
          const cost = imgs * 0.09 + vids * 0.15;
          return `<tr><td class="bold">${m.month}</td><td class="num">${total}</td><td class="num">${imgs}</td><td class="num">${vids}</td><td class="num">$${cost.toFixed(2)}</td></tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>` : ''}

  <!-- Footer -->
  <div class="report-footer">
    <span><strong>Keou</strong> &mdash; open-source creative infrastructure by Kanaky Tech</span>
    <span>studio.kanaky.xyz</span>
  </div>

</div>

<button class="print-btn no-print" onclick="window.print()">Print / Save PDF</button>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) {
    console.error('Report error:', e);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// ─── Get API Key status (masked) ───
router.get('/api-key', requireAdmin, async (req, res) => {
  try {
    const row = await queryOne("SELECT value FROM settings WHERE key = 'kie_api_key'");
    if (row && row.value) {
      // Decrypt then mask: first 8 chars + dots + last 4 chars
      const v = decryptKey(row.value);
      const masked = v.length > 12
        ? v.slice(0, 8) + '••••••••' + v.slice(-4)
        : '••••••••';
      res.json({ configured: true, masked });
    } else {
      // Check if env var fallback exists
      const hasEnv = !!config.kie.keys.image;
      res.json({ configured: hasEnv, masked: hasEnv ? 'Set via environment' : null });
    }
  } catch (e) {
    console.error('API key get error:', e);
    res.status(500).json({ error: 'Failed to get API key status' });
  }
});

// ─── Save API Key ───
router.put('/api-key', requireAdmin, async (req, res) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey || !apiKey.trim()) {
      return res.status(400).json({ error: 'API key is required' });
    }

    const key = apiKey.trim();

    // Validate key format (basic check — KIE keys are hex strings)
    if (key.length < 20) {
      return res.status(400).json({ error: 'Invalid API key format' });
    }

    // Test the key against KIE.AI (with timeout)
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15_000);
      const testRes = await fetch('https://api.kie.ai/api/v1/jobs/queryRecordInfo', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: 'test' }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      // 401 = bad key, anything else (400, 404, etc.) = key is valid but task doesn't exist
      if (testRes.status === 401) {
        return res.status(400).json({ error: 'Invalid API key — KIE.AI rejected it' });
      }
    } catch (e) {
      // Network error — save anyway, might be temporary
      console.warn('KIE validation skipped (network):', e.message);
    }

    // Encrypt and upsert into settings
    const encryptedKey = encryptKey(key);
    await query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('kie_api_key', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [encryptedKey]
    );

    clearKieKeyCache(); // invalidate cached key in generate.js
    clearKeyCache();    // invalidate cached key in provider router

    logActivity(req.user.id, 'api_key_update', 'settings', null, { action: 'kie_api_key updated' });

    const masked = key.slice(0, 8) + '••••••••' + key.slice(-4);
    res.json({ ok: true, masked });
  } catch (e) {
    console.error('API key save error:', e);
    res.status(500).json({ error: 'Failed to save API key' });
  }
});

// ─── Get Fal.ai API Key status (masked) ───
router.get('/fal-api-key', requireAdmin, async (req, res) => {
  try {
    const row = await queryOne("SELECT value FROM settings WHERE key = 'fal_api_key'");
    if (row && row.value) {
      const v = decryptKey(row.value);
      const masked = v.length > 12 ? v.slice(0, 8) + '••••••••' + v.slice(-4) : '••••••••';
      res.json({ configured: true, masked });
    } else {
      const hasEnv = !!config.fal?.apiKey;
      res.json({ configured: hasEnv, masked: hasEnv ? 'Set via environment' : null });
    }
  } catch (e) {
    console.error('Fal API key get error:', e);
    res.status(500).json({ error: 'Failed to get Fal API key status' });
  }
});

// ─── Save Fal.ai API Key ───
router.put('/fal-api-key', requireAdmin, async (req, res) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey || !apiKey.trim()) {
      return res.status(400).json({ error: 'API key is required' });
    }

    const key = apiKey.trim();
    if (key.length < 10) {
      return res.status(400).json({ error: 'Invalid API key format' });
    }

    // Validate key against Fal.ai (lightweight queue status check — no generation triggered)
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      const testRes = await fetch('https://queue.fal.run/fal-ai/flux-2-pro/requests/test/status', {
        headers: { 'Authorization': `Key ${key}` },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      // 401 = bad key. 404/422 = key valid but request doesn't exist (expected)
      if (testRes.status === 401) {
        return res.status(400).json({ error: 'Invalid API key — Fal.ai rejected it' });
      }
    } catch (e) {
      console.warn('Fal validation skipped (network):', e.message);
    }

    const encryptedKey = encryptKey(key);
    await query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('fal_api_key', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [encryptedKey]
    );

    clearKeyCache();
    logActivity(req.user.id, 'api_key_update', 'settings', null, { action: 'fal_api_key updated' });

    const masked = key.slice(0, 8) + '••••••••' + key.slice(-4);
    res.json({ ok: true, masked });
  } catch (e) {
    console.error('Fal API key save error:', e);
    res.status(500).json({ error: 'Failed to save Fal API key' });
  }
});

// ─── Delete Fal.ai API Key ───
router.delete('/fal-api-key', requireAdmin, async (req, res) => {
  try {
    await query("DELETE FROM settings WHERE key = 'fal_api_key'");
    clearKeyCache();
    logActivity(req.user.id, 'api_key_update', 'settings', null, { action: 'fal_api_key removed' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to remove Fal API key' });
  }
});

// ─── Get/Set Default Provider ───
router.get('/default-provider', requireAdmin, async (req, res) => {
  try {
    const row = await queryOne("SELECT value FROM settings WHERE key = 'default_provider'");
    const provider = row?.value || config.defaultProvider || 'kie';
    res.json({ provider });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get default provider' });
  }
});

router.put('/default-provider', requireAdmin, async (req, res) => {
  try {
    const { provider } = req.body;
    if (!['kie', 'fal'].includes(provider)) {
      return res.status(400).json({ error: 'Provider must be "kie" or "fal"' });
    }

    await query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('default_provider', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [provider]
    );

    clearKeyCache();
    logActivity(req.user.id, 'provider_update', 'settings', null, { provider });
    res.json({ ok: true, provider });
  } catch (e) {
    res.status(500).json({ error: 'Failed to set default provider' });
  }
});

// ─── Get/Set Anthropic API Key ───
router.get('/anthropic-key', requireAdmin, async (req, res) => {
  try {
    const row = await queryOne("SELECT value FROM settings WHERE key = 'anthropic_api_key'");
    if (!row) return res.json({ set: false, masked: '' });
    const key = decryptKey(row.value);
    const masked = key.length > 12 ? key.slice(0, 8) + '••••••••' + key.slice(-4) : '••••••••';
    res.json({ set: true, masked });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get Anthropic key status' });
  }
});

router.put('/anthropic-key', requireAdmin, async (req, res) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey || apiKey.trim().length < 10) {
      return res.status(400).json({ error: 'Invalid API key' });
    }
    const trimmed = apiKey.trim();

    // Validate key against Anthropic API
    try {
      const testRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': trimmed,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      // 200 = valid, 400 = valid key but bad request (still means key works)
      // 401 = invalid key
      if (testRes.status === 401) {
        return res.status(400).json({ error: 'Invalid API key — authentication failed' });
      }
    } catch (err) {
      return res.status(400).json({ error: 'Could not validate key — check your connection' });
    }

    const encrypted = encryptKey(trimmed);
    await query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('anthropic_api_key', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [encrypted]
    );

    const masked = trimmed.slice(0, 8) + '••••••••' + trimmed.slice(-4);
    logActivity(req.user.id, 'api_key_update', 'settings', null, { action: 'anthropic_api_key updated' });
    res.json({ ok: true, masked });
  } catch (e) {
    console.error('Anthropic key save error:', e);
    res.status(500).json({ error: 'Failed to save Anthropic key' });
  }
});

router.delete('/anthropic-key', requireAdmin, async (req, res) => {
  try {
    await query("DELETE FROM settings WHERE key = 'anthropic_api_key'");
    logActivity(req.user.id, 'api_key_update', 'settings', null, { action: 'anthropic_api_key removed' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to remove Anthropic key' });
  }
});

// Retroactive auto-tagging endpoint removed — categorization no longer in product.

export default router;

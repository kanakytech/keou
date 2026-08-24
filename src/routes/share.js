import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { query, queryOne, queryAll } from '../db.js';
import { logActivity } from '../utils/activity.js';
import { getPublicUrl, getPresignedUrl } from '../lib/r2.js';

const router = Router();

/**
 * Resolve a stored URL or R2 key into a live URL usable by a browser.
 * Priority: R2 key (permanent via public domain or fresh presign) > raw URL.
 * This guarantees the share page shows real content even after the 7-day
 * presigned URL in result_url has expired.
 */
async function resolveAssetUrl({ r2Key, fallbackUrl }) {
  if (r2Key) {
    try { return await getPublicUrl(r2Key); }
    catch (err) { console.error('[SHARE R2] getPublicUrl failed for', r2Key, err.message); }
  }
  // No R2 key (older row, or immediate Fal result) → hope the fallback URL is still valid
  return fallbackUrl || null;
}

/** Same pattern for the agency logo, which is stored as an R2 key in agency.logo_url */
async function resolveLogoUrl(logoUrl) {
  if (!logoUrl) return null;
  if (logoUrl.startsWith('http')) return logoUrl; // legacy full URL
  try { return await getPresignedUrl(logoUrl, 604800); }
  catch (err) { console.error('[SHARE R2] getPresignedUrl failed for logo', logoUrl, err.message); return null; }
}

// POST / — Create share link (auth required)
router.post('/', requireAuth, async (req, res) => {
  try {
    const { projectId, generationIds, title, accessCode, expiresInDays } = req.body;
    if (!Array.isArray(generationIds) || generationIds.length === 0) return res.status(400).json({ error: 'generationIds required' });
    if (generationIds.length > 1000) return res.status(400).json({ error: 'Too many items (max 1000 per share link)' });
    if (title != null && (typeof title !== 'string' || title.length > 200)) return res.status(400).json({ error: 'Title must be a string of 200 chars max' });
    if (accessCode != null && (typeof accessCode !== 'string' || accessCode.length > 64)) return res.status(400).json({ error: 'Access code must be a string of 64 chars max' });

    const token = crypto.randomBytes(16).toString('hex');
    const days = [7, 14, 30, 60, 90].includes(expiresInDays) ? expiresInDays : 30;

    const link = await queryOne(
      `INSERT INTO share_links (token, project_id, created_by, title, access_code, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '1 day' * $6) RETURNING id, token`,
      [token, projectId || null, req.user.id, title || 'Shared Assets', accessCode?.trim() || null, days]
    );

    // Bulk insert items — only include generations that belong to user (or admin)
    const validIds = req.user.role === 'admin'
      ? generationIds
      : (await queryAll('SELECT id FROM generations WHERE id = ANY($1) AND user_id = $2', [generationIds, req.user.id])).map(r => r.id);

    if (validIds.length === 0) return res.status(400).json({ error: 'No valid generations to share' });

    const values = validIds.map((gid, i) => `($1, $${i + 2})`).join(', ');
    await query(`INSERT INTO share_link_items (share_link_id, generation_id) VALUES ${values}`, [link.id, ...validIds]);

    logActivity(req.user.id, 'share_created', 'share', link.id, { itemCount: validIds.length, projectId });

    // /share/:token is a clean public URL that serves OG meta tags to social
    // crawlers (WhatsApp/Slack/LinkedIn/email) and auto-redirects real users
    // to /share.html. This is the URL the agency copies to send to their client.
    res.json({
      ok: true,
      token: link.token,
      url: `/share/${link.token}`,
      legacyUrl: `/share.html?t=${link.token}`,
      itemCount: validIds.length,
    });
  } catch (e) {
    console.error('Share create error:', e);
    res.status(500).json({ error: 'Failed to create share link' });
  }
});

// GET / — List user's share links (auth required)
router.get('/', requireAuth, async (req, res) => {
  try {
    const links = await queryAll(`
      SELECT sl.id, sl.token, sl.title, sl.project_id, sl.expires_at, sl.view_count, sl.created_at,
             p.name as project_name,
             (SELECT COUNT(*) FROM share_link_items WHERE share_link_id = sl.id) as item_count
      FROM share_links sl
      LEFT JOIN projects p ON sl.project_id = p.id
      WHERE sl.created_by = $1 AND sl.expires_at > NOW()
      ORDER BY sl.created_at DESC`, [req.user.id]);
    res.json({ links });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list share links' });
  }
});

// GET /:token — Public share page data (NO auth)
router.get('/:token', async (req, res) => {
  try {
    const link = await queryOne('SELECT * FROM share_links WHERE token = $1', [req.params.token]);
    if (!link) return res.status(404).json({ error: 'Share link not found' });
    if (new Date(link.expires_at) < new Date()) return res.status(410).json({ error: 'This share link has expired' });

    // Check access code if set
    // H12 — coerce to a single string so a stray array param (?code[]=) can't lock out a legit user.
    const providedCode = String(Array.isArray(req.query.code) ? req.query.code[0] : (req.query.code ?? ''));
    if (link.access_code && providedCode !== link.access_code) {
      return res.status(403).json({ error: 'Access code required', requiresCode: true });
    }

    // Increment view count
    await query('UPDATE share_links SET view_count = view_count + 1 WHERE id = $1', [link.id]);

    // Get items — capped at 200 to keep response size bounded even on mega-batches.
    const items = await queryAll(`
      SELECT g.id, g.type, g.status, g.result_url, g.r2_key, g.format, g.created_at, g.tags
      FROM share_link_items sli
      JOIN generations g ON sli.generation_id = g.id
      WHERE sli.share_link_id = $1
      ORDER BY g.created_at DESC
      LIMIT 200`, [link.id]);

    // Get agency branding + project name (if link is scoped to a project)
    const [agency, project] = await Promise.all([
      queryOne('SELECT name, logo_url FROM agency LIMIT 1'),
      link.project_id ? queryOne('SELECT name FROM projects WHERE id = $1', [link.project_id]) : null,
    ]);

    // Resolve each item's URL in parallel (R2 public URL or fresh presigned).
    // Non-completed items get url=null + status so the UI can show "Processing..."
    // distinctly from "Unavailable" (broken URL).
    const resolvedItems = await Promise.all(items.map(async (item) => ({
      id: item.id,
      type: item.type,
      status: item.status,
      url: item.status === 'completed'
        ? await resolveAssetUrl({ r2Key: item.r2_key, fallbackUrl: item.result_url })
        : null,
      format: item.format,
      tags: item.tags,
      createdAt: item.created_at,
    })));

    const resolvedLogo = await resolveLogoUrl(agency?.logo_url);

    res.json({
      title: link.title,
      projectName: project?.name || null,
      agencyName: agency?.name || 'Studio',
      agencyLogo: resolvedLogo,
      itemCount: resolvedItems.length,
      createdAt: link.created_at,
      expiresAt: link.expires_at,
      items: resolvedItems,
    });
  } catch (e) {
    console.error('Share fetch error:', e);
    res.status(500).json({ error: 'Failed to load shared content' });
  }
});

/**
 * Escape HTML special chars for safe injection into server-rendered attributes/text.
 * Used only for OG meta tag values — regular app uses client-side escaping.
 */
function escapeHtmlAttr(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ═══════════════════════════════════════════
// CLIENT FEEDBACK ON SHARED ASSETS
// ═══════════════════════════════════════════

/**
 * POST /:token/feedback — public, no auth.
 * The client (the agency's customer) leaves Approve / Reject / Comment
 * on a specific asset within a share link.
 *
 * Rate limit applied at the app level (/api/share bucket = 20/min/IP).
 * Validation: share link valid + access code OK + generation belongs to link.
 */
router.post('/:token/feedback', async (req, res) => {
  try {
    const { generationId, type, comment, reviewerName, reviewerEmail } = req.body;
    if (!['approve', 'reject', 'comment'].includes(type)) {
      return res.status(400).json({ error: 'type must be approve, reject, or comment' });
    }
    if ((type === 'comment' || type === 'reject') && (!comment || !comment.trim())) {
      return res.status(400).json({ error: 'comment is required for this feedback type' });
    }
    if (comment && comment.length > 2000) return res.status(400).json({ error: 'comment too long (max 2000 chars)' });
    if (reviewerName && (typeof reviewerName !== 'string' || reviewerName.length > 100)) {
      return res.status(400).json({ error: 'reviewerName must be a string, max 100 chars' });
    }
    if (reviewerEmail && (typeof reviewerEmail !== 'string' || reviewerEmail.length > 254)) {
      return res.status(400).json({ error: 'reviewerEmail too long' });
    }
    const genId = parseInt(generationId);
    if (!genId) return res.status(400).json({ error: 'generationId required' });

    const link = await queryOne('SELECT * FROM share_links WHERE token = $1', [req.params.token]);
    if (!link) return res.status(404).json({ error: 'Share link not found' });
    if (new Date(link.expires_at) < new Date()) return res.status(410).json({ error: 'Share link has expired' });
    if (link.access_code && req.query.code !== link.access_code) {
      return res.status(403).json({ error: 'Access code required', requiresCode: true });
    }

    // Verify the generation actually belongs to this share link (no cross-link spam)
    const inLink = await queryOne(
      'SELECT 1 FROM share_link_items WHERE share_link_id = $1 AND generation_id = $2',
      [link.id, genId]
    );
    if (!inLink) return res.status(404).json({ error: 'Asset not part of this share' });

    const inserted = await queryOne(
      `INSERT INTO share_feedback (share_link_id, generation_id, type, comment, reviewer_name, reviewer_email)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [link.id, genId, type, comment?.trim() || null, reviewerName?.trim() || null, reviewerEmail?.trim() || null]
    );

    res.json({ ok: true, feedbackId: inserted.id, createdAt: inserted.created_at });
  } catch (e) {
    console.error('Share feedback create error:', e);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

/**
 * GET /:token/feedback-summary — public.
 * Returns the count + latest feedback per generationId so the share page
 * can show "12 approved, 2 changes requested" without re-loading.
 * Doesn't expose reviewer emails — name only.
 */
router.get('/:token/feedback-summary', async (req, res) => {
  try {
    const link = await queryOne('SELECT id, access_code FROM share_links WHERE token = $1', [req.params.token]);
    if (!link) return res.status(404).json({ error: 'Share link not found' });
    if (link.access_code && req.query.code !== link.access_code) {
      return res.status(403).json({ error: 'Access code required', requiresCode: true });
    }
    const rows = await queryAll(
      `SELECT id, generation_id, type, comment, reviewer_name, status, created_at
         FROM share_feedback
        WHERE share_link_id = $1
        ORDER BY created_at DESC`,
      [link.id]
    );
    res.json({ feedback: rows });
  } catch (e) {
    console.error('Share feedback summary error:', e);
    res.status(500).json({ error: 'Failed to load feedback' });
  }
});

/**
 * GET /feedback/by-link/:linkId — agency view.
 * Lists every feedback entry for a share link the user owns.
 */
router.get('/feedback/by-link/:linkId', requireAuth, async (req, res) => {
  try {
    const linkId = parseInt(req.params.linkId);
    const link = await queryOne('SELECT * FROM share_links WHERE id = $1', [linkId]);
    if (!link) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && link.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    const rows = await queryAll(
      `SELECT f.*, g.type AS gen_type, g.result_url, g.r2_key
         FROM share_feedback f
         JOIN generations g ON g.id = f.generation_id
        WHERE f.share_link_id = $1
        ORDER BY f.created_at DESC`,
      [linkId]
    );
    res.json({ feedback: rows });
  } catch (e) {
    console.error('Agency feedback list error:', e);
    res.status(500).json({ error: 'Failed to load feedback' });
  }
});

/**
 * GET /feedback/by-project/:projectId — agency view aggregated per project.
 * Returns all feedback across every share link under this project.
 */
router.get('/feedback/by-project/:projectId', requireAuth, async (req, res) => {
  try {
    const projectId = parseInt(req.params.projectId);
    if (!projectId) return res.status(400).json({ error: 'Invalid projectId' });
    // Multi-tenant model: 1 deployment = 1 agency, so any auth user can read
    // any project's feedback. We still verify the project exists so we don't
    // silently return [] for an invalid id (better debug + 404 semantics).
    const project = await queryOne('SELECT id FROM projects WHERE id = $1', [projectId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const rows = await queryAll(
      `SELECT f.*, g.type AS gen_type, g.result_url, g.r2_key,
              sl.title AS share_title, sl.token AS share_token
         FROM share_feedback f
         JOIN generations g ON g.id = f.generation_id
         JOIN share_links sl ON sl.id = f.share_link_id
        WHERE sl.project_id = $1
        ORDER BY f.created_at DESC
        LIMIT 500`,
      [projectId]
    );
    res.json({ feedback: rows });
  } catch (e) {
    console.error('Project feedback error:', e);
    res.status(500).json({ error: 'Failed to load feedback' });
  }
});

/**
 * PATCH /feedback/:id — agency marks open/resolved.
 */
router.patch('/feedback/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    if (!['open', 'resolved'].includes(status)) {
      return res.status(400).json({ error: 'status must be open or resolved' });
    }
    // Verify ownership through share link
    const fb = await queryOne(
      `SELECT f.id, sl.created_by FROM share_feedback f
        JOIN share_links sl ON sl.id = f.share_link_id
        WHERE f.id = $1`,
      [id]
    );
    if (!fb) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && fb.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    if (status === 'resolved') {
      await query('UPDATE share_feedback SET status = $1, resolved_at = NOW(), resolved_by = $2 WHERE id = $3',
        ['resolved', req.user.id, id]);
    } else {
      await query('UPDATE share_feedback SET status = $1, resolved_at = NULL, resolved_by = NULL WHERE id = $2',
        ['open', id]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Feedback patch error:', e);
    res.status(500).json({ error: 'Failed to update feedback' });
  }
});

/**
 * GET /feedback/notifications
 * Returns recent feedback across all projects + an unreadCount for the bell
 * indicator. "Unread" = created_at > users.feedback_seen_at (or seen_at NULL).
 * Limit 30 items — enough for the bell dropdown, not unbounded.
 */
router.get('/feedback/notifications', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(
      `SELECT f.id, f.type, f.comment, f.reviewer_name, f.status, f.created_at,
              f.generation_id,
              g.type AS gen_type, g.result_url, g.r2_key,
              sl.title AS share_title, sl.token AS share_token,
              p.id AS project_id, p.name AS project_name, p.color AS project_color,
              c.name AS campaign_name
         FROM share_feedback f
         JOIN share_links sl ON sl.id = f.share_link_id
         JOIN generations g  ON g.id  = f.generation_id
         JOIN projects p     ON p.id  = sl.project_id
         LEFT JOIN campaigns c ON c.id = g.campaign_id
        ORDER BY f.created_at DESC
        LIMIT 30`
    );

    // Inbox model : an item is "unread" until it's been resolved. The badge
    // count = number of OPEN items, so it stays red until the agency clicks
    // "Mark resolved" — matching the project page's "Open" tab semantics.
    const items = rows.map(r => ({
      ...r,
      unread: r.status === 'open',
    }));
    const unreadCount = items.filter(i => i.unread).length;

    res.json({ unreadCount, items });
  } catch (e) {
    console.error('Notifications fetch error:', e);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

/**
 * POST /feedback/notifications/seen
 * Marks the bell as opened — bumps users.feedback_seen_at to NOW(). The next
 * /notifications fetch will report 0 unread until new feedback arrives.
 */
router.post('/feedback/notifications/seen', requireAuth, async (req, res) => {
  try {
    await query(
      'UPDATE users SET feedback_seen_at = NOW() WHERE id = $1',
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Notifications seen error:', e);
    res.status(500).json({ error: 'Failed to mark notifications seen' });
  }
});

// DELETE /:id — Delete share link (auth required)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM share_links WHERE id = $1 AND created_by = $2',
      [req.params.id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete share link' });
  }
});

/**
 * Server-rendered HTML shell with Open Graph + Twitter meta tags.
 * Mounted at `/share/:token` (app-level in server.js) so the public URL is clean
 * — no `/api/` prefix. Real users hit this, the embedded <script> redirects to
 * /share.html?t=TOKEN which boots the actual app. Social crawlers (WhatsApp,
 * Slack, LinkedIn, Facebook, Twitter, email clients) read the meta tags and
 * render a rich preview with title + description + agency name + first asset image.
 *
 * The access-code gate is unchanged — it protects the /api/share/:token data API,
 * not the meta preview (which only uses the public title + first image URL).
 */
export async function renderSharePage(req, res) {
  try {
    const link = await queryOne('SELECT * FROM share_links WHERE token = $1', [req.params.token]);
    if (!link || new Date(link.expires_at) < new Date()) {
      return res.redirect(`/share.html?t=${encodeURIComponent(req.params.token)}`);
    }

    const [agency, firstItem, countRow] = await Promise.all([
      queryOne('SELECT name, logo_url FROM agency LIMIT 1'),
      queryOne(`
        SELECT g.r2_key, g.result_url, g.type
          FROM share_link_items sli
          JOIN generations g ON sli.generation_id = g.id
         WHERE sli.share_link_id = $1 AND g.type != 'video'
         ORDER BY g.created_at DESC
         LIMIT 1`, [link.id]),
      queryOne('SELECT COUNT(*)::int AS n FROM share_link_items WHERE share_link_id = $1', [link.id]),
    ]);

    const itemCount = countRow?.n || 0;
    const agencyName = agency?.name || 'Studio';
    const previewUrl = firstItem ? await resolveAssetUrl({ r2Key: firstItem.r2_key, fallbackUrl: firstItem.result_url }) : null;
    const logoUrl = await resolveLogoUrl(agency?.logo_url);
    const title = link.title || 'Shared Assets';
    const description = `${itemCount} asset${itemCount !== 1 ? 's' : ''} shared by ${agencyName}`;
    const canonical = `${req.protocol}://${req.get('host')}/share/${encodeURIComponent(req.params.token)}`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtmlAttr(title)} — ${escapeHtmlAttr(agencyName)}</title>
  <meta name="description" content="${escapeHtmlAttr(description)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${escapeHtmlAttr(agencyName)}">
  <meta property="og:title" content="${escapeHtmlAttr(title)}">
  <meta property="og:description" content="${escapeHtmlAttr(description)}">
  <meta property="og:url" content="${escapeHtmlAttr(canonical)}">
  ${previewUrl ? `<meta property="og:image" content="${escapeHtmlAttr(previewUrl)}">
  <meta property="og:image:alt" content="${escapeHtmlAttr(title)}">` : logoUrl ? `<meta property="og:image" content="${escapeHtmlAttr(logoUrl)}">` : ''}
  <meta name="twitter:card" content="${previewUrl ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title" content="${escapeHtmlAttr(title)}">
  <meta name="twitter:description" content="${escapeHtmlAttr(description)}">
  ${previewUrl ? `<meta name="twitter:image" content="${escapeHtmlAttr(previewUrl)}">` : ''}
  <link rel="canonical" href="${escapeHtmlAttr(canonical)}">
  <script>location.replace('/share.html?t=' + ${JSON.stringify(req.params.token)});</script>
</head>
<body>
  <p>Redirecting to <a href="/share.html?t=${escapeHtmlAttr(req.params.token)}">shared assets</a>…</p>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min cache for bot crawlers
    res.send(html);
  } catch (e) {
    console.error('Share page render error:', e);
    res.redirect(`/share.html?t=${encodeURIComponent(req.params.token)}`);
  }
}

export default router;

import { Router } from 'express';
import crypto from 'crypto';
import { query, queryOne, queryAll } from '../db.js';
import { hashPassword } from '../utils/hash.js';
import { requireAdmin } from '../middleware/auth.js';
import { logActivity } from '../utils/activity.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();
// 5 password resets per hour per admin — prevents abuse
const resetPasswordLimiter = rateLimit(5, 60 * 60 * 1000);

function generateTempPassword() {
  return 'Keou_' + crypto.randomBytes(8).toString('hex') + '!';
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Invite Employee ───
router.post('/invite', requireAdmin, async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) return res.status(400).json({ error: 'Name required' });
    if (name.length > 100) return res.status(400).json({ error: 'Name must be 100 characters or less' });
    if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) return res.status(400).json({ error: 'Valid email required' });
    if (email.length > 254) return res.status(400).json({ error: 'Email is too long' });

    const existing = await queryOne('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email.trim()]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const tempPassword = generateTempPassword();
    const hash = await hashPassword(tempPassword);

    const result = await query(
      `INSERT INTO users (email, password_hash, name, role, status, invited_by)
       VALUES ($1, $2, $3, 'member', 'pending_password', $4) RETURNING id`,
      [email.toLowerCase().trim(), hash, name.trim(), req.user.id]
    );
    const userId = result.rows[0].id;

    logActivity(req.user.id, 'employee_invite', 'user', userId, { email, name });
    console.log(`  [TEAM] ${req.user.email} invited ${email}`);

    res.json({
      ok: true,
      userId,
      tempPassword,
      message: `Employee created. Share this temporary password: ${tempPassword}`,
    });
  } catch (e) {
    console.error('Team invite error:', e);
    res.status(500).json({ error: 'Failed to invite employee' });
  }
});

// ─── List Members ───
router.get('/members', requireAdmin, async (req, res) => {
  try {
    const members = await queryAll(`
      SELECT
        u.id, u.email, u.name, u.role, u.status, u.last_login_at, u.created_at,
        u.image_quota, u.video_quota,
        inv.name as "invitedByName",
        SUM(CASE WHEN g.status = 'completed' THEN 1 ELSE 0 END) as "totalGens",
        SUM(CASE WHEN g.type IN ('image','polish') AND g.status = 'completed' THEN 1 ELSE 0 END) as images,
        SUM(CASE WHEN g.type = 'video' AND g.status = 'completed' THEN 1 ELSE 0 END) as videos
      FROM users u
      LEFT JOIN users inv ON inv.id = u.invited_by
      LEFT JOIN generations g ON g.user_id = u.id
      GROUP BY u.id, u.email, u.name, u.role, u.status, u.last_login_at, u.created_at,
               u.image_quota, u.video_quota, inv.name
      ORDER BY u.created_at DESC
    `);

    res.json({ members });
  } catch (e) {
    console.error('Team list error:', e);
    res.status(500).json({ error: 'Failed to load team' });
  }
});

// ─── Update Member (suspend/reactivate/role/quota) ───
router.patch('/members/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, role, imageQuota, videoQuota } = req.body;

    const member = await queryOne('SELECT * FROM users WHERE id = $1', [id]);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ error: 'Cannot modify your own account' });
    }

    if (status && ['active', 'suspended'].includes(status)) {
      await query("UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2", [status, id]);

      if (status === 'suspended') {
        await query('DELETE FROM sessions WHERE user_id = $1', [id]);
      }

      logActivity(req.user.id, status === 'suspended' ? 'employee_suspend' : 'employee_reactivate', 'user', parseInt(id));
    }

    if (role && ['admin', 'member'].includes(role)) {
      await query("UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2", [role, id]);
      logActivity(req.user.id, 'role_change', 'user', parseInt(id), { newRole: role });
    }

    // Per-user quota update (null = unlimited / use agency pool only)
    if (imageQuota !== undefined) {
      const val = imageQuota === null || imageQuota === '' ? null : parseInt(imageQuota);
      await query("UPDATE users SET image_quota = $1, updated_at = NOW() WHERE id = $2", [val, id]);
    }
    if (videoQuota !== undefined) {
      const val = videoQuota === null || videoQuota === '' ? null : parseInt(videoQuota);
      await query("UPDATE users SET video_quota = $1, updated_at = NOW() WHERE id = $2", [val, id]);
    }

    if (imageQuota !== undefined || videoQuota !== undefined) {
      logActivity(req.user.id, 'quota_update', 'user', parseInt(id), {
        imageQuota: imageQuota ?? member.image_quota,
        videoQuota: videoQuota ?? member.video_quota,
      });
    }

    console.log(`  [TEAM] ${req.user.email} updated user #${id}: status=${status}, role=${role}, imgQ=${imageQuota}, vidQ=${videoQuota}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('Team update error:', e);
    res.status(500).json({ error: 'Failed to update member' });
  }
});

// ─── Reset Password ───
router.post('/members/:id/reset-password', requireAdmin, resetPasswordLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const member = await queryOne('SELECT * FROM users WHERE id = $1', [id]);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const tempPassword = generateTempPassword();
    const hash = await hashPassword(tempPassword);

    await query("UPDATE users SET password_hash = $1, status = 'pending_password', updated_at = NOW() WHERE id = $2", [hash, id]);
    await query('DELETE FROM sessions WHERE user_id = $1', [id]);

    logActivity(req.user.id, 'password_reset', 'user', parseInt(id));
    console.log(`  [TEAM] ${req.user.email} reset password for user #${id}`);

    res.json({ ok: true, tempPassword });
  } catch (e) {
    console.error('Password reset error:', e);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ─── Delete Member ───
router.delete('/members/:id', requireAdmin, async (req, res) => {
  try {
    const memberId = parseInt(req.params.id);
    if (memberId === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });

    const member = await queryOne('SELECT id, email, name, role FROM users WHERE id = $1', [memberId]);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    // H13 — never delete the last active admin (would lock the whole agency out of the admin panel).
    if (member.role === 'admin') {
      const admins = await queryOne("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'");
      if ((admins?.n || 0) <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });
    }

    // Reassign projects to the admin performing the deletion
    await query('UPDATE projects SET created_by = $1 WHERE created_by = $2', [req.user.id, memberId]);
    // Log before delete (activity_log cascades on user delete)
    logActivity(req.user.id, 'employee_delete', 'user', memberId, { email: member.email, name: member.name });
    // Delete user — CASCADE handles: sessions, generations, credit_transactions, activity_log
    await query('DELETE FROM users WHERE id = $1', [memberId]);

    console.log(`  [TEAM] ${req.user.email} deleted user #${memberId} (${member.email})`);
    res.json({ ok: true });
  } catch (e) {
    console.error('Team delete error:', e);
    res.status(500).json({ error: 'Failed to delete member' });
  }
});

export default router;

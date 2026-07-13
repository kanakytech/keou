import { Router } from 'express';
import crypto from 'crypto';
import { query, queryOne, queryAll } from '../db.js';
import { config } from '../config.js';
import { hashPassword, comparePassword } from '../utils/hash.js';
import { signAccessToken, generateRefreshToken, parseDuration } from '../utils/jwt.js';
import { requireAuth } from '../middleware/auth.js';
import { getQuotaSummary } from '../utils/credits.js';
import { logActivity } from '../utils/activity.js';
import { rateLimit } from '../middleware/rateLimit.js';

/** Hash a refresh token with SHA-256 before storing/comparing */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const router = Router();

// 10 login attempts per 15 minutes per IP
const loginLimiter = rateLimit(10, 15 * 60 * 1000);
// 30 refresh attempts per 15 min per IP (prevents token brute force)
const refreshLimiter = rateLimit(30, 15 * 60 * 1000);
// 5 account creations per hour per IP (community edition self-serve signup)
const registerLimiter = rateLimit(5, 60 * 60 * 1000);

// Minimum password length — 12 chars per current OWASP/NIST guidance for B2B accounts.
// We don't enforce composition (uppercase/digit/special) since long passphrases beat
// short complex passwords in entropy and usability.
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200;
function validatePassword(pw) {
  if (typeof pw !== 'string') return 'Password must be a string';
  if (pw.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (pw.length > MAX_PASSWORD_LENGTH) return `Password is too long (max ${MAX_PASSWORD_LENGTH} chars)`;
  return null;
}

// ─── LOGIN ───
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await queryOne('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email.trim()]);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'Account suspended. Contact your admin.' });
    }

    const valid = await comparePassword(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const accessToken = signAccessToken({ userId: user.id, email: user.email, role: user.role });
    const refreshToken = generateRefreshToken();
    const refreshExpires = new Date(Date.now() + parseDuration(config.jwt.refreshExpires)).toISOString();

    // Delete old sessions for this user (keep max 5)
    const oldSessions = await queryAll('SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at DESC', [user.id]);
    if (oldSessions.length >= 5) {
      const toDelete = oldSessions.slice(4).map(s => s.id);
      await query('DELETE FROM sessions WHERE id = ANY($1)', [toDelete]);
    }

    await query('INSERT INTO sessions (user_id, refresh_token, expires_at) VALUES ($1, $2, $3)', [user.id, hashToken(refreshToken), refreshExpires]);
    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: parseDuration(config.jwt.refreshExpires),
      path: '/api/auth',
    });

    logActivity(user.id, 'login', 'user', user.id);

    res.json({
      accessToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      mustChangePassword: user.status === 'pending_password',
      edition: config.edition,
      billingMode: config.billingMode,
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── REGISTER (community edition only — public self-serve signup) ───
router.post('/register', registerLimiter, async (req, res) => {
  if (config.edition !== 'community') return res.status(404).json({ error: 'Not found' });
  try {
    const { email, password, name } = req.body;
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const cleanName = typeof name === 'string' ? name.trim() : '';

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    if (!cleanName || cleanName.length > 80) {
      return res.status(400).json({ error: 'Name is required (max 80 characters)' });
    }
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain uppercase, lowercase, number, and special character' });
    }

    const existing = await queryOne('SELECT id FROM users WHERE LOWER(email) = $1', [cleanEmail]);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists — sign in instead' });

    const hash = await hashPassword(password);
    const inserted = await queryOne(
      `INSERT INTO users (email, password_hash, name, role, status)
       VALUES ($1, $2, $3, 'member', 'active')
       RETURNING id, email, name, role`,
      [cleanEmail, hash, cleanName]
    );

    const accessToken = signAccessToken({ userId: inserted.id, email: inserted.email, role: inserted.role });
    const refreshToken = generateRefreshToken();
    const refreshExpires = new Date(Date.now() + parseDuration(config.jwt.refreshExpires)).toISOString();
    await query('INSERT INTO sessions (user_id, refresh_token, expires_at) VALUES ($1, $2, $3)', [inserted.id, hashToken(refreshToken), refreshExpires]);
    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [inserted.id]);

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: parseDuration(config.jwt.refreshExpires),
      path: '/api/auth',
    });

    logActivity(inserted.id, 'register', 'user', inserted.id);

    res.status(201).json({
      accessToken,
      user: { id: inserted.id, email: inserted.email, name: inserted.name, role: inserted.role },
      mustChangePassword: false,
      edition: config.edition,
      billingMode: config.billingMode,
    });
  } catch (e) {
    // Unique-constraint race between the SELECT and the INSERT
    if (e.code === '23505') return res.status(409).json({ error: 'An account with this email already exists — sign in instead' });
    console.error('Register error:', e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ─── CHANGE PASSWORD ───
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const pwError = validatePassword(newPassword);
    if (pwError) return res.status(400).json({ error: pwError });
    if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
      return res.status(400).json({ error: 'Password must contain uppercase, lowercase, number, and special character' });
    }

    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(401).json({ error: 'User not found' }); // H3 — token valid but user deleted

    if (user.status !== 'pending_password' && !currentPassword) {
      return res.status(400).json({ error: 'Current password required' });
    }

    if (currentPassword) {
      const valid = await comparePassword(currentPassword, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await hashPassword(newPassword);
    await query("UPDATE users SET password_hash = $1, status = 'active', updated_at = NOW() WHERE id = $2", [hash, req.user.id]);

    logActivity(req.user.id, 'password_change', 'user', req.user.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('Change password error:', e);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ─── REFRESH ───
router.post('/refresh', refreshLimiter, async (req, res) => {
  try {
    // Opensource edition: no accounts. Every visitor gets a synthetic session
    // as the bootstrap user — advanced routes are 404'd by requireEnterprise,
    // and generation requires the visitor's own provider key per request.
    if (config.edition === 'opensource') {
      const u = await queryOne(`SELECT id, email, name FROM users ORDER BY id ASC LIMIT 1`);
      if (!u) return res.status(500).json({ error: 'Instance not initialized' });
      const accessToken = signAccessToken({ userId: u.id, email: u.email, role: 'member' });
      return res.json({
        accessToken,
        user: { id: u.id, email: u.email, name: 'Studio', role: 'member' },
        mustChangePassword: false,
        edition: 'opensource',
        billingMode: config.billingMode,
      });
    }

    const token = req.cookies?.refresh_token;
    if (!token) return res.status(401).json({ error: 'No refresh token' });

    const session = await queryOne(`
      SELECT s.*, u.email, u.name, u.role, u.status FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.refresh_token = $1 AND s.expires_at > NOW()
    `, [hashToken(token)]);

    if (!session) {
      res.clearCookie('refresh_token', { path: '/api/auth' });
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    if (session.status === 'suspended') {
      res.clearCookie('refresh_token', { path: '/api/auth' });
      return res.status(403).json({ error: 'Account suspended' });
    }

    const newRefreshToken = generateRefreshToken();
    const refreshExpires = new Date(Date.now() + parseDuration(config.jwt.refreshExpires)).toISOString();

    await query('UPDATE sessions SET refresh_token = $1, expires_at = $2 WHERE id = $3', [hashToken(newRefreshToken), refreshExpires, session.id]);

    const accessToken = signAccessToken({ userId: session.user_id, email: session.email, role: session.role });

    res.cookie('refresh_token', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: parseDuration(config.jwt.refreshExpires),
      path: '/api/auth',
    });

    res.json({
      accessToken,
      user: { id: session.user_id, email: session.email, name: session.name, role: session.role },
      mustChangePassword: session.status === 'pending_password',
      edition: config.edition,
      billingMode: config.billingMode,
    });
  } catch (e) {
    console.error('Refresh error:', e);
    res.status(500).json({ error: 'Refresh failed' });
  }
});

// ─── LOGOUT ───
router.post('/logout', async (req, res) => {
  const token = req.cookies?.refresh_token;
  // H4 — best-effort revoke; always clear the cookie + respond, even if the DELETE fails.
  try {
    if (token) {
      await query('DELETE FROM sessions WHERE refresh_token = $1', [hashToken(token)]);
    }
  } catch (e) {
    console.error('Logout revoke error:', e.message);
  }
  res.clearCookie('refresh_token', { path: '/api/auth' });
  res.json({ ok: true });
});

// ─── ME ───
router.get('/me', requireAuth, async (req, res) => {
  const quota = await getQuotaSummary();
  res.json({ user: req.user, quota });
});

// ─── AGENCY INFO (public) ───
router.get('/agency', async (req, res) => {
  const agency = await queryOne('SELECT name, logo_url FROM agency LIMIT 1');
  let logoUrl = agency?.logo_url || null;
  // Re-sign R2 keys (non-URL stored values)
  if (logoUrl && !logoUrl.startsWith('http')) {
    try {
      const { getPresignedUrl } = await import('../lib/r2.js');
      logoUrl = await getPresignedUrl(logoUrl, 604800);
    } catch { logoUrl = null; }
  }
  res.json({ name: agency?.name || 'Agency', logoUrl, edition: config.edition, billingMode: config.billingMode });
});

export default router;

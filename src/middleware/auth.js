import crypto from 'crypto';
import { verifyAccessToken } from '../utils/jwt.js';
import { query, queryOne } from '../db.js';

const USER_COLS = 'id, email, name, role, status, image_quota, video_quota';

async function loadUserByApiKey(plaintext) {
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  const row = await queryOne(
    `SELECT k.id AS key_id, ${USER_COLS.split(', ').map(c => 'u.' + c).join(', ')}
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = $1`,
    [hash]
  );
  if (!row) return null;
  // Touch last_used_at fire-and-forget — don't block the request
  query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [row.key_id]).catch(() => {});
  const { key_id, ...user } = row;
  return user;
}

/** Extract and verify token from Authorization header (JWT or keou_* API key) */
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = authHeader.slice(7);

  // API key path — long-lived, hashed lookup
  if (token.startsWith('keou_')) {
    try {
      const user = await loadUserByApiKey(token);
      if (!user) return res.status(401).json({ error: 'Invalid API key' });
      if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' }); // H1
      req.user = user;
      return next();
    } catch (e) {
      console.error('[AUTH] API key lookup error:', e.message);
      return res.status(500).json({ error: 'Auth failure' });
    }
  }

  // JWT path — short-lived, used by browser session
  try {
    const payload = verifyAccessToken(token);
    const user = await queryOne(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [payload.userId]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' }); // H1
    req.user = user;
    next();
  } catch (e) {
    if (e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/** Require admin role */
export async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

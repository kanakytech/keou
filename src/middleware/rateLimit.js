/**
 * Simple in-memory rate limiter (no Redis dependency)
 * Tracks requests per IP with sliding window cleanup
 */

const windows = new Map(); // key → { count, resetAt }

// Single cleanup timer shared across all rate limiter instances (prevents memory leak)
let _cleanupStarted = false;
function ensureCleanup() {
  if (_cleanupStarted) return;
  _cleanupStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of windows) {
      if (now > entry.resetAt) windows.delete(key);
    }
  }, 5 * 60 * 1000).unref();
}

/**
 * Create a rate-limiting middleware
 * @param {number} maxRequests - Max requests per window
 * @param {number} windowMs - Window duration in milliseconds
 * @returns {Function} Express middleware
 */
export function rateLimit(maxRequests = 10, windowMs = 15 * 60 * 1000) {
  ensureCleanup();

  // Unique prefix per limiter instance to avoid key collisions
  const prefix = `rl_${maxRequests}_${windowMs}_`;

  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const key = prefix + ip;
    const now = Date.now();
    let entry = windows.get(key);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      windows.set(key, entry);
    }

    entry.count++;

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - entry.count));

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        error: 'Too many requests. Please try again later.',
        retryAfter,
      });
    }

    next();
  };
}

import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config.js';

export function signAccessToken(payload) {
  return jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expires });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, config.jwt.secret);
}

export function generateRefreshToken() {
  return crypto.randomBytes(40).toString('hex');
}

/** Parse duration string like '7d', '15m', '1h' to milliseconds */
export function parseDuration(str) {
  const num = parseInt(str);
  const unit = str.slice(-1);
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return num * (multipliers[unit] || 1000);
}

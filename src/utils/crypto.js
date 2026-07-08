/**
 * AES-256-CBC encryption for API keys at rest.
 * Key is derived from JWT_SECRET via scrypt.
 * Format: iv:encrypted (both hex-encoded).
 * Backward-compatible: decryptKey returns plaintext as-is if no ":" found.
 */

import crypto from 'crypto';
import { config } from '../config.js';

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

function getDerivedKey() {
  const secret = config.jwt?.secret || process.env.JWT_SECRET || 'keou-default-secret';
  return crypto.scryptSync(secret, 'keou-salt', 32);
}

/**
 * Encrypt a plaintext API key.
 * @param {string} plaintext
 * @returns {string} "iv:encrypted" hex string
 */
export function encryptKey(plaintext) {
  if (!plaintext) return plaintext;
  const key = getDerivedKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt an encrypted API key.
 * Backward-compatible: if input has no ":" separator, assumes legacy plaintext.
 * @param {string} ciphertext
 * @returns {string} plaintext
 */
export function decryptKey(ciphertext) {
  if (!ciphertext) return ciphertext;
  if (!ciphertext.includes(':')) return ciphertext; // legacy plaintext
  const [ivHex, encrypted] = ciphertext.split(':');
  if (!ivHex || !encrypted) return ciphertext;
  try {
    const key = getDerivedKey();
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    // If decryption fails (e.g. corrupted data), return as-is
    return ciphertext;
  }
}

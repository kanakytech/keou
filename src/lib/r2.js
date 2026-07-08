import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import { config } from '../config.js';

// ─── R2 Client (S3-compatible) ───
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
  },
});

const BUCKET = config.r2.bucket;

/**
 * Upload a buffer to R2.
 * Returns a long-lived URL — public if R2_PUBLIC_URL is configured, otherwise
 * a 7-day presigned URL. Long enough for KIE.AI to fetch AND for the lightbox
 * to display the source image weeks later (30-min TTL was too short for that).
 * @param {Buffer} buffer
 * @param {string} key
 * @param {string} contentType
 * @returns {Promise<string>}
 */
export async function uploadToR2(buffer, key, contentType = 'image/png') {
  await r2.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  if (config.r2.publicUrl) return `${config.r2.publicUrl}/${key}`;
  return getPresignedUrl(key, 604800);
}

/**
 * Given a (possibly expired) R2 presigned URL or a public R2 URL we previously
 * generated, return a fresh URL pointing to the same object. Used to "revive"
 * old input_url values stored in DB before we switched to long TTL.
 *
 * Returns the original URL untouched if it doesn't look like one of our R2 URLs
 * (e.g. KIE.AI temp URL, external).
 */
export async function refreshR2Url(maybeR2Url) {
  if (!maybeR2Url || typeof maybeR2Url !== 'string') return maybeR2Url;
  let parsed;
  try { parsed = new URL(maybeR2Url); } catch { return maybeR2Url; }

  // Public domain match — already permanent, return as-is
  if (config.r2.publicUrl) {
    try {
      const publicOrigin = new URL(config.r2.publicUrl).origin;
      if (parsed.origin === publicOrigin) return maybeR2Url;
    } catch {}
  }
  // S3 presigned format: https://<bucket>.<account>.r2.cloudflarestorage.com/<key>?X-Amz-…
  if (!/r2\.cloudflarestorage\.com$/.test(parsed.hostname)) return maybeR2Url;

  // Strip leading slash from pathname → R2 key
  const key = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!key) return maybeR2Url;

  // Hand back a fresh presigned URL (or public URL if configured)
  if (config.r2.publicUrl) return `${config.r2.publicUrl}/${key}`;
  try { return await getPresignedUrl(key, 604800); }
  catch { return maybeR2Url; }
}

/**
 * Upload a buffer meant for permanent storage (logos, brand assets)
 * Uses a different prefix so lifecycle rules don't delete them
 * @param {Buffer} buffer
 * @param {string} key
 * @param {string} contentType
 * @returns {Promise<string>} Presigned URL (7 days TTL)
 */
export async function uploadPermanent(buffer, key, contentType = 'image/png') {
  await r2.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));

  // Permanent assets get a 7-day URL — refreshed on each access
  return getPresignedUrl(key, 604800);
}

/**
 * Download a file from URL and re-upload to R2 for permanent storage.
 * Streams directly from source to R2 when Content-Length is known (typical
 * for KIE/Fal CDN responses) — avoids buffering 50MB+ videos in RAM.
 * Falls back to buffering if the source doesn't announce its length.
 *
 * @param {string} sourceUrl - URL to download from (e.g. KIE.AI temp URL)
 * @param {string} key - R2 object key (e.g. results/123.png)
 * @returns {Promise<string>} Public URL (if R2_PUBLIC_URL set) or presigned URL
 */
export async function persistFromUrl(sourceUrl, key) {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const contentLengthHeader = res.headers.get('content-length');
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;

  if (contentLength && contentLength > 0 && res.body) {
    // Streaming path — bytes go source → R2 without fully buffering in Node.
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: Readable.fromWeb(res.body),
      ContentType: contentType,
      ContentLength: contentLength,
    }));
  } else {
    // No Content-Length (chunked, unknown) — S3 PutObject requires a known length
    // with streams, so we fall back to buffering. Rare for our providers.
    const buffer = Buffer.from(await res.arrayBuffer());
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));
  }

  // If public URL configured, return permanent public link
  if (config.r2.publicUrl) {
    return `${config.r2.publicUrl}/${key}`;
  }
  // Fallback: presigned URL valid for 7 days (will need re-signing)
  return getPresignedUrl(key, 604800);
}

/**
 * Get public URL for a key (if R2_PUBLIC_URL is set)
 * Falls back to presigned URL
 */
export async function getPublicUrl(key) {
  if (config.r2.publicUrl) return `${config.r2.publicUrl}/${key}`;
  return getPresignedUrl(key, 604800);
}

/**
 * Generate a presigned URL for an existing object
 * @param {string} key - Object key
 * @param {number} expiresIn - Seconds until URL expires (default 30 min)
 * @returns {Promise<string>}
 */
export async function getPresignedUrl(key, expiresIn = 1800) {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(r2, command, { expiresIn });
}

/**
 * Delete an object from R2
 * @param {string} key
 */
export async function deleteFromR2(key) {
  await r2.send(new DeleteObjectCommand({
    Bucket: BUCKET,
    Key: key,
  }));
}

/**
 * Detect MIME type from multer file
 */
export function getMimeType(file) {
  return file.mimetype || 'image/png';
}

export default r2;

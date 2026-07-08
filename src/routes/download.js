import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Allowed domains for proxy download (prevents SSRF)
const ALLOWED_HOSTS = [
  'cdn.kie.ai',
  'media.kie.ai',
  'api.kie.ai',
  'kie.ai',
  'aiquickdraw.com',           // KIE.AI static CDN
  'r2.cloudflarestorage.com',  // R2 presigned URLs
  'r2.dev',                    // R2 public URLs (pub-xxx.r2.dev)
  'cloudflare.com',            // Cloudflare CDN
  'elevenlabs.io',             // ElevenLabs audio results
  'storage.googleapis.com',    // GCS-hosted results
  'googleapis.com',            // Google APIs
  'topazlabs.com',             // Topaz upscale results
  'amazonaws.com',             // AWS S3 results
  'cloudfront.net',            // CloudFront CDN
  'blob.core.windows.net',     // Azure Blob
  'fal.media',                 // Fal.ai result CDN
  'fal.run',                   // Fal.ai direct results
];

function isAllowedUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

// Proxy download (avoid CORS) — restricted to KIE.AI + R2 domains
router.get('/', requireAuth, async (req, res) => {
  try {
    const { url, name } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });

    if (!isAllowedUrl(url)) {
      console.error('[DOWNLOAD] Blocked URL:', url, '| Host:', new URL(url).hostname);
      return res.status(403).json({ error: 'URL not allowed' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!r.ok) return res.status(502).json({ error: 'Upstream fetch failed' });

    const contentType = r.headers.get('content-type') || 'application/octet-stream';
    const safeName = (name || 'keou-asset').replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    const buffer = await r.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (e) {
    console.error('Download error:', e);
    res.status(500).json({ error: 'Download failed' });
  }
});

export default router;

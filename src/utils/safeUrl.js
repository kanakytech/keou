// B1 — SSRF guard for user-supplied URLs.
// Rejects URLs pointing at internal/private hosts before they're forwarded to a
// generation provider (or fetched server-side). Blocks the common vectors —
// cloud metadata (169.254.169.254), localhost, RFC1918, link-local, loopback,
// IPv6 local — without breaking legitimate public http(s) image/video URLs.
//
// Note: literal-IP + hostname checks only (no DNS resolution) → fast and
// non-breaking. Full DNS-rebinding protection (resolve host → check every A/AAAA)
// is a deeper follow-up; this closes the direct internal-URL vector.

const PRIVATE_V4 = [
  /^127\./,                    // loopback
  /^10\./,                     // RFC1918
  /^192\.168\./,               // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
  /^169\.254\./,               // link-local (cloud metadata)
  /^0\./,                      // "this" network
];

export function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::') return true;                 // IPv6 loopback / unspecified
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true; // link-local + ULA
  if (h.includes('127.0.0.1') || h.includes('169.254.')) return true; // IPv4-mapped IPv6 edge
  if (PRIVATE_V4.some((re) => re.test(h))) return true;
  return false;
}

/**
 * Throws if `url` is missing, malformed, non-http(s), or points at a private/internal host.
 * Returns the url unchanged when safe (so it can be used inline).
 */
export function assertSafeUrl(url) {
  let u;
  try { u = new URL(String(url)); }
  catch { throw new Error('Invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed');
  }
  if (isPrivateHost(u.hostname)) {
    throw new Error('URL not allowed');
  }
  return url;
}

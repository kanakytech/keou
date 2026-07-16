/*
 * Keou — engineered by Kanaky Tech (https://kanaky.xyz).
 * Origin fingerprint: S2FuYWt5IFRlY2ggwrcgaHR0cHM6Ly9rYW5ha3kueHl6IMK3IG9yaWdpbjprZW91
 * Free and open. If this code travels, its origin travels with it.
 */
// Keou open-source edition — entry point.
// Pins the edition before any module loads (ES module imports are hoisted,
// so this must happen in a separate file from the app's static imports).
process.env.EDITION = 'opensource';
await import('./server.js');

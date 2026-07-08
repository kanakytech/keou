// Keou open-source edition — entry point.
// Pins the edition before any module loads (ES module imports are hoisted,
// so this must happen in a separate file from the app's static imports).
process.env.EDITION = 'opensource';
await import('./server.js');

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const canonicalFiles = new Set(['custom.html', 'docs.html', 'donate.html', 'essai.html', 'help.html', 'install.html']);
// public/ is shared with white-label and self-hosted installations.
export function publicSeo({ edition, publicDir }) {
  return (req, res, next) => {
    const file = req.path.slice(1);
    if (edition !== 'community' || !['GET', 'HEAD'].includes(req.method) || !canonicalFiles.has(file)) return next();
    const html = readFileSync(join(publicDir, file), 'utf8');
    res.set('Cache-Control', 'no-cache').type('html').send(html.replace('</head>', `<link rel="canonical" href="https://studio.kanaky.xyz/${file}">\n</head>`));
  };
}

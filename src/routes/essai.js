/**
 * Essai communautaire — génération anonyme BYOK + galerie publique
 *
 * POST   /api/essai/generer      filtre de prompt → job en file FIFO
 * GET    /api/essai/statut/:id   statut + position dans la file (polling)
 * GET    /api/essai/galerie      galerie publique paginée (récentes d'abord)
 * POST   /api/essai/signaler/:id signalement (auto-masquage à 3 signalements)
 * GET    /api/essai/image/:id    streaming protégé (no-store, inline, filigrané)
 * DELETE /api/essai/admin/:id    suppression admin (auth existante requireAdmin)
 *
 * Studio anonyme (« Launch Keou » sans compte — mêmes règles de sortie) :
 * POST   /api/essai/upload            image source (R2 essai/uploads/, éphémère)
 * POST   /api/essai/studio/generate   visuel produit (img→img, brief studio)
 * POST   /api/essai/studio/polish     retouche pro d'un résultat anonyme
 * POST   /api/essai/studio/remix      ré-imagination (prompt visiteur filtré)
 * POST   /api/essai/studio/adapt      adaptation de ratio
 * GET    /api/essai/studio/status/:id statut au format attendu par studio.html
 *                                     ({ ready, resultUrl, state, failed })
 *
 * Sécurité :
 *   - La clé du visiteur arrive via X-Provider-Key (même mécanisme BYOK que
 *     le studio — requestContext), n'est jamais persistée ni loggée.
 *   - ids UUID v4 : non séquentiels, non devinables.
 *   - L'image est servie par proxy : aucune URL R2/provider n'atteint le client.
 *   - Toute sortie anonyme est filigranée, publiée dans la galerie, sans
 *     téléchargement — c'est la modération par transparence.
 */

import { Router } from 'express';
import { randomUUID, randomBytes } from 'crypto';
import multer from 'multer';
import { config } from '../config.js';
import { query, queryOne, queryAll } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { clientIp } from '../middleware/rateLimit.js';
import { getRequestProviderKey } from '../utils/requestContext.js';
import { checkPrompt } from '../lib/prompt-filter.js';
import { enqueue, positionOf, queueStats } from '../lib/essai-queue.js';
import { getObjectStream, deleteFromR2, uploadToR2, getPresignedUrl, storageConfigured, STORAGE_MISSING } from '../lib/r2.js';
import { assertSafeUrl } from '../utils/safeUrl.js';

const router = Router();

// L'essai n'existe que sur l'édition communautaire hébergée — une instance
// white-label (enterprise) ou self-host (opensource) ne doit pas exposer un
// mur public. Même convention que requireEnterprise : 404, pas 403.
router.use((req, res, next) => {
  if (config.edition !== 'community') return res.status(404).json({ error: 'Not found' });
  next();
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Whitelist stricte — mêmes ratios que jarvis.js (nano-banana-pro les accepte tous).
const VALID_FORMATS = ['1:1', '16:9', '9:16', '3:4', '4:3', '3:2', '2:3'];
const PAGE_SIZE = 24;
const MAX_REPORTS_BEFORE_HIDE = 3;

// ─── Générer ───
router.post('/generer', async (req, res) => {
  try {
    // Clé BYOK : uniquement depuis le header (jamais depuis le body → jamais
    // dans un log de body ni un dump de requête).
    const apiKey = getRequestProviderKey();
    if (!apiKey) {
      return res.status(400).json({ error: 'API key required — paste your KIE.AI key (it stays in your browser)' });
    }

    const { prompt, format, consent } = req.body || {};
    if (consent !== true) {
      return res.status(400).json({ error: 'Consent required: everything created here is public' });
    }
    const cleanPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (cleanPrompt.length < 3) return res.status(400).json({ error: 'Prompt too short (3 characters minimum)' });
    if (cleanPrompt.length > 500) return res.status(400).json({ error: 'Prompt too long (500 characters maximum)' });

    // Filtre de modération en amont — refus poli, aucune tâche créée
    const check = checkPrompt(cleanPrompt);
    if (check.blocked) return res.status(422).json({ error: check.message, category: check.category });

    const cleanFormat = VALID_FORMATS.includes(format) ? format : '1:1';
    const id = randomUUID();

    await query(
      `INSERT INTO essai_generations (id, prompt, status, format) VALUES ($1, $2, 'queued', $3)`,
      [id, cleanPrompt, cleanFormat]
    );

    const q = enqueue({ id, prompt: cleanPrompt, format: cleanFormat, apiKey, ip: clientIp(req) });
    if (!q.ok) {
      await query(`DELETE FROM essai_generations WHERE id = $1`, [id]).catch(() => {});
      return res.status(q.code).json({ error: q.error });
    }

    res.json({ id, position: q.position, status: 'queued' });
  } catch (e) {
    console.error('[ESSAI generer]', e.message);
    res.status(500).json({ error: 'Could not start the generation — try again' });
  }
});

// ─── Statut (polling client) ───
router.get('/statut/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Not found' });

    const row = await queryOne(
      `SELECT status, error FROM essai_generations WHERE id = $1`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });

    const payload = { id, status: row.status };
    if (row.status === 'queued') payload.position = positionOf(id);
    if (row.status === 'completed') payload.imageUrl = `/api/essai/image/${id}`;
    if (row.status === 'failed') payload.error = row.error || 'La generation a echoue';
    res.json(payload);
  } catch (e) {
    console.error('[ESSAI statut]', e.message);
    res.status(500).json({ error: 'Status unavailable' });
  }
});

// ─── Galerie publique (paginée, récentes d'abord) ───
router.get('/galerie', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const offset = (page - 1) * PAGE_SIZE;

    const rows = await queryAll(
      `SELECT id, prompt, created_at FROM essai_generations
        WHERE status = 'completed' AND hidden = FALSE
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2`,
      [PAGE_SIZE + 1, offset]
    );

    const hasMore = rows.length > PAGE_SIZE;
    const items = rows.slice(0, PAGE_SIZE).map((r) => ({
      id: r.id,
      prompt: r.prompt,
      imageUrl: `/api/essai/image/${r.id}`,
      createdAt: r.created_at,
    }));

    res.json({ items, page, hasMore, queue: queueStats() });
  } catch (e) {
    console.error('[ESSAI galerie]', e.message);
    res.status(500).json({ error: 'Galerie indisponible' });
  }
});

// ─── Image protégée (streaming proxy, filigranée à la source) ───
router.get('/image/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).end();

    const row = await queryOne(
      `SELECT r2_key, hidden, status FROM essai_generations WHERE id = $1`,
      [id]
    );
    if (!row || row.status !== 'completed' || row.hidden || !row.r2_key) return res.status(404).end();

    const obj = await getObjectStream(row.r2_key);

    res.setHeader('Content-Type', 'image/png');
    if (obj.contentLength) res.setHeader('Content-Length', obj.contentLength);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', 'inline; filename="keou-essai.png"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Anti-hotlinking : l'image ne peut être ni encadrée (iframe) ni embarquée
    // par un autre site — elle ne vit que dans la galerie de l'essai.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; default-src 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');

    obj.body.on('error', (err) => {
      console.error('[ESSAI image stream]', err.message);
      if (!res.headersSent) res.status(502).end();
      else res.destroy();
    });
    obj.body.pipe(res);
  } catch (e) {
    // NoSuchKey ou erreur R2 — jamais de détail (pas de fuite de clé d'objet)
    console.error('[ESSAI image]', e.name || e.message);
    if (!res.headersSent) res.status(404).end();
  }
});

// ─── Signaler ───
router.post('/signaler/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Not found' });

    const updated = await queryOne(
      `UPDATE essai_generations
          SET report_count = report_count + 1,
              hidden = (report_count + 1 >= $2)
        WHERE id = $1 AND status = 'completed'
        RETURNING hidden`,
      [id, MAX_REPORTS_BEFORE_HIDE]
    );
    if (!updated) return res.status(404).json({ error: 'Not found' });

    res.json({ ok: true, hidden: updated.hidden });
  } catch (e) {
    console.error('[ESSAI signaler]', e.message);
    res.status(500).json({ error: 'Could not report' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// STUDIO ANONYME — le studio complet (studio.html) sans compte, BYOK.
// Chaque opération passe par la même file essai : filigrane serveur, image
// stockée sur R2, publication dans la galerie communautaire, clé en RAM only.
// ═══════════════════════════════════════════════════════════════════════

const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const ALLOWED_IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

// ─── Upload anonyme (image source de génération, jamais publiée) ───
router.post('/upload', uploadImage.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const ext = ALLOWED_IMAGE_TYPES[req.file.mimetype];
    if (!ext) return res.status(400).json({ error: 'Unsupported format. Use JPEG, PNG, WebP or GIF.' });

    const key = `essai/uploads/${Date.now()}_${randomBytes(6).toString('hex')}.${ext}`;
    // Chemin d'upload du studio anonyme — le plus exposé d'un build public.
    if (!storageConfigured()) return res.status(503).json({ error: STORAGE_MISSING });

    const url = await uploadToR2(req.file.buffer, key, req.file.mimetype);
    res.json({ url });
  } catch (e) {
    console.error('[ESSAI upload]', e.message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

/**
 * Résout l'image source d'une opération studio anonyme.
 * - sourceId (uuid essai) : résultat anonyme précédent → URL R2 présignée
 *   fraîche (l'image filigranée stockée), jamais l'URL provider.
 * - imageUrl : upload R2 de /api/essai/upload (ou toute URL https publique) —
 *   contrôlée par assertSafeUrl (anti-SSRF), transmise au provider uniquement.
 */
async function resolveStudioSource({ sourceId, imageUrl }) {
  if (sourceId) {
    if (!UUID_RE.test(sourceId)) return { error: 'Source not found' };
    const row = await queryOne(
      `SELECT r2_key, status FROM essai_generations WHERE id = $1`,
      [sourceId]
    );
    if (!row || row.status !== 'completed' || !row.r2_key) return { error: 'Source not found' };
    return { url: await getPresignedUrl(row.r2_key, 3600) };
  }
  if (imageUrl) {
    try { assertSafeUrl(imageUrl); } catch { return { error: 'URL d\'image invalide' }; }
    return { url: imageUrl };
  }
  return { error: 'Source image required' };
}

/**
 * Tronc commun des quatre opérations studio anonymes : clé BYOK + consente-
 * ment obligatoires, filtre de prompt sur tout texte visiteur, insertion en
 * base puis mise en file. Répond au format du studio ({ taskId, generationId })
 * pour que studio.html fonctionne sans réécrire sa logique de batch.
 */
async function launchStudioJob(req, res, { kind, galleryPrompt, userText, format, imageUrl, creativeDirection }) {
  const apiKey = getRequestProviderKey();
  if (!apiKey) {
    return res.status(400).json({ error: 'API key required — paste your KIE.AI key (it stays in your browser)' });
  }
  if (req.body?.consent !== true) {
    return res.status(400).json({ error: 'Consent required: everything created here is public' });
  }
  // Tout texte fourni par le visiteur passe le filtre de modération
  if (userText) {
    const check = checkPrompt(userText);
    if (check.blocked) return res.status(422).json({ error: check.message, category: check.category });
  }

  const cleanFormat = VALID_FORMATS.includes(format) ? format : '1:1';
  const id = randomUUID();

  await query(
    `INSERT INTO essai_generations (id, prompt, status, format, kind) VALUES ($1, $2, 'queued', $3, $4)`,
    [id, galleryPrompt, cleanFormat, kind]
  );

  const q = enqueue({ id, prompt: galleryPrompt, format: cleanFormat, apiKey, ip: clientIp(req), kind, imageUrl, creativeDirection });
  if (!q.ok) {
    await query(`DELETE FROM essai_generations WHERE id = $1`, [id]).catch(() => {});
    return res.status(q.code).json({ error: q.error });
  }

  // taskId = generationId = uuid essai : studio.html les réinjecte tels quels
  // dans son polling, que l'adaptateur anonyme redirige vers /studio/status.
  res.json({ id, taskId: id, generationId: id, position: q.position, status: 'queued', type: kind });
}

// ─── Studio : visuel produit (équivalent anonyme de POST /api/generate) ───
router.post('/studio/generate', async (req, res) => {
  try {
    const { imageUrl, format, creativeDirection } = req.body || {};
    const cd = typeof creativeDirection === 'string' ? creativeDirection.trim().slice(0, 500) : '';
    const source = await resolveStudioSource({ imageUrl });
    if (source.error) return res.status(400).json({ error: source.error });

    await launchStudioJob(req, res, {
      kind: 'image',
      galleryPrompt: cd || 'Visuel produit — studio anonyme',
      userText: cd || null,
      format,
      imageUrl: source.url,
      creativeDirection: cd || null,
    });
  } catch (e) {
    console.error('[ESSAI studio generate]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the generation — try again' });
  }
});

// ─── Studio : polish (retouche pro d'un résultat anonyme) ───
router.post('/studio/polish', async (req, res) => {
  try {
    const { sourceId, imageUrl, format } = req.body || {};
    const source = await resolveStudioSource({ sourceId, imageUrl });
    if (source.error) return res.status(400).json({ error: source.error });

    await launchStudioJob(req, res, {
      kind: 'polish',
      galleryPrompt: 'Retouche studio (polish) — studio anonyme',
      userText: null,
      format,
      imageUrl: source.url,
    });
  } catch (e) {
    console.error('[ESSAI studio polish]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the polish — try again' });
  }
});

// ─── Studio : remix (prompt visiteur, filtré) ───
router.post('/studio/remix', async (req, res) => {
  try {
    const { sourceId, imageUrl, format, remixPrompt } = req.body || {};
    const cleanPrompt = typeof remixPrompt === 'string' ? remixPrompt.trim() : '';
    if (cleanPrompt.length < 3) return res.status(400).json({ error: 'Prompt too short (3 characters minimum)' });
    if (cleanPrompt.length > 500) return res.status(400).json({ error: 'Prompt too long (500 characters maximum)' });
    const source = await resolveStudioSource({ sourceId, imageUrl });
    if (source.error) return res.status(400).json({ error: source.error });

    await launchStudioJob(req, res, {
      kind: 'remix',
      galleryPrompt: cleanPrompt,
      userText: cleanPrompt,
      format,
      imageUrl: source.url,
    });
  } catch (e) {
    console.error('[ESSAI studio remix]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the remix — try again' });
  }
});

// ─── Studio : adaptation de format ───
router.post('/studio/adapt', async (req, res) => {
  try {
    const { sourceId, imageUrl, format } = req.body || {};
    if (!VALID_FORMATS.includes(format)) {
      return res.status(400).json({ error: `Format invalide. Formats acceptes : ${VALID_FORMATS.join(', ')}` });
    }
    const source = await resolveStudioSource({ sourceId, imageUrl });
    if (source.error) return res.status(400).json({ error: source.error });

    await launchStudioJob(req, res, {
      kind: 'adapt',
      galleryPrompt: `Adaptation de format ${format} — studio anonyme`,
      userText: null,
      format,
      imageUrl: source.url,
    });
  } catch (e) {
    console.error('[ESSAI studio adapt]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the format adaptation — try again' });
  }
});

// ─── Studio : statut au format studio.html ({ ready, resultUrl, state }) ───
router.get('/studio/status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Not found' });

    const row = await queryOne(
      `SELECT status, error FROM essai_generations WHERE id = $1`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });

    if (row.status === 'completed') {
      return res.json({ ready: true, resultUrl: `/api/essai/image/${id}`, state: 'completed' });
    }
    if (row.status === 'failed') {
      return res.json({ ready: false, failed: true, state: 'failed', error: row.error || 'La generation a echoue' });
    }
    const payload = { ready: false, state: row.status };
    if (row.status === 'queued') payload.position = positionOf(id);
    res.json(payload);
  } catch (e) {
    console.error('[ESSAI studio status]', e.message);
    res.status(500).json({ error: 'Status unavailable' });
  }
});

// ─── Suppression admin (réutilise l'auth existante) ───
router.delete('/admin/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Not found' });

    const row = await queryOne(`SELECT r2_key FROM essai_generations WHERE id = $1`, [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });

    if (row.r2_key) {
      try { await deleteFromR2(row.r2_key); }
      catch (err) { console.error('[ESSAI admin delete R2]', err.message); }
    }
    await query(`DELETE FROM essai_generations WHERE id = $1`, [id]);

    res.json({ ok: true });
  } catch (e) {
    console.error('[ESSAI admin delete]', e.message);
    res.status(500).json({ error: 'Could not delete' });
  }
});

export default router;

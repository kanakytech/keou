/**
 * Essai Queue — FIFO in-memory pour les générations anonymes (BYOK)
 *
 * Sert deux surfaces anonymes, avec le MÊME contrat de sortie :
 *   - l'essai simple (/api/essai/generer, texte → image), kind 'text'
 *   - le studio anonyme (/api/essai/studio/*), kinds 'image' (img→img avec
 *     brief produit), 'polish', 'remix', 'adapt'
 *
 * Contrat de sécurité (non négociable) :
 *   - La clé API du visiteur vit UNIQUEMENT dans l'objet job en RAM, le temps
 *     du job. Jamais en DB, jamais dans un log, jamais dans un message
 *     d'erreur. Elle est effacée (job.apiKey = null) dès l'état terminal.
 *   - L'URL temporaire du provider n'est JAMAIS stockée : le résultat est
 *     téléchargé, filigrané côté serveur, poussé sur R2 (essai/<uuid>.png),
 *     et seule la clé R2 est écrite en DB.
 *   - Les erreurs provider sont mappées vers des messages sûrs — jamais de
 *     texte brut du provider en DB ni vers le client.
 *
 * Concurrence : ESSAI_CONCURRENCY (1 par défaut, 2 max) — file FIFO stricte,
 * position exposée pour l'UI. ESSAI_MAX_PER_IP règle le nombre de jobs en
 * file par visiteur (défaut 2 — à monter sur Railway si le studio anonyme
 * doit absorber des batchs plus larges).
 */

import sharp from 'sharp';
import { query } from '../db.js';
import { uploadToR2 } from './r2.js';
import * as kie from './providers/kie.js';
import { buildImagePrompt, POLISH_PROMPT, ADAPT_PROMPT } from './studio-prompts.js';

const CONCURRENCY = Math.min(2, Math.max(1, parseInt(process.env.ESSAI_CONCURRENCY) || 1));
const MAX_QUEUE = 20;               // au-delà, on refuse (429)
const MAX_PER_IP = Math.max(1, parseInt(process.env.ESSAI_MAX_PER_IP) || 2); // jobs simultanés en file par IP
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 4 * 60_000; // 4 min puis échec

const queue = [];                   // jobs en attente (FIFO)
let running = 0;

// ─── Filigrane serveur ───

/**
 * Compose un filigrane discret « studio.kanaky.xyz » en bas à droite.
 * Taille relative à la largeur de l'image, opacité modérée + liseré sombre
 * pour rester lisible sur fond clair comme sombre.
 */
export async function watermarkImage(buffer) {
  const img = sharp(buffer);
  const meta = await img.metadata();
  const w = meta.width || 1024;
  const fontSize = Math.max(16, Math.round(w * 0.024));
  const pad = Math.round(fontSize * 0.9);
  // L'adresse canonique du studio depuis le 13/08. « keou.studio » n'a
  // jamais existé : chaque création publique portait un domaine mort, sur
  // le seul support qui nous fait de la publicité gratuite.
  const text = 'studio.kanaky.xyz';
  const svgW = Math.round(text.length * fontSize * 0.64) + pad * 2;
  const svgH = fontSize + pad * 2;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">` +
    `<text x="${svgW - pad}" y="${svgH - pad}" text-anchor="end" ` +
    `font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="600" ` +
    `fill="#ffffff" fill-opacity="0.5" stroke="#000000" stroke-opacity="0.28" stroke-width="1.2" ` +
    `paint-order="stroke">${text}</text></svg>`
  );
  return img.composite([{ input: svg, gravity: 'southeast' }]).png().toBuffer();
}

// ─── Messages d'erreur sûrs (jamais le texte brut du provider) ───

function safeErrorMessage(err) {
  const msg = err?.message || '';
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid')) {
    return 'Cle API invalide ou non autorisee — verifiez votre cle KIE.AI';
  }
  if (msg.includes('402') || msg.includes('insufficient') || msg.includes('exhausted')) {
    return 'Credits KIE.AI epuises sur votre cle — rechargez sur kie.ai puis reessayez';
  }
  if (msg.includes('429') || msg.includes('rate limit')) {
    return 'Limite de debit atteinte cote provider — patientez une minute et reessayez';
  }
  if (msg === 'ESSAI_TIMEOUT') {
    return 'Delai depasse (4 min) — la generation a ete abandonnee, reessayez';
  }
  return 'La generation a echoue — reessayez dans un instant';
}

// ─── Worker ───

/**
 * Crée la tâche provider selon le kind du job. Tous les kinds produisent une
 * image PNG → même pipeline aval (filigrane + R2 + galerie publique).
 */
async function createProviderTask(job) {
  switch (job.kind) {
    case 'image': // studio anonyme : visuel produit depuis une image source
      return kie.generateImage(job.apiKey, {
        prompt: buildImagePrompt(job.creativeDirection),
        imageUrls: [job.imageUrl],
        aspectRatio: job.format,
        outputFormat: 'png',
        resolution: '1K', // anonyme : on économise les crédits du visiteur
      });
    case 'polish': // flux-2 : '2K' est la seule résolution éprouvée en prod
      return kie.polish(job.apiKey, {
        prompt: POLISH_PROMPT,
        imageUrl: job.imageUrl,
        aspectRatio: job.format,
        resolution: '2K',
      });
    case 'remix': // le prompt visiteur (déjà filtré) EST le prompt de remix
      return kie.remix(job.apiKey, {
        prompt: job.prompt,
        imageUrl: job.imageUrl,
        aspectRatio: job.format,
        resolution: '2K',
      });
    case 'adapt':
      return kie.adapt(job.apiKey, {
        prompt: ADAPT_PROMPT,
        imageUrl: job.imageUrl,
        aspectRatio: job.format,
      });
    default: // 'text' — essai simple existant
      return kie.textToImage(job.apiKey, {
        prompt: job.prompt,
        aspectRatio: job.format,
        outputFormat: 'png',
        resolution: '1K', // essai : on économise les crédits du visiteur
      });
  }
}

async function runJob(job) {
  try {
    await query(`UPDATE essai_generations SET status = 'processing' WHERE id = $1`, [job.id]);

    // 1. Création de la tâche provider (clé du visiteur, RAM only)
    const task = await createProviderTask(job);

    // 2. Polling jusqu'à état terminal ou timeout
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let resultUrl = null;
    for (;;) {
      if (Date.now() > deadline) throw new Error('ESSAI_TIMEOUT');
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const st = await kie.pollTask(job.apiKey, { taskId: task.taskId, recordId: task.recordId, metadata: '{}' });
      if (st.status === 'failed') throw new Error(st.error || 'provider failed');
      if (st.status === 'completed' && st.resultUrl) { resultUrl = st.resultUrl; break; }
    }

    // 3. Téléchargement + filigrane + R2 — l'URL provider ne sort jamais d'ici
    const dl = await fetch(resultUrl);
    if (!dl.ok) throw new Error(`download ${dl.status}`);
    const raw = Buffer.from(await dl.arrayBuffer());
    const watermarked = await watermarkImage(raw);
    const r2Key = `essai/${job.id}.png`;
    await uploadToR2(watermarked, r2Key, 'image/png');

    await query(
      `UPDATE essai_generations SET status = 'completed', r2_key = $1, completed_at = NOW()
        WHERE id = $2 AND status IN ('queued','processing')`,
      [r2Key, job.id]
    );
  } catch (err) {
    // Log générique côté serveur — jamais la clé, jamais l'URL signée
    console.error(`[ESSAI] job ${job.id} failed:`, (err?.message || 'unknown').slice(0, 200));
    await query(
      `UPDATE essai_generations SET status = 'failed', error = $1
        WHERE id = $2 AND status IN ('queued','processing')`,
      [safeErrorMessage(err), job.id]
    ).catch(() => {});
  } finally {
    job.apiKey = null; // la clé ne survit pas au job
    running--;
    setImmediate(pump);
  }
}

function pump() {
  while (running < CONCURRENCY && queue.length > 0) {
    const job = queue.shift();
    running++;
    runJob(job);
  }
}

// ─── API publique du module ───

/**
 * Enfile une génération. La clé n'est référencée que par l'objet job.
 * kind : 'text' (défaut) | 'image' | 'polish' | 'remix' | 'adapt'.
 * imageUrl / creativeDirection ne servent qu'aux kinds studio.
 * @returns {{ ok: true, position: number } | { ok: false, code: number, error: string }}
 */
export function enqueue({ id, prompt, format, apiKey, ip, kind = 'text', imageUrl = null, creativeDirection = null }) {
  if (queue.length >= MAX_QUEUE) {
    return { ok: false, code: 429, error: 'File d\'essai pleine — reessayez dans quelques minutes' };
  }
  const mine = queue.filter((j) => j.ip === ip).length;
  if (mine >= MAX_PER_IP) {
    return { ok: false, code: 429, error: 'Vous avez deja des generations en file — attendez qu\'elles se terminent' };
  }
  queue.push({ id, prompt, format, apiKey, ip, kind, imageUrl, creativeDirection });
  const position = queue.length + running; // rang global dans la file
  setImmediate(pump);
  return { ok: true, position };
}

/** Position 1-based d'un job encore en file (0 = en cours ou absent de la file). */
export function positionOf(id) {
  const idx = queue.findIndex((j) => j.id === id);
  return idx === -1 ? 0 : idx + 1 + running;
}

/** État instantané pour l'UI. */
export function queueStats() {
  return { waiting: queue.length, running, concurrency: CONCURRENCY };
}

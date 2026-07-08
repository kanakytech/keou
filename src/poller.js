/**
 * Background Task Poller — Multi-provider
 *
 * Polls KIE.AI or Fal.ai for all "processing" generations every 15s.
 * Detects provider from metadata.provider field.
 * On failure → refunds credits automatically.
 * On success → persists result to R2, updates DB.
 */

import { config } from './config.js';
import { query, queryOne, queryAll } from './db.js';
import { refundCredits, billingMode } from './utils/credits.js';
// import { tagGeneration } from './utils/tagger.js'; // disabled — categorization removed
import { persistFromUrl } from './lib/r2.js';
import { getProviderApiKey } from './lib/providers/index.js';
import * as kieProvider from './lib/providers/kie.js';
import * as falProvider from './lib/providers/fal.js';

const POLL_INTERVAL = 15_000;   // 15 seconds
const MAX_AGE_MS = 60 * 60_000; // 1 hour — give up after this
const BATCH_SIZE = 10;          // Process up to 10 tasks in parallel

// ─── Concurrency control (mutex) ───
let _polling = false;

/** Process a single task — detect provider and poll accordingly */
async function processTask(task) {
  let providerName = 'kie';
  try {
    const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {});
    providerName = meta.provider || 'kie';
  } catch (err) { console.error('[POLLER META]', err.message); }

  const provider = providerName === 'fal' ? falProvider : kieProvider;

  let apiKey;
  try {
    apiKey = await getProviderApiKey(providerName);
  } catch (err) {
    console.error('[POLLER KEY]', err.message);
    return; // No key configured — skip
  }

  try {
    const result = await provider.pollTask(apiKey, {
      taskId: task.task_id,
      recordId: task.record_id,
      metadata: task.metadata,
    });

    // ── Failure ──
    if (result.status === 'failed') {
      // Atomic transition — only refund if we're the one finalizing the row
      const transition = await query(
        `UPDATE generations SET status='failed', error=$1 WHERE id=$2 AND status IN ('pending','processing') RETURNING id`,
        [result.error || `${providerName} task failed`, task.id]
      );
      if (transition.rowCount === 0) return; // Another worker got there first
      // quota mode buckets everything into image/video pools; credits mode
      // journals the real action type (refund itself is pool-agnostic there).
      const creditType = billingMode() === 'credits' ? task.type : (task.type === 'video' ? 'video' : 'image');
      if (task.credits_used > 0) {
        await refundCredits(task.user_id, creditType, task.credits_used, task.id);
      }
      console.log(`  [POLLER] #${task.id} failed (${providerName}) — ${task.credits_used} credit(s) refunded`);
      return;
    }

    // ── Still processing ──
    if (result.status !== 'completed' || !result.resultUrl) return;

    // ── Success! Persist result to R2 for permanent storage ──
    // Atomic: only persist + UPDATE if still processing — keeps concurrent client-poll wins consistent.
    const stillOpen = await queryOne('SELECT status FROM generations WHERE id = $1', [task.id]);
    if (!stillOpen || stillOpen.status === 'completed' || stillOpen.status === 'failed') return;

    let finalUrl = result.resultUrl;
    try {
      const isVideo = task.type === 'video' || task.type === 'vid-upscale';
      const isAudio = task.type === 'tts' || task.type === 'sfx';
      const ext = isVideo ? 'mp4' : isAudio ? 'mp3' : (result.resultUrl.match(/\.(png|jpg|jpeg|webp|gif)/) || ['', 'png'])[1];
      const r2Key = `results/${task.id}.${ext}`;
      finalUrl = await persistFromUrl(result.resultUrl, r2Key);
      await query(
        `UPDATE generations SET status='completed', result_url=$1, r2_key=$2, completed_at=NOW()
         WHERE id=$3 AND status IN ('pending','processing')`,
        [finalUrl, r2Key, task.id]
      );
      console.log(`  [POLLER] #${task.id} completed (${task.type}/${providerName}) → R2 persisted`);
    } catch (r2Err) {
      console.warn(`  [POLLER] #${task.id} R2 persist failed: ${r2Err.message} — using ${providerName} URL`);
      await query(
        `UPDATE generations SET status='completed', result_url=$1, completed_at=NOW()
         WHERE id=$2 AND status IN ('pending','processing')`,
        [result.resultUrl, task.id]
      );
    }

    // Auto-tagging désactivé — la catégorisation produit (Beauty / Food / etc)
    // a été retirée de l'UI. Le tag column reste pour backward compat mais
    // n'est plus alimentée.
    // tagGeneration(task.id).catch(err => console.error('[Tagger]', err.message));
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`  [POLLER] Timeout on task #${task.id}`);
    } else {
      console.error(`  [POLLER] Error on task #${task.id}:`, err.message);
    }
  }
}

/** Main poll cycle — check all processing tasks in parallel batches */
async function pollProcessingTasks() {
  if (_polling) return;
  _polling = true;

  try {
    const tasks = await queryAll(
      `SELECT id, user_id, type, task_id, record_id, credits_used, created_at, metadata
       FROM generations
       WHERE status = 'processing'
         AND task_id IS NOT NULL
         AND created_at > NOW() - INTERVAL '1 hour'`
    );

    if (tasks.length === 0) return;

    // Process in parallel batches
    for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
      const batch = tasks.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map(task => processTask(task)));
    }
  } catch (err) {
    console.error('  [POLLER] Poll cycle error:', err.message);
  } finally {
    _polling = false;
  }
}

/** Cleanup tasks that have been processing for too long */
async function cleanupStaleGenerations() {
  try {
    const stale = await queryAll(
      `SELECT id, user_id, type, credits_used FROM generations
       WHERE status = 'processing'
         AND created_at < NOW() - INTERVAL '1 hour'
       LIMIT 50`
    );

    await Promise.allSettled(stale.map(async (task) => {
      // Atomic: only finalize + refund if still processing
      const transition = await query(
        `UPDATE generations SET status='failed', error=$1 WHERE id=$2 AND status IN ('pending','processing') RETURNING id`,
        ['Task expired (no result after 1 hour)', task.id]
      );
      if (transition.rowCount === 0) return;
      // quota mode buckets everything into image/video pools; credits mode
      // journals the real action type (refund itself is pool-agnostic there).
      const creditType = billingMode() === 'credits' ? task.type : (task.type === 'video' ? 'video' : 'image');
      if (task.credits_used > 0) {
        await refundCredits(task.user_id, creditType, task.credits_used, task.id);
      }
      console.log(`  [POLLER] #${task.id} expired — ${task.credits_used} credit(s) refunded`);
    }));
  } catch (err) {
    console.error('  [POLLER] Stale cleanup error:', err.message);
  }
}

// ─── Start / Stop ───

let pollTimer = null;
let cleanupTimer = null;

export function startPoller() {
  setTimeout(() => {
    pollProcessingTasks();
    cleanupStaleGenerations();
  }, 5000);

  pollTimer = setInterval(pollProcessingTasks, POLL_INTERVAL);
  cleanupTimer = setInterval(cleanupStaleGenerations, 10 * 60_000);

  console.log(`  [POLLER] Background poller started (every ${POLL_INTERVAL / 1000}s)`);
}

export function stopPoller() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
}

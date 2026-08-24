/**
 * Conversations — Chat history CRUD
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { query, queryOne, queryAll } from '../db.js';

const router = Router();

// List conversations (newest first)
router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await queryAll(
      `SELECT id, title, created_at, updated_at FROM conversations
       WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ conversations: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

// Create conversation
router.post('/', requireAuth, async (req, res) => {
  try {
    const title = req.body.title || 'New conversation';
    const row = await queryOne(
      `INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id, title, created_at`,
      [req.user.id, title.slice(0, 100)]
    );
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// Rename conversation
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });
    const row = await queryOne(
      `UPDATE conversations SET title = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3 RETURNING id, title`,
      [title.slice(0, 100), req.params.id, req.user.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: 'Failed to rename' });
  }
});

// Delete conversation
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM conversations WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// Get messages for a conversation
router.get('/:id/messages', requireAuth, async (req, res) => {
  try {
    // Verify ownership
    const conv = await queryOne(
      'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!conv) return res.status(404).json({ error: 'Not found' });

    const rows = await queryAll(
      `SELECT role, content, image_url, generation_ids, created_at FROM conversation_messages
       WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({ messages: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

export default router;

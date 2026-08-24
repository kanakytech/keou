import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ─── Get Profile ───
router.get('/', requireAuth, async (req, res) => {
  try {
    const user = await queryOne('SELECT id, name, email, role, status, created_at, last_login_at FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (e) {
    console.error('Profile get error:', e);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// ─── Update Profile (name only) ───
router.put('/', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    const clean = typeof name === 'string' ? name.trim() : '';
    if (!clean) return res.status(400).json({ error: 'Name required' });
    // Mêmes bornes qu'à l'inscription (src/routes/auth.js) : la mise à jour du
    // profil les ignorait, ce qui laissait entrer un nom de longueur libre.
    // Les caractères de contrôle et le balisage n'ont rien à faire dans un nom
    // affiché ; on les refuse à l'entrée plutôt que de compter sur
    // l'échappement de chaque point d'affichage présent et à venir.
    if (clean.length > 80) return res.status(400).json({ error: 'Name is too long (max 80 characters)' });
    if (/[<>\u0000-\u001f\u007f]/.test(clean)) return res.status(400).json({ error: 'Name contains invalid characters' });

    await query('UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2', [clean, req.user.id]);

    res.json({ ok: true });
  } catch (e) {
    console.error('Profile update error:', e);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

export default router;

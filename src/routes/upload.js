import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { uploadToR2, getMimeType } from '../lib/r2.js';
import crypto from 'crypto';

const router = Router();
const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const uploadVideo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/x-matroska'];

// Upload image to R2 (temporary — used as input for KIE.AI generation)
router.post('/', requireAuth, uploadImage.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    if (!ALLOWED_IMAGE_TYPES.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Unsupported format. Use JPEG, PNG, WebP or GIF.' });
    }

    const SAFE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
    const ext = SAFE_EXT[req.file.mimetype] || 'png';
    const key = `uploads/${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
    const url = await uploadToR2(req.file.buffer, key, req.file.mimetype);

    res.json({ url });
  } catch (e) {
    console.error('Upload error:', e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Upload video to R2 (temporary — used as input for video upscale)
router.post('/video', requireAuth, uploadVideo.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    if (!ALLOWED_VIDEO_TYPES.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Unsupported format. Use MP4, MOV or MKV.' });
    }

    const ext = req.file.originalname?.split('.').pop() || 'mp4';
    const key = `uploads/video_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
    const contentType = req.file.mimetype || 'video/mp4';
    const url = await uploadToR2(req.file.buffer, key, contentType);

    console.log(`[UPLOAD] Video uploaded: ${key} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);
    res.json({ url });
  } catch (e) {
    console.error('Video upload error:', e);
    res.status(500).json({ error: 'Video upload failed' });
  }
});

export default router;

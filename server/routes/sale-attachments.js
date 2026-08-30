const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { getDb } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'sale-attachments');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    let ext = path.extname(file.originalname);
    if (!ext && file.mimetype) {
      const mimeExt = file.mimetype.split('/')[1];
      if (mimeExt) ext = `.${mimeExt}`;
    }
    cb(null, `attachment-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|m4a|mp4|mpeg|mp3|webm|wav/i;
    const extMatch = allowed.test(path.extname(file.originalname));
    const mimeMatch = allowed.test(file.mimetype);
    if (extMatch || mimeMatch) cb(null, true);
    else cb(new Error('Only images (JPEG/PNG/WebP) or audio (M4A/MP3/WebM/WAV) are allowed'));
  },
});

// ─── Error handler for multer errors ──────────────────────────
const handleMulterError = (err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, message: 'File size exceeds 8MB limit' });
    }
    return res.status(400).json({ success: false, message: err.message });
  }
  if (err instanceof Error) {
    return res.status(400).json({ success: false, message: err.message });
  }
  next(err);
};

// ─── POST /api/sales/:saleId/attachments ──────────────────────
router.post('/:saleId(\\d+)/attachments', authenticate, authorize('owner', 'manager', 'employee'), (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return handleMulterError(err, req, res, next);
    next();
  });
}, async (req, res, next) => {
  try {
    const db = await getDb();
    const sale = await db.prepare('SELECT id FROM sales WHERE id = ?').get(req.params.saleId);
    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    const type = req.body.type;
    if (type !== 'photo' && type !== 'voice_note') {
      return res.status(400).json({ success: false, message: "type must be 'photo' or 'voice_note'" });
    }

    let durationSeconds = null;
    if (req.body.duration_seconds !== undefined && req.body.duration_seconds !== null && req.body.duration_seconds !== '') {
      const parsed = parseInt(req.body.duration_seconds, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return res.status(400).json({ success: false, message: 'duration_seconds must be a non-negative number' });
      }
      durationSeconds = parsed;
    }

    const fileUrl = `/uploads/sale-attachments/${req.file.filename}`;

    const result = await db.prepare(
      'INSERT INTO sale_attachments (sale_id, type, file_url, duration_seconds, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) RETURNING *'
    ).get(req.params.saleId, type, fileUrl, durationSeconds, req.user.id);

    res.status(201).json({ success: true, data: result });
  } catch (err) { next(err); }
});

// ─── GET /api/sales/:saleId/attachments ───────────────────────
router.get('/:saleId(\\d+)/attachments', authenticate, authorize('owner', 'manager', 'employee'), async (req, res, next) => {
  try {
    const db = await getDb();
    const rows = await db.prepare(`
      SELECT sa.*, u.name as uploaded_by_name
      FROM sale_attachments sa
      LEFT JOIN users u ON sa.uploaded_by = u.id
      WHERE sa.sale_id = ?
      ORDER BY sa.created_at ASC
    `).all(req.params.saleId);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

module.exports = router;

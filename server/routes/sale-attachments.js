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

// multer writes the file to disk before this route handler runs at all (it has to —
// the body fields we validate below arrive in the same multipart payload as the
// file). Every rejection path after that point must delete the now-orphaned file,
// or a stream of invalid requests slowly fills the disk with files nothing points to.
async function cleanupUploadedFile(req) {
  if (req.file?.path) {
    try { await fs.promises.unlink(req.file.path); } catch (_) { /* best-effort — don't mask the real response */ }
  }
}

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
    if (!sale) {
      await cleanupUploadedFile(req);
      return res.status(404).json({ success: false, message: 'Sale not found' });
    }
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    const type = req.body.type;
    if (type !== 'photo' && type !== 'voice_note') {
      await cleanupUploadedFile(req);
      return res.status(400).json({ success: false, message: "type must be 'photo' or 'voice_note'" });
    }

    let durationSeconds = null;
    if (req.body.duration_seconds !== undefined && req.body.duration_seconds !== null && req.body.duration_seconds !== '') {
      const parsed = parseInt(req.body.duration_seconds, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        await cleanupUploadedFile(req);
        return res.status(400).json({ success: false, message: 'duration_seconds must be a non-negative number' });
      }
      durationSeconds = parsed;
    }

    // Optional: scope this attachment to one line item instead of the whole order.
    // Must belong to this sale — otherwise a client could attach a photo/voice note
    // to an item on someone else's order.
    let saleItemId = null;
    if (req.body.sale_item_id !== undefined && req.body.sale_item_id !== null && req.body.sale_item_id !== '') {
      const parsed = parseInt(req.body.sale_item_id, 10);
      if (!Number.isFinite(parsed)) {
        await cleanupUploadedFile(req);
        return res.status(400).json({ success: false, message: 'sale_item_id must be a number' });
      }
      const item = await db.prepare('SELECT id FROM sale_items WHERE id = ? AND sale_id = ?').get(parsed, req.params.saleId);
      if (!item) {
        await cleanupUploadedFile(req);
        return res.status(400).json({ success: false, message: 'sale_item_id does not belong to this sale' });
      }
      saleItemId = parsed;
    }

    const fileUrl = `/uploads/sale-attachments/${req.file.filename}`;

    const result = await db.prepare(
      'INSERT INTO sale_attachments (sale_id, sale_item_id, type, file_url, duration_seconds, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) RETURNING *'
    ).get(req.params.saleId, saleItemId, type, fileUrl, durationSeconds, req.user.id);

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    await cleanupUploadedFile(req);
    next(err);
  }
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

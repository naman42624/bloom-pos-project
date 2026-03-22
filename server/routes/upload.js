const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { authenticate } = require('../middleware/auth');
const { authorize } = require('../middleware/rbac');

const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'general');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ─── POST /api/upload ─────────────────────────────────────────────
router.post(
  '/',
  authenticate,
  authorize('owner', 'manager', 'employee'),
  upload.single('image'),
  (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
      }
      const imageUrl = `/uploads/general/${req.file.filename}`;
      res.status(201).json({ success: true, url: imageUrl });
    } catch (err) { next(err); }
  }
);

module.exports = router;

const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { getDb: getAsyncDb } = require('../config/database-async');
const { authenticate, authorize } = require('../middleware/auth');
const { clearTimezoneCache } = require('../utils/time');
const { readGstSettings, cleanHsn } = require('../utils/gst-settings');
const { cleanPrefix } = require('../utils/invoice-number');
const { SHOW_KEYS } = require('../utils/invoice-view');

// Bill settings (Settings -> Bill). Cleans values in place; returns a plain
// message when one is wrong.
function normalizeBillSettings(st) {
  const has = (k) => Object.prototype.hasOwnProperty.call(st, k);
  const rate = (k, label) => {
    if (!has(k)) return null;
    const n = Number(st[k]);
    if (String(st[k]).trim() === '' || !Number.isFinite(n) || n < 0 || n > 40) return `${label} must be a GST percent from 0 to 40.`;
    st[k] = String(n);
    return null;
  };
  const e = rate('gst_delivery_rate', 'Delivery GST') || rate('gst_default_rate', 'GST for custom items');
  if (e) return e;
  for (const k of ['gst_default_hsn', 'gst_delivery_sac']) {
    if (!has(k)) continue;
    const raw = String(st[k] || '').replace(/\s/g, '');
    if (raw && !cleanHsn(raw)) return 'HSN and SAC codes are 4 to 8 numbers, like 0603.';
    st[k] = raw;
  }
  for (const k of ['invoice_prefix', 'credit_note_prefix']) {
    if (!has(k)) continue;
    const raw = String(st[k] || '').trim();
    if (!raw || cleanPrefix(raw) !== raw.toUpperCase()) return 'A bill number start uses only letters and numbers, 1 to 5 of them, like INV.';
    st[k] = raw.toUpperCase();
  }
  if (has('invoice_series_mode') && !['shop', 'all'].includes(st.invoice_series_mode)) return 'Pick one bill number series per shop, or one for all shops.';
  if (has('bill_round_off')) st.bill_round_off = st.bill_round_off === true || st.bill_round_off === '1' || st.bill_round_off === 1 ? '1' : '0';
  if (has('bill_pan')) {
    const p = String(st.bill_pan || '').trim().toUpperCase();
    if (p && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p)) return 'The PAN has 10 letters and numbers, like ABCDE1234F. Check it or leave it empty.';
    st.bill_pan = p;
  }
  for (const k of ['bill_legal_name', 'bill_terms']) {
    if (has(k)) st[k] = String(st[k] || '').trim().slice(0, k === 'bill_terms' ? 300 : 150);
  }
  if (has('bill_show_fields')) {
    let obj = st.bill_show_fields;
    if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch (err) { obj = {}; } }
    const clean = {};
    for (const k of SHOW_KEYS) if (obj && obj[k] === false) clean[k] = false;
    st.bill_show_fields = JSON.stringify(clean);
  }
  return null;
}
const { listBags, maskAmount, readCashMode } = require('../utils/helper-bags');

// "Raju", "Raju and Priya", "Raju, Priya and Sam"
function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// The refusal copy when any helper at any shop still holds cash, else null.
async function helperCashOut(adb) {
  const locations = await adb.prepare('SELECT id FROM locations ORDER BY id').all();
  const names = new Map(); // staff_id -> name
  let totalPaise = 0;
  for (const loc of locations) {
    for (const b of await listBags(adb, loc.id)) {
      const p = Math.round(Number(b.held) * 100);
      if (p === 0) continue;
      totalPaise += p;
      names.set(b.staff_id, b.name);
    }
  }
  if (names.size === 0) return null;
  return `Collect the cash from ${joinNames([...names.values()])} first (${maskAmount(totalPaise / 100)}).`;
}

const router = express.Router();
router.use(authenticate);

// ─── GET /api/settings ──────────────────────────────────────
// Owner and Manager can view all settings
// ─── GET /api/settings/bill ─────────────────────────────────
// What every staff screen needs to work a bill out exactly as the server
// does (utils/gst.js). No amounts, no secrets.
router.get('/bill', async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const cfg = await readGstSettings(db);
    res.json({ success: true, data: { round_off: cfg.roundOff, delivery_rate: cfg.deliveryRate, default_rate: cfg.defaultRate, default_hsn: cfg.defaultHsn } });
  } catch (error) {
    next(error);
  }
});

router.get('/', authorize('owner', 'manager'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const settings = await db.prepare('SELECT * FROM settings ORDER BY key').all();

    // Convert to key-value object for easier consumption
    const settingsMap = {};
    for (const s of settings) {
      settingsMap[s.key] = {
        value: s.value,
        description: s.description,
        updated_at: s.updated_at,
      };
    }

    res.json({ success: true, data: { settings: settingsMap } });
  } catch (error) {
    next(error);
  }
});

// ─── PUT /api/settings ──────────────────────────────────────
// Only Owner can update settings
router.put(
  '/',
  authorize('owner'),
  [
    body('settings')
      .isObject()
      .withMessage('Settings must be an object of key-value pairs'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const db = getDb();
      const { settings } = req.body;

      // Helper cash mode (spec 11.1): only 'register' or 'bag', and no
      // switch while any helper still holds cash at any shop.
      if (Object.prototype.hasOwnProperty.call(settings, 'helper_cash_mode')) {
        const wanted = String(settings.helper_cash_mode).trim();
        if (wanted !== 'register' && wanted !== 'bag') {
          return res.status(400).json({ success: false, message: 'Pick where helper cash goes: straight to the register, or a separate bag per helper.' });
        }
        settings.helper_cash_mode = wanted;
        const adb = await getAsyncDb();
        const current = await readCashMode(adb);
        if (wanted !== current) {
          const blocked = await helperCashOut(adb);
          if (blocked) return res.status(409).json({ success: false, message: blocked });
        }
      }

      const billErr = normalizeBillSettings(settings);
      if (billErr) return res.status(400).json({ success: false, message: billErr });

      const update = db.prepare(
        "UPDATE settings SET value = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?"
      );

      const tx = db.transaction(() => {
        for (const [key, value] of Object.entries(settings)) {
          const existing = db.prepare('SELECT id FROM settings WHERE key = ?').get(key);
          if (existing) {
            update.run(String(value), req.user.id, key);
          }
        }
      });
      tx();

      // Clear timezone cache if timezone was updated
      if ('timezone' in settings) {
        clearTimezoneCache();
      }

      // Return updated settings
      const allSettings = db.prepare('SELECT * FROM settings ORDER BY key').all();
      const settingsMap = {};
      for (const s of allSettings) {
        settingsMap[s.key] = {
          value: s.value,
          description: s.description,
          updated_at: s.updated_at,
        };
      }

      res.json({
        success: true,
        message: 'Settings updated successfully',
        data: { settings: settingsMap },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── Tax Rates ──────────────────────────────────────────────

// GET /api/settings/tax-rates
router.get('/tax-rates', authorize('owner', 'manager', 'employee', 'counter_staff'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const taxRates = await db
      .prepare('SELECT * FROM tax_rates WHERE is_active = 1 ORDER BY percentage')
      .all();

    res.json({ success: true, data: { taxRates } });
  } catch (error) {
    next(error);
  }
});

// GET /api/settings/shop-info
// The one setting every staff role needs to read: the shop name printed on
// delivery challans / pickup slips. GET / stays owner/manager-only (it holds
// prefs and flags staff shouldn't see), so this exposes shop_name (and the UPI QR) only —
// same narrow-endpoint pattern as /tax-rates above and /auth/staff-roster.
// upi_qr_image_url is the shop's UPI QR, shown on the helper payment screen
// (already public on the customer order page).
router.get('/shop-info', authorize('owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner', 'helper'), async (req, res, next) => {
  try {
    const db = await getAsyncDb();
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'shop_name'").get();
    const qr = await db.prepare("SELECT value FROM settings WHERE key = 'upi_qr_image_url'").get();
    res.json({ success: true, data: { shop_name: row?.value || null, upi_qr_image_url: qr?.value || null } });
  } catch (error) {
    next(error);
  }
});

// POST /api/settings/tax-rates
router.post(
  '/tax-rates',
  authorize('owner'),
  [
    body('name').trim().notEmpty().withMessage('Tax name is required'),
    body('percentage')
      .isFloat({ min: 0, max: 100 })
      .withMessage('Percentage must be between 0 and 100'),
    body('is_default').optional().isBoolean(),
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { name, percentage, is_default } = req.body;
      const db = getDb();

      const tx = db.transaction(() => {
        // If marking as default, unset existing default
        if (is_default) {
          db.prepare('UPDATE tax_rates SET is_default = 0').run();
        }

        db.prepare(
          'INSERT INTO tax_rates (name, percentage, is_default, created_by) VALUES (?, ?, ?, ?)'
        ).run(name, percentage, is_default ? 1 : 0, req.user.id);
      });
      tx();

      const taxRates = db
        .prepare('SELECT * FROM tax_rates WHERE is_active = 1 ORDER BY percentage')
        .all();

      res.status(201).json({
        success: true,
        message: 'Tax rate created',
        data: { taxRates },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /api/settings/tax-rates/:id
router.put(
  '/tax-rates/:id',
  authorize('owner'),
  [
    body('name').optional().trim().notEmpty(),
    body('percentage').optional().isFloat({ min: 0, max: 100 }),
    body('is_default').optional().isBoolean(),
    body('is_active').optional().isBoolean(),
  ],
  (req, res, next) => {
    try {
      const db = getDb();
      const existing = db
        .prepare('SELECT id FROM tax_rates WHERE id = ?')
        .get(req.params.id);

      if (!existing) {
        return res.status(404).json({ success: false, message: 'Tax rate not found' });
      }

      const { name, percentage, is_default, is_active } = req.body;

      const tx = db.transaction(() => {
        if (is_default) {
          db.prepare('UPDATE tax_rates SET is_default = 0').run();
        }

        const updates = [];
        const values = [];

        if (name !== undefined) { updates.push('name = ?'); values.push(name); }
        if (percentage !== undefined) { updates.push('percentage = ?'); values.push(percentage); }
        if (is_default !== undefined) { updates.push('is_default = ?'); values.push(is_default ? 1 : 0); }
        if (is_active !== undefined) { updates.push('is_active = ?'); values.push(is_active ? 1 : 0); }

        if (updates.length > 0) {
          updates.push("updated_at = CURRENT_TIMESTAMP");
          values.push(parseInt(req.params.id));
          db.prepare(`UPDATE tax_rates SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        }
      });
      tx();

      const taxRates = db
        .prepare('SELECT * FROM tax_rates WHERE is_active = 1 ORDER BY percentage')
        .all();

      res.json({
        success: true,
        message: 'Tax rate updated',
        data: { taxRates },
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;

/**
 * Expense items: the shared list of named things the shop pays for.
 * Works with a plain db handle or a withMoneyTx handle (db.prepare(...).get/run).
 */

function nameKey(name) {
  return String(name == null ? '' : name).trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function followMerge(db, item) {
  if (item && item.merged_into) {
    const target = await db.prepare('SELECT * FROM expense_items WHERE id = ?').get(item.merged_into);
    if (target) return target;
  }
  return item;
}

async function activate(db, item) {
  if (item && item.is_active === false) {
    await db.prepare('UPDATE expense_items SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(item.id);
    return { ...item, is_active: true };
  }
  return item;
}

async function resolveItem(db, { item_id, item_name, category, userId } = {}) {
  if (item_id) {
    const found = await db.prepare('SELECT * FROM expense_items WHERE id = ?').get(item_id);
    if (!found) throw httpError(400, 'That expense item was not found. Pick it again from the list.');
    // By id (Change, Record a return) a hidden item stays hidden; only a
    // typed name brings it back (spec 5.1 step 3).
    return followMerge(db, found);
  }

  const key = nameKey(item_name);
  if (!key) throw httpError(400, 'Type what this expense was for.');

  let item = await db.prepare('SELECT * FROM expense_items WHERE name_key = ?').get(key);
  if (!item) {
    if (!category) throw httpError(400, 'Pick what kind of expense this is.');
    const display = String(item_name).trim().replace(/\s+/g, ' ').slice(0, 80);
    // A parallel save of the same new name is settled by the unique key.
    await db.prepare(
      'INSERT INTO expense_items (name, name_key, category, created_by) VALUES (?, ?, ?, ?) ON CONFLICT (name_key) DO NOTHING'
    ).run(display, key, category, userId || null);
    item = await db.prepare('SELECT * FROM expense_items WHERE name_key = ?').get(key);
  }
  return activate(db, await followMerge(db, item));
}

async function rememberOnItem(db, itemId, { amount, given_to_user_id, given_to_name } = {}) {
  await db.prepare(
    `UPDATE expense_items
        SET usual_amount = ?, last_given_to_user_id = ?, last_given_to_name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(amount == null ? null : amount, given_to_user_id || null, given_to_name || null, itemId);
}

// Who may be picked as "Given to" on an expense.
const GIVEN_TO_ROLES = ['owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'];
const GIVEN_TO_INVALID_MESSAGE = "That person can't be picked here. Tap Given to and pick again.";

// Active staff or rider linked to the shop, or the owner (any shop).
// Throws 400 with the plain copy otherwise.
async function assertGivenTo(db, userId, locationId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, GIVEN_TO_INVALID_MESSAGE);
  const user = await db.prepare('SELECT id, role, is_active FROM users WHERE id = ?').get(id);
  if (!user || !Number(user.is_active) || !GIVEN_TO_ROLES.includes(user.role)) throw httpError(400, GIVEN_TO_INVALID_MESSAGE);
  if (user.role === 'owner') return;
  const link = await db.prepare('SELECT 1 AS ok FROM user_locations WHERE user_id = ? AND location_id = ?').get(id, locationId);
  if (!link) throw httpError(400, GIVEN_TO_INVALID_MESSAGE);
}

// A photo must be a file from POST /api/upload, never an outside link.
function isLocalUploadPath(url) {
  return typeof url === 'string' && /^\/uploads\/[A-Za-z0-9._\-/]+$/.test(url) && !url.includes('..') && !url.includes('//');
}

// The description without a trailing " — note" (when it ends with it).
function stripNote(description, note) {
  const d = String(description || '');
  const n = String(note || '').trim();
  if (!n) return d;
  const suffix = ` — ${n}`;
  if (d.endsWith(suffix)) return d.slice(0, -suffix.length);
  return d === n ? '' : d;
}

// description = item name, plus " — note" when there is a note.
function composeDescription(base, note) {
  const b = String(base || '').trim();
  const n = String(note || '').trim();
  if (!n) return b;
  return b ? `${b} — ${n}` : n;
}

module.exports = {
  nameKey, resolveItem, rememberOnItem, assertGivenTo, isLocalUploadPath, composeDescription, stripNote,
  GIVEN_TO_ROLES, GIVEN_TO_INVALID_MESSAGE,
};

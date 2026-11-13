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
    return activate(db, await followMerge(db, found));
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

module.exports = { nameKey, resolveItem, rememberOnItem };

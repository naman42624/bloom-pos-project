// One shared writer for a salary advance leaving the shop (spec 5.3): the
// counter's Salary advance and the approval of an in-app request both call
// payAdvance, so both write the same advance row and the same salary expense.
// Runs inside the caller's withMoneyTx. Lock order: the caller locks an
// existing salary_advances row first; payAdvance then locks the open register.
const { lockOpenRegister } = require('./register-guard');
const { todayStr } = require('./time');
const { composeDescription } = require('./expense-items');

const ADVANCE_REGISTER_CLOSED_MESSAGE = 'Open the register to give cash — or pick UPI.';
const ADVANCE_METHODS = ['cash', 'upi'];

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.statusCode = status;
  return e;
}

// Returns { advanceId, expenseId, registerId }.
// advanceId: an existing (already locked) request row to approve; else a new row.
async function payAdvance(tx, {
  userId, amount, method, locationId, givenBy, approvedBy, source, advanceId = null, note = null,
  registerClosedMessage = ADVANCE_REGISTER_CLOSED_MESSAGE,
}) {
  if (!ADVANCE_METHODS.includes(method)) throw httpError(400, 'Pick Cash or UPI.');
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!(amt > 0)) throw httpError(400, 'Type an amount above ₹0, like 300.');

  let registerId = null;
  if (method === 'cash') {
    const reg = await lockOpenRegister(tx, locationId);
    if (!reg) throw httpError(400, registerClosedMessage);
    registerId = reg.id;
  }

  const recipient = await tx.prepare('SELECT name FROM users WHERE id = ?').get(userId);
  const cleanNote = String(note || '').trim() || null;
  const day = todayStr(); // shop-local day; never the DB's CURRENT_DATE
  const expense = await tx.prepare(`
    INSERT INTO expenses (location_id, category, amount, description, payment_method, expense_date,
      created_by, employee_id, given_to_user_id, register_id, note)
    VALUES (?, 'salary', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    locationId, amt,
    composeDescription(`Salary advance — ${recipient ? recipient.name : 'employee'}`, cleanNote),
    method, day, givenBy, userId, userId, registerId, cleanNote,
  );
  const expenseId = Number(expense.lastInsertRowid);

  if (registerId) {
    await tx.prepare('UPDATE cash_registers SET expected_cash = expected_cash - ? WHERE id = ?').run(amt, registerId);
  }

  let id = advanceId ? Number(advanceId) : null;
  if (id) {
    await tx.prepare(`
      UPDATE salary_advances SET status = 'approved', approved_by = ?, given_by = ?,
        source = COALESCE(source, ?), payment_method = ?, location_id = ?, expense_id = ?, date = CAST(? AS date)
      WHERE id = ?
    `).run(approvedBy, givenBy, source, method, locationId, expenseId, day, id);
  } else {
    const row = await tx.prepare(`
      INSERT INTO salary_advances (user_id, amount, reason, status, approved_by, given_by, source,
        payment_method, location_id, expense_id, date)
      VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, CAST(? AS date))
    `).run(userId, amt, cleanNote || '', approvedBy, givenBy, source, method, locationId, expenseId, day);
    id = Number(row.lastInsertRowid);
  }

  await tx.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, user_id, action, previous_state, new_state, created_at)
    VALUES ('salary_advance', ?, ?, 'salary_advance_given', NULL, ?, CURRENT_TIMESTAMP)
  `).run(id, givenBy, JSON.stringify({
    user_id: Number(userId), amount: amt, payment_method: method, location_id: Number(locationId),
    given_by: Number(givenBy), approved_by: Number(approvedBy), source, expense_id: expenseId, register_id: registerId,
  }));

  return { advanceId: id, expenseId, registerId };
}

module.exports = { payAdvance, ADVANCE_REGISTER_CLOSED_MESSAGE, ADVANCE_METHODS };

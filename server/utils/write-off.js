// Write-offs: money that was due and is let go (rounding, small change).
// Shared by Add Payment (POST /sales/:id/payments) and dues collection
// (POST /customers/:id/credits) so both apply the same limits.

// The most counter staff or an employee may write off in one go, in rupees.
const STAFF_WRITE_OFF_MAX = 10;
const WRITE_OFF_ANY_AMOUNT_ROLES = ['owner', 'manager'];

// Returns a plain-language error, or '' when the write-off is allowed.
// Amounts in paise.
function writeOffError(role, writeOffPaise, duePaise) {
  if (!(writeOffPaise > 0)) return '';
  if (writeOffPaise > Math.max(0, duePaise)) {
    return duePaise > 0
      ? `You can let go of at most the ₹${(duePaise / 100).toFixed(2)} still due. Lower the write-off.`
      : 'Nothing is due, so there is nothing to write off.';
  }
  if (!WRITE_OFF_ANY_AMOUNT_ROLES.includes(role) && writeOffPaise > STAFF_WRITE_OFF_MAX * 100) {
    return `Only a manager or the owner can write off more than ₹${STAFF_WRITE_OFF_MAX}. Take the money, or ask a manager or the owner.`;
  }
  return '';
}

// A write-off never changes the bill (owner's rule, 2026-11-06): an issued
// tax bill keeps its number, total and GST, and GST stays due on the full
// value. The amount let go is stored as its own line in payments, method
// 'write_off', so everything that works out "paid / still due" from payments
// counts it and the order is settled. It is never money taken: the register,
// payment-method totals and refundable amounts leave it out
// (WRITE_OFF_METHOD). Run inside the caller's transaction.
const WRITE_OFF_METHOD = 'write_off';

async function recordWriteOff(db, saleId, amountRupees, userId, reference = 'Write-off') {
  const amount = Math.round((Number(amountRupees) || 0) * 100) / 100;
  if (!(amount > 0)) return 0;
  await db.prepare('INSERT INTO payments (sale_id, method, amount, reference_number, received_by) VALUES (?, ?, ?, ?, ?)')
    .run(saleId, WRITE_OFF_METHOD, amount, reference, userId);
  return amount;
}

module.exports = { writeOffError, recordWriteOff, WRITE_OFF_METHOD, STAFF_WRITE_OFF_MAX, WRITE_OFF_ANY_AMOUNT_ROLES };

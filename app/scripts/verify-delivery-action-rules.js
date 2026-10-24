const assert = require('assert');
const {
  getDeliveryActions, ACTION_ORDER, isFinalDelivery, formatCodPrefill, deliverNeedsForm,
  pickupWaitingForReady, netPaidPaise, canCancelWholeOrder, formatRupeesFromPaise,
} = require('../src/components/delivery/deliveryActionRules');

const d = (status, extra = {}) => ({
  status,
  delivery_partner_id: 8,
  counter_can_mark_picked_up: true,
  counter_can_mark_delivered: true,
  sale_status: 'ready',
  ...extra,
});
const run = (role, delivery, userId = 1) => getDeliveryActions({ delivery, role, userId });
const eq = (actual, expected, msg) => assert.deepStrictEqual(actual, expected, msg);

eq(run('counter_staff', d('in_transit')), ['deliver', 'verify_load', 'live_location', 'print']);
eq(run('counter_staff', d('in_transit', { counter_can_mark_delivered: false })), ['verify_load', 'live_location', 'print']);
eq(run('counter_staff', d('assigned', { counter_can_mark_picked_up: false })), ['verify_load', 'print']);
eq(run('owner', d('pending')), ['assign', 'verify_load', 'convert_payment', 'print']);
eq(run('owner', d('in_transit')), ['deliver', 'fail', 'verify_load', 'live_location', 'convert_payment', 'print']);
eq(run('delivery_partner', d('picked_up'), 8), ['start', 'deliver', 'fail', 'verify_load', 'print']);
eq(run('delivery_partner', d('picked_up'), 9), ['print']);
eq(run('delivery_partner', d('picked_up'), '8'), ['start', 'deliver', 'fail', 'verify_load', 'print']);
eq(run('employee', d('in_transit')), ['verify_load', 'live_location', 'print']);
eq(run('florist_staff', d('in_transit')), ['live_location', 'print']);
eq(run('counter_staff', d('failed')), ['reattempt', 'cancel', 'print']);
eq(run('manager', d('delivered')), ['print']);
eq(run('customer', d('in_transit')), []);
eq(run('customer', d('pending')), []);
eq(run('owner', null), []);

assert.strictEqual(isFinalDelivery('failed'), true);
assert.strictEqual(isFinalDelivery('in_transit'), false);

const roles = ['owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner', 'customer'];
const statuses = ['pending', 'assigned', 'picked_up', 'in_transit', 'delivered', 'failed', 'cancelled'];
for (const r of roles) for (const s of statuses) {
  const out = run(r, d(s), 8);
  const idx = out.map((k) => ACTION_ORDER.indexOf(k));
  assert.ok(idx.every((i) => i >= 0), `unknown key for ${r}/${s}`);
  assert.deepStrictEqual(idx, [...idx].sort((a, b) => a - b), `order broken for ${r}/${s}`);
}
for (const [amt, got, want] of [[500, 0, '500'], [499.5, 0, '499.5'], [700, 200.25, '499.75'], [500, 500, '0'], [1.14, 0.1, '1.04']]) {
  const out = formatCodPrefill(amt, got);
  assert.strictEqual(out, want, `formatCodPrefill(${amt}, ${got})`);
  // Compared in whole paise, exactly as the server does (codExceedsRemaining).
  assert.ok(Math.round(Number(out) * 100) <= Math.round(amt * 100) - Math.round(got * 100), `prefill exceeds remaining for (${amt}, ${got})`);
}
const prepaid = { cod_amount: 0, cod_collected: 0 };
for (const [role, delivery, want, label] of [
  ['owner', prepaid, false, 'owner, prepaid'],
  ['counter_staff', prepaid, false, 'counter_staff, prepaid'],
  ['delivery_partner', prepaid, true, 'delivery_partner, prepaid'],
  ['owner', { cod_amount: 200, cod_collected: 0 }, true, 'owner, 200 remaining'],
  ['owner', { cod_amount: 1.14, cod_collected: 0.1 }, true, 'owner, 1.14 owed / 0.10 collected'],
  ['owner', { cod_amount: 500, cod_collected: 500 }, false, 'owner, 500 owed / 500 collected'],
  ['manager', { cod_amount: null, cod_collected: null }, false, 'manager, null COD fields'],
]) {
  assert.strictEqual(deliverNeedsForm({ delivery, role }), want, `deliverNeedsForm: ${label}`);
}

// I3: Pick Up Order only once the sale is ready (server /pickup refuses otherwise).
for (const [sale_status, want] of [['confirmed', false], ['preparing', false], ['ready', true], ['completed', true], [undefined, false]]) {
  for (const [role, userId] of [['owner', 1], ['manager', 1], ['counter_staff', 1], ['delivery_partner', 8]]) {
    const out = run(role, d('assigned', { sale_status }), userId);
    assert.strictEqual(out.includes('pickup'), want, `pickup for ${role}, assigned, sale ${sale_status}`);
    assert.strictEqual(pickupWaitingForReady({ delivery: d('assigned', { sale_status }), role, userId }), !want,
      `pickupWaitingForReady for ${role}, sale ${sale_status}`);
  }
}
eq(run('owner', d('assigned', { sale_status: 'confirmed' })), ['verify_load', 'convert_payment', 'print']);
eq(run('owner', d('assigned', { sale_status: 'ready' })), ['pickup', 'verify_load', 'convert_payment', 'print']);
// Not ready AND not allowed anyway: no "unlocks" line (it would never unlock for them).
assert.strictEqual(pickupWaitingForReady({ delivery: d('assigned', { sale_status: 'confirmed', counter_can_mark_picked_up: false }), role: 'counter_staff', userId: 1 }), false);
assert.strictEqual(pickupWaitingForReady({ delivery: d('assigned', { sale_status: 'confirmed' }), role: 'delivery_partner', userId: 9 }), false);
assert.strictEqual(pickupWaitingForReady({ delivery: d('pending', { sale_status: 'confirmed' }), role: 'owner', userId: 1 }), false);
assert.strictEqual(pickupWaitingForReady({ delivery: null, role: 'owner', userId: 1 }), false);

// I2: net paid (payments minus refunds) in whole paise; whole-order cancel only when nothing is held.
for (const [delivery, wantPaise, wantCancel, label] of [
  [{ payments: [] }, 0, true, 'no payments'],
  [{}, 0, true, 'payments missing'],
  [{ payments: [{ amount: '500.00' }] }, 50000, false, '500 paid'],
  [{ payments: [{ amount: 1.14 }, { amount: '0.10' }] }, 124, false, '1.14 + 0.10 paid'],
  [{ payments: [{ amount: '500.00' }], refunded_total: '500.00' }, 0, true, 'fully refunded'],
  [{ payments: [{ amount: 700 }], refunded_total: 200.25 }, 49975, false, 'part refunded'],
  [{ payments: [{ amount: 0.01 }] }, 1, true, '1 paisa (server allows <= 0.01)'],
  [{ payments: [{ amount: 0.02 }] }, 2, false, '2 paise'],
]) {
  assert.strictEqual(netPaidPaise(delivery), wantPaise, `netPaidPaise: ${label}`);
  assert.strictEqual(canCancelWholeOrder(delivery), wantCancel, `canCancelWholeOrder: ${label}`);
}
for (const [paise, want] of [[50000, '₹500'], [49950, '₹499.5'], [124, '₹1.24'], [120000, '₹1,200'], [0, '₹0']]) {
  assert.strictEqual(formatRupeesFromPaise(paise), want, `formatRupeesFromPaise(${paise})`);
}
console.log('OK   delivery action rules');

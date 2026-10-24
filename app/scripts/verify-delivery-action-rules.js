const assert = require('assert');
const { getDeliveryActions, ACTION_ORDER, isFinalDelivery, formatCodPrefill } = require('../src/components/delivery/deliveryActionRules');

const d = (status, extra = {}) => ({
  status,
  delivery_partner_id: 8,
  counter_can_mark_picked_up: true,
  counter_can_mark_delivered: true,
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
for (const [amt, got, want] of [[500, 0, '500'], [499.5, 0, '499.5'], [700, 200.25, '499.75'], [500, 500, '0']]) {
  const out = formatCodPrefill(amt, got);
  assert.strictEqual(out, want, `formatCodPrefill(${amt}, ${got})`);
  assert.ok(Number(out) <= amt - got, `prefill exceeds remaining for (${amt}, ${got})`);
}
console.log('OK   delivery action rules');

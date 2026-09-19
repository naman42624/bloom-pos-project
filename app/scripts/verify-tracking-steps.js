const assert = require('assert');
const { getTrackingSteps } = require('../src/utils/trackingSteps');

// Cancelled — no step bar at all, regardless of order type.
assert.strictEqual(getTrackingSteps('pickup', 'cancelled'), null);
assert.strictEqual(getTrackingSteps('delivery', 'cancelled'), null);

// Pickup ladder: 4 steps.
let r = getTrackingSteps('pickup', 'new');
assert.strictEqual(r.steps.length, 4);
assert.strictEqual(r.current, 0);
assert.deepStrictEqual(r.steps.map((s) => s.label), ['Order Received', 'Preparing', 'Ready for Pickup', 'Picked Up']);
assert.strictEqual(r.steps[0].current, true);
assert.strictEqual(r.steps[0].done, false);

r = getTrackingSteps('pickup', 'ready_for_pickup');
assert.strictEqual(r.current, 2);
assert.deepStrictEqual(r.steps.map((s) => s.done), [true, true, false, false]);
assert.strictEqual(r.steps[2].current, true);

r = getTrackingSteps('pickup', 'picked_up');
assert.strictEqual(r.current, 3);
assert.deepStrictEqual(r.steps.map((s) => s.done), [true, true, true, false]);
assert.strictEqual(r.steps[3].current, true);

// Delivery ladder: 5 steps, including the real intermediate 'ready' stage
// (order ready, no rider assigned yet) as its own distinct step.
r = getTrackingSteps('delivery', 'ready');
assert.strictEqual(r.steps.length, 5);
assert.deepStrictEqual(r.steps.map((s) => s.label), ['Order Received', 'Preparing', 'Ready', 'Out for Delivery', 'Delivered']);
assert.strictEqual(r.current, 2);

r = getTrackingSteps('delivery', 'out_for_delivery');
assert.strictEqual(r.current, 3);

r = getTrackingSteps('delivery', 'delivered');
assert.strictEqual(r.current, 4);
assert.deepStrictEqual(r.steps.map((s) => s.done), [true, true, true, true, false]);
assert.strictEqual(r.steps[4].current, true);

// walk_in / pre_order fulfilled in-shop: 4-step fallback ladder.
r = getTrackingSteps('walk_in', 'preparing');
assert.strictEqual(r.steps.length, 4);
assert.deepStrictEqual(r.steps.map((s) => s.label), ['Order Received', 'Preparing', 'Ready', 'Completed']);
assert.strictEqual(r.current, 1);

// 'completed' can be reached from any order type once fully done, even
// though it is not itself a rung in the pickup/delivery ladders above — it
// must clamp to "everything done", not fall through to index 0 (which
// would wrongly show a finished order as freshly received).
r = getTrackingSteps('pickup', 'completed');
assert.strictEqual(r.current, 3);
assert.deepStrictEqual(r.steps.map((s) => s.done), [true, true, true, false]);
assert.strictEqual(r.steps[3].current, true);

r = getTrackingSteps('delivery', 'completed');
assert.strictEqual(r.current, 4);

console.log('verify-tracking-steps: all assertions passed');

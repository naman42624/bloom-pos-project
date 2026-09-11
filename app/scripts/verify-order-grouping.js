const assert = require('assert');
const { getSingleLocationId, groupOrdersByDay, groupOrdersBySession, sumGrandTotal } = require('../src/utils/orderGrouping');

// getSingleLocationId
assert.strictEqual(getSingleLocationId([]), null);
assert.strictEqual(getSingleLocationId([{ location_id: 1 }, { location_id: 1 }]), 1);
assert.strictEqual(getSingleLocationId([{ location_id: 1 }, { location_id: 2 }]), null);

// groupOrdersByDay — same day-straddling case as verify-shop-date-key
const orders = [
  { id: 1, created_at: '2026-01-16T10:00:00Z' }, // 2026-01-16 IST
  { id: 2, created_at: '2026-01-16T09:00:00Z' }, // 2026-01-16 IST
  { id: 3, created_at: '2026-01-15T10:00:00Z' }, // 2026-01-15 IST
  { id: 4, created_at: 'garbage' },              // unparseable -> null-key group
];
const days = groupOrdersByDay(orders);
assert.strictEqual(days.length, 3);
assert.strictEqual(days[0].dateKey, '2026-01-16');
assert.deepStrictEqual(days[0].orders.map((o) => o.id), [1, 2]);
assert.strictEqual(days[1].dateKey, '2026-01-15');
assert.deepStrictEqual(days[1].orders.map((o) => o.id), [3]);
assert.strictEqual(days[2].dateKey, null);
assert.deepStrictEqual(days[2].orders.map((o) => o.id), [4]);

// groupOrdersBySession
const sessions = [
  { opening_time: '2026-01-16T03:00:00Z', closed_at: '2026-01-16T08:00:00Z' }, // Session 1
  { opening_time: '2026-01-16T09:30:00Z', closed_at: null },                    // Session 2, still open
];
const dayOrders = [
  { id: 10, created_at: '2026-01-16T05:00:00Z' },  // falls in Session 1
  { id: 11, created_at: '2026-01-16T10:00:00Z' },  // falls in Session 2
  { id: 12, created_at: '2026-01-16T08:30:00Z' },  // gap between sessions -> null label
];
const bySession = groupOrdersBySession(dayOrders, sessions);
assert.strictEqual(bySession.length, 3);
assert.ok(bySession[0].sessionLabel.startsWith('Session 1'));
assert.deepStrictEqual(bySession[0].orders.map((o) => o.id), [10]);
assert.ok(bySession[1].sessionLabel.startsWith('Session 2'));
assert.deepStrictEqual(bySession[1].orders.map((o) => o.id), [11]);
assert.strictEqual(bySession[2].sessionLabel, null);
assert.deepStrictEqual(bySession[2].orders.map((o) => o.id), [12]);

// groupOrdersBySession with no sessions at all -> one null-label group, nothing dropped
const noSessions = groupOrdersBySession(dayOrders, []);
assert.strictEqual(noSessions.length, 1);
assert.strictEqual(noSessions[0].sessionLabel, null);
assert.strictEqual(noSessions[0].orders.length, 3);

// sumGrandTotal
assert.strictEqual(sumGrandTotal([]), 0);
assert.strictEqual(sumGrandTotal([{ grand_total: '100.50' }, { grand_total: 50 }, { grand_total: null }]), 150.5);

console.log('verify-order-grouping: all assertions passed');

const assert = require('assert');
const { extractShopDateKey } = require('../src/utils/datetime');

// A UTC timestamp that's late evening in India (UTC+5:30) still falls on
// the same India-local calendar day here — 2026-01-15T23:00:00Z is
// 2026-01-16 04:30 IST, so this is really testing the day AFTER, not a
// same-day edge case. Use one that actually straddles midnight IST:
// 2026-01-15T19:00:00Z = 2026-01-16T00:30 IST -> next day in shop time.
assert.strictEqual(extractShopDateKey('2026-01-15T19:00:00Z'), '2026-01-16');
// A timestamp safely mid-afternoon UTC is also safely mid-evening IST, same day.
assert.strictEqual(extractShopDateKey('2026-01-15T10:00:00Z'), '2026-01-15');
// Plain YYYY-MM-DD input (scheduled_date columns store this) round-trips.
assert.strictEqual(extractShopDateKey('2026-03-01'), '2026-03-01');
assert.strictEqual(extractShopDateKey(null), null);
assert.strictEqual(extractShopDateKey(''), null);
assert.strictEqual(extractShopDateKey('not-a-date'), null);

console.log('verify-shop-date-key: all assertions passed');

const assert = require('assert');
const { extractShopDateKey, formatScheduledLabel } = require('../src/utils/datetime');

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

// formatScheduledLabel (added 2026-09-13, for the WhatsApp tracking-link
// message). A date far in the future avoids the Today/Tomorrow/Yesterday
// branches (formatShopDateLabel's own concern, not re-tested here) so
// these assertions stay deterministic regardless of when the suite runs.
assert.strictEqual(formatScheduledLabel(null, null), '', 'Expected no scheduled_date at all to return empty string, not invent a date');
assert.strictEqual(formatScheduledLabel('', '18:00:00'), '', 'Expected an empty scheduled_date to return empty even with a time present');
assert.strictEqual(formatScheduledLabel('2030-06-15', null), formatScheduledLabel('2030-06-15'), 'Expected a date with no time to just be the date label, called with or without the time arg');
assert.strictEqual(formatScheduledLabel('2030-06-15', '18:00:00'), `${formatScheduledLabel('2030-06-15')}, 6:00 PM`, 'Expected date+time to combine as "<date label>, <12h time>"');
assert.strictEqual(formatScheduledLabel('2030-06-15', '09:05'), `${formatScheduledLabel('2030-06-15')}, 9:05 AM`, 'Expected HH:MM (no seconds) to format the same as HH:MM:SS');

console.log('verify-shop-date-key: all assertions passed');

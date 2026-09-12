const assert = require('assert');
const { normalizePhone, telLink, waLink, buildMessage } = require('../src/utils/contact');

assert.strictEqual(normalizePhone('+91 98765 43210'), '9876543210', 'Expected +91-prefixed with spaces to normalize to bare 10 digits');
assert.strictEqual(normalizePhone('919876543210'), '9876543210', 'Expected a bare 91-prefixed 12-digit number to normalize (not double-prefix later)');
assert.strictEqual(normalizePhone('9876543210'), '9876543210', 'Expected an already-bare number to pass through unchanged');
assert.strictEqual(normalizePhone('98-765-43210'), '9876543210', 'Expected dashes to be stripped');
assert.strictEqual(normalizePhone(''), '', 'Expected empty input to normalize to empty string, not throw');
assert.strictEqual(normalizePhone(null), '', 'Expected null input to normalize to empty string, not throw');

assert.strictEqual(telLink('9876543210'), 'tel:9876543210');

const wa = waLink('9876543210', 'Hi there');
assert.strictEqual(wa, 'https://wa.me/919876543210?text=Hi%20there', `Got: ${wa}`);
// The double-prefix bug this fixes: a number already carrying +91 must not
// end up as wa.me/9191...
const waFromPrefixed = waLink('+919876543210', 'Hi');
assert.strictEqual(waFromPrefixed, 'https://wa.me/919876543210?text=Hi', `Got: ${waFromPrefixed}`);

assert.strictEqual(
  buildMessage('order_ready_pickup', { sale_number: 'INV-123', location_name: 'Main Shop' }),
  'Hi, your order INV-123 is ready for pickup at Main Shop.'
);
// Rewritten 2026-09-13 (staff-ux request) to include the customer's name
// and a scheduled-date label alongside the link, with graceful fallbacks
// for either being absent — three cases, not just the happy path.
assert.strictEqual(
  buildMessage('tracking_link', {
    sale_number: 'INV-123', tracking_url: 'https://example.com/track/abc',
    customer_name: 'Priya', scheduled_label: 'Today, 6:00 PM',
  }),
  'Hi Priya, your order INV-123 is scheduled for Today, 6:00 PM.\nTrack it here: https://example.com/track/abc',
  'Expected the full case (name + schedule) to greet by name and state the schedule'
);
assert.strictEqual(
  buildMessage('tracking_link', { sale_number: 'INV-123', tracking_url: 'https://example.com/track/abc' }),
  'Hi, here\'s your order INV-123.\nTrack it here: https://example.com/track/abc',
  'Expected no customer_name/scheduled_label to fall back to a plain greeting and drop the schedule clause entirely, not print "undefined" or "scheduled for"'
);
assert.strictEqual(
  buildMessage('tracking_link', { sale_number: 'INV-123', tracking_url: 'https://example.com/track/abc', customer_name: 'Priya' }),
  'Hi Priya, here\'s your order INV-123.\nTrack it here: https://example.com/track/abc',
  'Expected a name with no schedule to still greet by name, just skip the schedule clause'
);
assert.strictEqual(
  buildMessage('rider_handoff', { name: 'Vishal', total: 500, count: 3 }),
  'Hi Vishal, please hand over ₹500 from 3 deliveries when you\'re at the shop.'
);
assert.strictEqual(
  buildMessage('unknown_type_xyz', { sale_number: 'INV-123' }),
  'Hi, this is about your order INV-123.',
  'Expected an unrecognized type to fall back to the generic message, not throw'
);

console.log('✅ contact utils: all checks passed');

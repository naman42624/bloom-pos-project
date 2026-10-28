const assert = require('assert');
const { sameAddress } = require('../src/utils/addressMatch');

assert.strictEqual(sameAddress('12, Check Rd ', '12 check rd'), true);
assert.strictEqual(sameAddress('12 Check Rd', '13 Check Rd'), false);
assert.strictEqual(sameAddress('', ''), false, 'empty never matches');
assert.strictEqual(sameAddress(null, '12 Check Rd'), false);
assert.strictEqual(sameAddress('12,,Check\n Rd,', '12 check   rd'), true);
console.log('verify-address-match: all passed');

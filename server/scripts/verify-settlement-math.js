#!/usr/bin/env node
/**
 * Pure-function verification of server/utils/settlement-math.js's
 * codExceedsRemaining — no server/DB needed (same convention as
 * verify-tracking-token.js).
 *
 * Why it exists: POST /deliveries/:id/deliver used raw float subtraction
 * (cod_amount - cod_collected), so e.g. 1.14 - 0.10 = 1.0399999999999998 and
 * collecting the exact ₹1.04 still owed was rejected as "exceeds remaining".
 *
 * Usage: node scripts/verify-settlement-math.js
 */
const assert = require('assert');
const { codExceedsRemaining } = require('../utils/settlement-math');

const cases = [
  [[1.04, 1.14, 0.10], false],
  [[0.84, 1.14, 0.30], false],
  [[1.05, 1.14, 0.10], true],
  [[500, 500, 0], false],
  [[500.01, 500, 0], true],
  [['1.04', '1.14', '0.10'], false],
];
for (const [args, want] of cases) {
  assert.strictEqual(codExceedsRemaining(...args), want, `codExceedsRemaining(${args.join(', ')}) should be ${want}`);
}
console.log('OK   settlement math (codExceedsRemaining)');

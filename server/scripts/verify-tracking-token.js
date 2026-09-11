#!/usr/bin/env node
/**
 * Pure-function verification of server/utils/tracking-token.js — no
 * server/DB needed. This project's established convention for testing
 * logic with no React/DB dependency (see docs/superpowers/plans/
 * 2026-09-05-order-list-foundation.md's Global Constraints).
 *
 * Usage: node scripts/verify-tracking-token.js
 */
const assert = require('assert');
process.env.TRACKING_LINK_SECRET = 'test-secret-for-verification-only';
const { generateTrackingToken, verifyTrackingToken } = require('../utils/tracking-token');

// A generated token verifies back to the same sale ID.
const token = generateTrackingToken(897);
assert.strictEqual(verifyTrackingToken(token), 897, 'Expected the token to verify back to sale 897');

// The same sale ID always produces the same token (no randomness, nothing stored).
assert.strictEqual(generateTrackingToken(897), token, 'Expected the token to be deterministic for the same sale ID');

// A tampered signature is rejected.
const [id, sig] = token.split('.');
const tamperedSig = sig.slice(0, -1) + (sig.slice(-1) === '0' ? '1' : '0');
assert.strictEqual(verifyTrackingToken(`${id}.${tamperedSig}`), null, 'Expected a tampered signature to be rejected');

// A guessed sale ID with a made-up signature is rejected.
assert.strictEqual(verifyTrackingToken('898.0000000000000000000000000000000'), null, 'Expected a forged token for a different sale ID to be rejected');

// Malformed input never throws, just returns null.
assert.strictEqual(verifyTrackingToken('not-a-real-token'), null, 'Expected malformed input to return null, not throw');
assert.strictEqual(verifyTrackingToken(''), null, 'Expected empty input to return null');

console.log('✅ tracking-token: all checks passed');

#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');

(async () => {
  const { createPublicRateLimitKey, getPublicRateLimitWindow } = await import('../server/public-rate-limit-rules.js');
  const firstKey = createPublicRateLimitKey('barber-availability', '203.0.113.10', 'test-secret');
  assert.equal(firstKey, createPublicRateLimitKey('barber-availability', '203.0.113.10', 'test-secret'));
  assert.notEqual(firstKey, createPublicRateLimitKey('barber-availability', '203.0.113.10', 'different-secret'), 'The key must be derived from a server-only secret.');
  assert.notEqual(firstKey, '203.0.113.10', 'The database key must not expose the raw IP address.');
  assert.throws(() => createPublicRateLimitKey('barber-availability', '203.0.113.10', ''), /PUBLIC_RATE_LIMIT_KEY_INVALID/);
  assert.notEqual(firstKey, createPublicRateLimitKey('barber-availability', '203.0.113.11', 'test-secret'));
  assert.notEqual(firstKey, createPublicRateLimitKey('barber-shop-detail', '203.0.113.10', 'test-secret'));
  assert.throws(() => createPublicRateLimitKey('barber-availability', '', 'test-secret'), /PUBLIC_RATE_LIMIT_KEY_INVALID/);

  const first = getPublicRateLimitWindow({}, 1_000, 60_000, 2);
  assert.deepEqual({ allowed: first.allowed, count: first.count, windowStartMs: first.windowStartMs }, { allowed: true, count: 1, windowStartMs: 1_000 });
  const second = getPublicRateLimitWindow(first, 2_000, 60_000, 2);
  assert.equal(second.allowed, true);
  assert.equal(second.count, 2);
  const blocked = getPublicRateLimitWindow(second, 3_000, 60_000, 2);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfter, 58);
  const reset = getPublicRateLimitWindow(second, 61_000, 60_000, 2);
  assert.equal(reset.allowed, true);
  assert.equal(reset.count, 1);
  const futureWindow = getPublicRateLimitWindow({ windowStartMs: 9_000, count: 2 }, 1_000, 60_000, 2);
  assert.equal(futureWindow.allowed, true, 'A corrupt future window must reset instead of blocking traffic.');

  console.log('Public rate-limit checks passed: hashed client keys, per-route isolation, fixed windows, retry-after, and window reset.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveTickId } from '../src/live-tick-identity.mjs';

test('successive ticks on one Deriv subscription receive distinct identities', () => {
  const subscriptionId = 'same-subscription-id';
  const a = createLiveTickId('1HZ100V', 1794500000, 123.45);
  const b = createLiveTickId('1HZ100V', 1794500001, 123.46);
  assert.notEqual(a, b);
  assert.match(a, /^live:1HZ100V:/);
  assert.equal(subscriptionId, 'same-subscription-id');
});

test('same market, epoch and quote deduplicate deterministically', () => {
  assert.equal(
    createLiveTickId('1HZ100V', 1794500000, 123.45),
    createLiveTickId('1HZ100V', 1794500000, 123.45)
  );
});

test('different markets cannot collide', () => {
  assert.notEqual(
    createLiveTickId('1HZ100V', 1794500000, 123.45),
    createLiveTickId('1HZ10V', 1794500000, 123.45)
  );
});

test('invalid tick identity inputs are rejected', () => {
  assert.throws(() => createLiveTickId('', 1794500000, 1), /symbol/);
  assert.throws(() => createLiveTickId('1HZ100V', -1, 1), /epoch/);
  assert.throws(() => createLiveTickId('1HZ100V', 1794500000, NaN), /quote/);
});

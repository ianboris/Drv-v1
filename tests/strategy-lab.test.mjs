import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSymbol, parsePayoutSnapshots, wilsonInterval } from '../src/strategy-lab.mjs';

test('Wilson interval is bounded and contains the observed rate', () => {
  const ci = wilsonInterval(50, 100);
  assert.ok(ci.lower < 0.5 && ci.upper > 0.5);
  assert.ok(ci.lower >= 0 && ci.upper <= 1);
});

test('payout snapshots require valid stake and gross payout', () => {
  const map = parsePayoutSnapshots([
    { symbol: 'R_10', contractType: 'DIFFERS', barrier: 5, stake: 5, askPrice: 5, payout: 5.4, currency: 'USD', capturedAt: '2026-11-12T10:00:00Z' },
    { symbol: 'R_10', contractType: 'DIFFERS', barrier: 5, stake: 5, askPrice: 5, payout: 4.9, currency: 'USD' }
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get('R_10|DIFFERS|5|5').payout, 5.4);
});

test('all four contract families are evaluated and holdout is separate', () => {
  const digits = Array.from({ length: 12000 }, (_, i) => (i * 7 + Math.floor(i / 13)) % 10);
  const result = evaluateSymbol(digits, 'R_10');
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every(row => row.split === 'validation' && row.holdout && row.holdout.split === undefined));
  assert.deepEqual(new Set(result.results.map(row => row.strategy)), new Set(['DIFFERS', 'MATCHES', 'EVEN', 'ODD']));
});

test('no payout snapshots means no monetary EV or profitability eligibility', () => {
  const digits = Array.from({ length: 12000 }, (_, i) => i % 10);
  const result = evaluateSymbol(digits, 'R_10');
  assert.ok(result.results.every(row => row.projectedNetPnl === null && row.projectedEvPerTrade === null && row.eligible === false));
});

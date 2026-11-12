import test from 'node:test';
import assert from 'node:assert/strict';
import { runWalkForwardBacktest } from '../src/backtest.ts';

test('walk-forward evaluator supports all four digit strategies', () => {
  const digits = Array.from({ length: 1200 }, (_, i) => (i * 7 + Math.floor(i / 11)) % 10);
  const baselines = { DIFFERS: 0.9, MATCHES: 0.1, EVEN: 0.5, ODD: 0.5 };
  for (const [strategy, baseline] of Object.entries(baselines)) {
    const result = runWalkForwardBacktest(digits, strategy, 100);
    assert.equal(result.strategy, strategy);
    assert.equal(result.theoreticalBaseline, baseline);
    assert.equal(result.testTrades, 360);
    assert.equal(result.wins + result.losses, result.testTrades);
    assert.equal(result.winRate, result.wins / result.testTrades);
  }
});

test('walk-forward parity outcomes are scored against the next digit only', () => {
  const digits = Array.from({ length: 1000 }, (_, i) => i % 10);
  const even = runWalkForwardBacktest(digits, 'EVEN', 50);
  const odd = runWalkForwardBacktest(digits, 'ODD', 50);
  assert.equal(even.winRate, 0.5);
  assert.equal(odd.winRate, 0.5);
  assert.equal(even.wins, odd.losses);
  assert.equal(even.losses, odd.wins);
});

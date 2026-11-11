import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAdvancedModel, forecastDigitProbabilities, logLoss } from '../src/advanced-model.mjs';

test('all forecast distributions are valid probability vectors', () => {
  const history = Array.from({ length: 200 }, (_, i) => (i * 7 + Math.floor(i / 9)) % 10);
  for (const model of ['rolling_dirichlet', 'exponential_decay', 'markov_shrinkage']) {
    const p = forecastDigitProbabilities(history, 100, model);
    assert.equal(p.length, 10);
    assert.ok(p.every(x => x > 0 && x < 1));
    assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-10);
  }
});

test('Markov model responds to a repeatable one-step transition', () => {
  const history = [];
  for (let i = 0; i < 100; i++) history.push(1, 7);
  history.push(1);
  const p = forecastDigitProbabilities(history, history.length, 'markov_shrinkage');
  assert.ok(p[7] > p[1]);
  assert.ok(logLoss(p, 7) < logLoss(p, 2));
});

test('advanced model selects forecast model on validation and evaluates holdout separately', () => {
  const digits = Array.from({ length: 12000 }, (_, i) => (i * 7 + Math.floor(i / 13)) % 10);
  const result = evaluateAdvancedModel(digits, 'R_10', null, { currency: 'USD', stakes: [5], windows: [50] });
  assert.equal(result.results.length, 1);
  const row = result.results[0];
  assert.ok(['rolling_dirichlet', 'exponential_decay', 'markov_shrinkage'].includes(row.selectedModel));
  assert.equal(row.validation.trades, 0);
  assert.equal(row.holdout.trades, 0);
  assert.equal(row.preliminaryScreenPass, false);
});

test('session stop halts after two full $5 losses at the $10 limit', () => {
  const digits = Array(12000).fill(0);
  for (let i = 7200; i < digits.length; i++) digits[i] = 1;
  const payouts = new Map([[
    'R_10|MATCHES|0|5',
    { symbol: 'R_10', contractType: 'MATCHES', barrier: '0', stake: 5, askPrice: 5, payout: 100, currency: 'USD', capturedAtMs: Date.now() }
  ]]);
  const result = evaluateAdvancedModel(digits, 'R_10', payouts, { currency: 'USD', stakes: [5], windows: [50] });
  const row = result.results[0];
  assert.equal(row.validation.trades, 2);
  assert.equal(row.validation.losses, 2);
  assert.equal(row.validation.scenarioNetPnl, -10);
  assert.equal(row.validation.sessionStopHit, true);
  assert.equal(row.validation.tradesUntilStop, 2);
});

test('payout-aware decision does not trade when no captured quote is available', () => {
  const digits = Array.from({ length: 12000 }, (_, i) => i % 10);
  const result = evaluateAdvancedModel(digits, 'R_10', new Map(), { currency: 'USD', stakes: [5], windows: [50] });
  assert.equal(result.results[0].validation.trades, 0);
  assert.equal(result.results[0].validation.scenarioNetPnl, null);
});

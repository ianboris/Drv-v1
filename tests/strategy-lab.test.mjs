import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSignals, evaluateSymbol, loadArchives, parsePayoutSnapshots, wilsonInterval } from '../src/strategy-lab.mjs';
import { gzipSync } from 'node:zlib';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  const native = parsePayoutSnapshots({ snapshots: [{ symbol: 'R_10', contract_type: 'DIGITDIFF', barrier: 3, amount: 2, ask_price: 2, payout: 2.2, currency: 'USD' }] });
  assert.equal(native.get('R_10|DIFFERS|3|2').payout, 2.2);
});

test('rolling digit signals use only the preceding window and parity filter', () => {
  const repeated = Array(20).fill(3);
  assert.equal(buildSignals(repeated, 10, 'DIFFERS')[10].barrier, 0);
  assert.equal(buildSignals(repeated, 10, 'MATCHES')[10].barrier, 3);
  const evenOnly = [0, 2, 4, 6, 8, 0, 2, 4, 6, 8, 1];
  assert.ok(buildSignals(evenOnly, 10, 'EVEN')[10]);
  assert.equal(buildSignals(evenOnly, 10, 'ODD')[10], null);
});

test('all four contract families are evaluated and holdout is separate', () => {
  const digits = Array.from({ length: 12000 }, (_, i) => (i * 7 + Math.floor(i / 13)) % 10);
  const result = evaluateSymbol(digits, 'R_10');
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every(row => row.split === 'validation' && row.holdout && row.holdout.split === undefined));
  assert.deepEqual(new Set(result.results.map(row => row.strategy)), new Set(['DIFFERS', 'MATCHES', 'EVEN', 'ODD']));
});

test('no payout snapshots means no monetary scenario P/L or profitability screen', () => {
  const digits = Array.from({ length: 12000 }, (_, i) => i % 10);
  const result = evaluateSymbol(digits, 'R_10');
  assert.ok(result.results.every(row => row.scenarioNetPnl === null && row.scenarioNetPerTrade === null && row.preliminaryScreenPass === false));
});

test('compressed daily archive loader parses JSONL and removes duplicate tick IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lotus-archive-'));
  try {
    const rows = [
      { symbol: 'R_10', epoch: 100, digit: 4, tick_uid: 'a' },
      { symbol: 'R_10', epoch: 100, digit: 7, tick_uid: 'b' },
      { symbol: 'R_10', epoch: 100, digit: 4, tick_uid: 'a' },
      { symbol: 'R_10', epoch: 101, digit: 2, tick_uid: 'c' }
    ];
    const jsonl = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    await writeFile(join(directory, 'ticks-2026-11-12.jsonl.gz'), gzipSync(jsonl));
    const archives = await loadArchives(directory);
    assert.deepEqual(archives.get('R_10'), [4, 7, 2]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

#!/usr/bin/env node
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadArchives, parsePayoutSnapshots, evaluateSymbol } from '../src/strategy-lab.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const archiveDir = resolve(arg('--archive-dir', '/var/lib/lotus/research'));
const payoutPath = arg('--payouts');
const outPath = resolve(arg('--out', './lotus-strategy-report.json'));
const archives = await loadArchives(archiveDir);
const payouts = payoutPath ? parsePayoutSnapshots(await readFile(resolve(payoutPath), 'utf8')) : null;
const report = {
  generatedAt: new Date().toISOString(),
  benchmark: { stakeUsd: 5, sessionStopLossUsd: 10, stakes: [1, 2, 3, 5], windows: [50, 100, 250, 500, 1000, 2500, 5000] },
  warning: 'This report cannot identify a profitable strategy without representative, correctly timestamped tick archives and matching current proposal snapshots. Proposal-based P/L is a constant-payout scenario, not historical realised P/L. Verify account currency before treating USD benchmark amounts as account amounts.',
  markets: [...archives.entries()].map(([symbol, digits]) => evaluateSymbol(digits, symbol, payouts)),
};
await mkdir(resolve(outPath, '..'), { recursive: true });
await writeFile(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  output: outPath,
  markets: report.markets.map(m => ({ symbol: m.symbol, ticks: m.ticks, configsTested: m.results.length, top: m.results.slice(0, 3).map(r => ({ strategy: r.strategy, stake: r.stake, window: r.windowSize, validationTrades: r.trades, validationWinRate: r.winRate, holdoutWinRate: r.holdout.winRate, scenarioNetPerTrade: r.scenarioNetPerTrade, preliminaryScreenPass: r.preliminaryScreenPass })) }))
}, null, 2));

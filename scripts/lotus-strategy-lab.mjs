#!/usr/bin/env node
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadArchives, parsePayoutSnapshots, evaluateSymbol } from '../src/strategy-lab.mjs';
import { evaluateAdvancedModel } from '../src/advanced-model.mjs';

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
  benchmark: { stakeBenchmark: 5, sessionStopLoss: 10, amountUnit: 'account currency', stakes: [1, 2, 3, 5], windows: [50, 100, 250, 500, 1000, 2500, 5000] },
  warning: 'This report cannot identify a profitable strategy without representative, correctly timestamped tick archives and matching current proposal snapshots. Proposal-based P/L is a constant-payout scenario, not historical realised P/L. Verify account currency before treating USD benchmark amounts as account amounts.',
  markets: [...archives.entries()].map(([symbol, digits]) => ({
    baselineGrid: evaluateSymbol(digits, symbol, payouts),
    advancedModel: evaluateAdvancedModel(digits, symbol, payouts, { currency: 'USD' }),
  })),
};
await mkdir(resolve(outPath, '..'), { recursive: true });
await writeFile(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  output: outPath,
  markets: report.markets.map(m => ({ symbol: m.baselineGrid.symbol, ticks: m.baselineGrid.ticks, baselineConfigsTested: m.baselineGrid.results.length, advancedConfigsTested: m.advancedModel.results.length, advancedTop: m.advancedModel.results.slice(0, 3).map(r => ({ model: r.selectedModel, stake: r.stake, window: r.windowSize, validationTrades: r.validation.trades, validationPnl: r.validation.scenarioNetPnl, holdoutTrades: r.holdout.trades, holdoutPnl: r.holdout.scenarioNetPnl, preliminaryScreenPass: r.preliminaryScreenPass })) }))
}, null, 2));

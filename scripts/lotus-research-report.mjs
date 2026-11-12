#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadResearchTicks, analyzeSymbolTicks } from '../src/research-analytics.mjs';
import { evaluateAdvancedModel } from '../src/advanced-model.mjs';
import { parsePayoutSnapshots } from '../src/strategy-lab.mjs';

function arg(name, fallback=null) { const i=process.argv.indexOf(name); return i>=0 ? process.argv[i+1] : fallback; }
const archiveDir=resolve(arg('--archive-dir','/var/lib/lotus/research'));
const out=resolve(arg('--out','./lotus-research-report.json'));
const payoutFile=arg('--payouts');
const currency=String(arg('--currency','USD')).toUpperCase();
const stake=Number(arg('--stake','5'));
if (!(stake>0 && Number.isFinite(stake))) throw new Error('Pass a positive --stake value.');
const snapshots=payoutFile ? JSON.parse(await readFile(resolve(payoutFile),'utf8')) : null;
const archives=await loadResearchTicks(archiveDir);
const markets=[...archives.entries()].map(([symbol,rows])=>({
  ...analyzeSymbolTicks(rows),
  advancedForecastLab: evaluateAdvancedModel(rows.map(r=>r.digit),symbol,
    snapshots ? parsePayoutSnapshots(snapshots) : null,{currency, stakes:[stake]})
}));
const report={
  generatedAt:new Date().toISOString(), currency,
  benchmark:{stake, sessionStopLoss:10, currency, rollingWindows:[100,500,1000,5000]},
  markets,
  executionGate:{
    liveExecutionEnabled:false,
    requirements:['Fresh symbol/stake/currency-matched proposal quotes','Positive payout-adjusted expected value after conservative probability calibration',
      'Validation and untouched holdout both positive with adequate trade count','No look-ahead or reused holdout for model selection',
      'Demo-only execution and hard loss/contract limits'],
    note:'A positive model estimate is not a profitability guarantee. Historical P/L cannot be reconstructed without timestamp-aligned historical proposal prices.'
  }
};
await mkdir(resolve(out,'..'),{recursive:true});
await writeFile(out,JSON.stringify(report,null,2));
console.log(JSON.stringify({output:out,markets:markets.map(m=>({
  symbol:m.symbol,totalTicks:m.totalTicks,liveTicks:m.liveTicks,backfillTicks:m.backfillTicks,
  windows:m.windows.map(w=>w.size),validationWindows:Object.keys(m.validation),holdoutWindows:Object.keys(m.holdout),
  baselineTop:m.contracts.slice().sort((a,b)=>(b.winRate??0)-(a.winRate??0)).slice(0,3).map(x=>({contract:x.contract,targetDigit:x.targetDigit,winRate:x.winRate,ciLower:x.confidence95.lower})),
  advancedCandidates:m.advancedForecastLab.results.length
}))},null,2));

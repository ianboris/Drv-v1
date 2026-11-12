import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSymbolTicks, evaluateLivePayouts, loadResearchTicks, wilson95 } from '../src/research-analytics.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

test('Wilson interval is bounded and includes observed proportion',()=>{
  const ci=wilson95(50,100);
  assert.ok(ci.lower<.5 && ci.upper>.5);
});
test('rolling research reports all ten matches/differs barriers and parity',()=>{
  const rows=Array.from({length:12000},(_,i)=>({symbol:'1HZ10V',epoch:i,digit:i%10,source:i<10000?'backfill':'live'}));
  const r=analyzeSymbolTicks(rows);
  assert.equal(r.totalTicks,12000);
  assert.equal(r.liveTicks,2000);
  assert.equal(r.contracts.length,22);
  assert.equal(r.contracts.find(x=>x.contract==='MATCHES'&&x.targetDigit===3).winRate,.1);
  assert.equal(r.contracts.find(x=>x.contract==='DIFFERS'&&x.targetDigit===3).winRate,.9);
  assert.equal(r.windows.find(x=>x.size===5000).size,5000);
  assert.ok(r.holdout[100].observations>0);
});
test('live payout evaluator rejects stale and wrong-currency quotes',()=>{
  const now=Date.now(), p=Array(10).fill(.1);
  const q=[
    {symbol:'X',contractType:'DIFFERS',barrier:0,stake:5,askPrice:5,payout:5.5,currency:'USD',capturedAt:new Date(now).toISOString()},
    {symbol:'X',contractType:'MATCHES',barrier:1,stake:5,askPrice:5,payout:5.5,currency:'EUR',capturedAt:new Date(now).toISOString()},
    {symbol:'X',contractType:'EVEN',stake:5,askPrice:5,payout:5.5,currency:'USD',capturedAt:new Date(now-60000).toISOString()}
  ];
  const result=evaluateLivePayouts(p,'X',q,5,'USD',now);
  assert.equal(result.length,1);
  assert.ok(Math.abs(result[0].expectedNet - (.9*5.5-5))<1e-9);
});

test('compressed archives load, deduplicate overlap, and prefer live provenance',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lotus-research-'));
  try {
    const rows=[
      {symbol:'1HZ10V',epoch:1,digit:4,tick_uid:'same',source:'backfill'},
      {symbol:'1HZ10V',epoch:1,digit:4,tick_uid:'same',source:'live'},
      {symbol:'1HZ10V',epoch:2,digit:5,tick_uid:'next',source:'live'}
    ];
    await writeFile(join(dir,'batch-v1-'+ 'a'.repeat(64)+'.jsonl.gz'),
      gzipSync(rows.map(x=>JSON.stringify(x)).join('\\n')+'\\n'));
    const loaded=await loadResearchTicks(dir);
    assert.equal(loaded.get('1HZ10V').length,2);
    assert.equal(loaded.get('1HZ10V')[0].source,'live');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

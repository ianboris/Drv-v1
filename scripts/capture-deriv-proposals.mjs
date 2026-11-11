#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadArchives } from '../src/strategy-lab.mjs';

const WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const STAKES = [1, 2, 3, 5];
const DIGIT_TYPES = [{ strategy: 'DIFFERS', contract_type: 'DIGITDIFF' }, { strategy: 'MATCHES', contract_type: 'DIGITMATCH' }];
const PARITY_TYPES = [{ strategy: 'EVEN', contract_type: 'DIGITEVEN' }, { strategy: 'ODD', contract_type: 'DIGITODD' }];

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const currency = String(arg('--currency', '')).toUpperCase();
if (!/^[A-Z0-9]{2,20}$/.test(currency)) {
  throw new Error('Pass --currency with the account-holder currency shown by Deriv (for example USD). Do not guess this value.');
}
const archiveDir = resolve(arg('--archive-dir', '/var/lib/lotus/research'));
const symbolsArg = arg('--symbols');
const outPath = resolve(arg('--out', './proposal-snapshots.json'));
const archives = await loadArchives(archiveDir);
const symbols = symbolsArg ? symbolsArg.split(',').map(s => s.trim()).filter(Boolean) : [...archives.keys()];
if (!symbols.length) throw new Error('No archived markets found. Pass --symbols or start the research collector first.');

const ws = new WebSocket(WS_URL);
let nextReqId = 100;
const pending = new Map();
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

await new Promise((resolveOpen, rejectOpen) => {
  const timer = setTimeout(() => rejectOpen(new Error('Deriv public WebSocket open timed out.')), 15000);
  ws.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
  ws.addEventListener('error', () => { clearTimeout(timer); rejectOpen(new Error('Deriv public WebSocket connection failed.')); }, { once: true });
});
ws.addEventListener('message', event => {
  let msg;
  try { msg = JSON.parse(String(event.data)); } catch { return; }
  const id = Number(msg.req_id);
  const waiter = pending.get(id);
  if (!waiter) return;
  pending.delete(id);
  clearTimeout(waiter.timer);
  if (msg.error) waiter.reject(new Error(msg.error.message || 'Deriv proposal request failed.'));
  else if (msg.proposal) waiter.resolve(msg.proposal);
  else waiter.reject(new Error('Deriv response did not include a proposal object.'));
});
ws.addEventListener('close', () => {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error('Deriv public WebSocket closed during proposal capture.'));
  }
  pending.clear();
});

function request(payload) {
  const req_id = nextReqId++;
  return new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => {
      pending.delete(req_id);
      rejectRequest(new Error('Proposal request timed out.'));
    }, 12000);
    pending.set(req_id, { resolve: resolveRequest, reject: rejectRequest, timer });
    ws.send(JSON.stringify({ ...payload, req_id }));
  });
}

const snapshots = [], errors = [];
try {
  for (const symbol of symbols) {
    for (const stake of STAKES) {
      const requests = [
        ...DIGIT_TYPES.flatMap(contract => Array.from({ length: 10 }, (_, barrier) => ({ ...contract, barrier: String(barrier) }))),
        ...PARITY_TYPES.map(contract => ({ ...contract, barrier: null })),
      ];
      for (const contract of requests) {
        try {
          const proposal = await request({
            proposal: 1,
            amount: stake,
            basis: 'stake',
            contract_type: contract.contract_type,
            currency,
            duration: 1,
            duration_unit: 't',
            underlying_symbol: symbol,
            barrier: contract.barrier ?? undefined,
          });
          const askPrice = Number(proposal.ask_price);
          const payout = Number(proposal.payout);
          if (!Number.isFinite(askPrice) || !Number.isFinite(payout)) throw new Error('Proposal omitted a numeric ask_price or payout.');
          snapshots.push({
            symbol,
            contractType: contract.strategy,
            contract_type: contract.contract_type,
            barrier: contract.barrier,
            stake,
            amount: stake,
            askPrice,
            ask_price: askPrice,
            payout,
            currency,
            proposalId: proposal.id ? String(proposal.id) : null,
            capturedAt: new Date().toISOString(),
          });
        } catch (error) {
          errors.push({ symbol, strategy: contract.strategy, contract_type: contract.contract_type, barrier: contract.barrier, stake, error: String(error.message || error) });
        }
        await sleep(120);
      }
    }
  }
} finally {
  try { ws.close(); } catch {}
}
const result = { capturedAt: new Date().toISOString(), currency, symbols, snapshots, errors };
await writeFile(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  output: outPath,
  currency,
  markets: symbols.length,
  requested: symbols.length * STAKES.length * 22,
  captured: snapshots.length,
  rejectedOrFailed: errors.length,
  failures: errors.slice(0, 20),
}, null, 2));

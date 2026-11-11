# Lotus stake and window optimisation

This research-only CLI evaluates chronological parameter combinations from the compressed OCI tick archive.

## Test grid

- Contract families: DIFFERS, MATCHES, EVEN, ODD
- Stakes: 1, 2, 3, 5 (the user's $5 benchmark)
- Rolling windows: 50, 100, 250, 500, 1,000, 2,500, 5,000 ticks
- Session stop-loss benchmark: 10 in the account currency
- Data split: first 60% warm-up/training, next 20% validation, final 20% untouched holdout

The validation split ranks configurations. The final holdout is reported separately and is not used for ranking. Every prediction uses only the preceding window. Differs selects the least frequent digit; Matches selects the most frequent digit. Ties use the most recently observed tied digit. Even/Odd trades are filtered: a parity contract is entered only when that parity is at least 55% of the preceding window. This threshold is fixed before the evaluation.

## Run

```bash
npm run test:strategy-lab
node scripts/lotus-strategy-lab.mjs --archive-dir /var/lib/lotus/research --out /var/lib/lotus/research/strategy-report.json
```

Capture current proposal quotes from Deriv's unauthenticated public proposal endpoint (read-only; it does not buy contracts). The currency is mandatory and must match the actual Deriv account currency. This captures all 0–9 barriers for Differs/Matches and both parity contracts at each tested stake for every archived market:\n\n```bash\nnpm run capture:proposals -- --currency USD --archive-dir /var/lib/lotus/research --out ./proposal-snapshots.json\n```\n\nReplace `USD` with the exact account currency; do not guess. The collector writes both successful snapshots and failed/rejected proposal details.\n\nTo include proposal-based payout scenarios, supply that capture file or a JSON array with one or more records:

```json
[
  {
    "symbol": "R_10",
    "contract_type": "DIGITDIFF",
    "barrier": 5,
    "amount": 5,
    "ask_price": 5,
    "payout": 5.42,
    "currency": "USD",
    "capturedAt": "2026-11-12T12:00:00Z"
  },
  {
    "symbol": "R_10",
    "contractType": "EVEN",
    "barrier": null,
    "stake": 5,
    "askPrice": 5,
    "payout": 9.55,
    "currency": "USD",
    "capturedAt": "2026-11-12T12:00:00Z"
  }
]
```

```bash
node scripts/lotus-strategy-lab.mjs --archive-dir /var/lib/lotus/research --payouts ./proposal-snapshots.json --out ./lotus-strategy-report.json
```

The payout field is the **gross amount returned on a win, including stake**. The loader accepts Deriv native contract codes (`DIGITDIFF`, `DIGITMATCH`, `DIGITEVEN`, `DIGITODD`) and the internal aliases. It accepts `ask_price`/`amount` or `askPrice`/`stake`. Snapshots must be real Deriv proposal responses for the exact market, contract type, barrier, stake and account currency. The report applies that captured quote as a constant scenario to validation/holdout outcomes; it is not a reconstruction of historical payouts or realised P/L. Missing exact quote coverage prevents monetary scenario reporting for that configuration.

## Interpretation and safety

- Without matching proposal snapshots, the report is hit-rate research only. Monetary scenario P/L and preliminary screening remain unavailable.
- With snapshots, a configuration receives a preliminary screen flag only when its validation Wilson lower-bound diagnostic exceeds the most conservative break-even threshold across the matched quotes and its replayed scenario P/L is positive. Wilson intervals assume independent Bernoulli outcomes; rolling-window trades can be serially dependent, so this flag is not a valid significance test or proof of a durable edge. A block-bootstrap and multiple-testing correction are still required before treating any candidate as statistically supported.
- Use holdout once after choosing a candidate. Do not tune against holdout results.
- The $10 stop-loss is simulated as a single continuous session in each scored split. It does not reset on an arbitrary UTC day.
- $5 is not guaranteed to be accepted. Deriv contract minimums, maximums, account balance and account currency must be checked against the live proposal/account response.
- No real-money orders are placed. This tool reads local archives and proposal snapshots only.
- Archives may contain duplicates or gaps because the current collector does not yet have crash-safe archive manifests or complete gap repair. A result is only as reliable as its input archive.

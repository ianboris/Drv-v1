# Deriv Digit AI V1

Mobile-first Vite + React + TypeScript research console.

## Structure

- `index.html`
- `package.json`
- `tsconfig.json`
- `vite.config.ts`
- `manifest.webmanifest`
- `src/main.tsx`
- `src/style.css`
- `db/migrations/`

## Local development

```sh
npm install
npm run dev
```

## Production build

```sh
npm run build
npm run preview
```

The production build is written to `dist/`.

## Deployment

The app is a static Vite site. Configure the hosting provider with:

- Build command: `npm run build`
- Publish directory: `dist`

## Database migrations

Apply migrations `001_ddpe_core.sql`, `002_tick_and_choice_identity.sql`, and `003_market_scanner_currency.sql` in that order. In Neon SQL Editor, use the normal **Run** action on each complete file. Do not use **Explain** or **Explain Analyze**, and do not prepend `EXPLAIN`: these files change the schema using `ALTER TABLE`, `CREATE TABLE`, and `CREATE INDEX`, which are not query plans.

There is intentionally no migration 004. The earlier proposed conversion of `pip_size` to `NUMERIC` was based on an incorrect interpretation. Deriv documents `pip_size` in ticks-history responses as the number of decimal places for displaying amounts. The existing `SMALLINT` representation in migration 001 is appropriate; the frontend must treat it as a decimal-place count.

See [db/migrations/README.md](db/migrations/README.md) for execution and verification guidance.

## Scope and limitations

This repository currently contains a public-market-data research interface only. It does not authenticate a Deriv account, submit proposals, buy contracts, or execute trades. Displayed digit-frequency anomalies are descriptive statistics, not validated predictive signals. Do not use them as evidence of positive expected value without chronological out-of-sample testing and payout-aware validation.

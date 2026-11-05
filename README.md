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

Apply these files in the Neon SQL Editor in order: `001_ddpe_core.sql`, `002_tick_and_choice_identity.sql`, then `003_market_scanner_currency.sql`. Run them as ordinary SQL scripts. Do **not** use Explain, Explain Analyze, or a query-plan tool on migrations: PostgreSQL `EXPLAIN` accepts query/DML statements, not schema-changing `ALTER TABLE` commands. Do not prepend `EXPLAIN` to migration SQL.

## Market scanner

The scanner monitors every returned `DIGITDIFF`-eligible market, records one-tick paper outcomes, requests live one-tick proposals in the configured Deriv account currency, and ranks markets by conservative estimated expected value. It requires at least 100 settled paper outcomes per market and uses the 95% Wilson lower confidence bound for the win probability. It does not execute contracts. Paper outcomes are not actual contract profitability; use forward testing and actual settlement records before enabling any execution.

## Scope and limitations

This repository currently contains a public-market-data research interface only. It does not authenticate a Deriv account, submit proposals, buy contracts, or execute trades. Displayed digit-frequency anomalies are descriptive statistics, not validated predictive signals. Do not use them as evidence of positive expected value without chronological out-of-sample testing and payout-aware validation.

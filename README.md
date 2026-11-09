# DDPE Vercel-only application

Mobile-first Vite + React + TypeScript research console with a Vercel Node.js API and Neon PostgreSQL persistence.

## Runtime and deployment

This repository deploys exclusively to Vercel.

- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`
- Node.js: 20 or later
- API entry point: `api/[...path].mjs` (Vercel Web Function)
- Backend implementation: `server/api-handler.mjs`
- Database: Neon PostgreSQL via `@neondatabase/serverless`

## Local development

```sh
npm install
npm test
npm run build
npm run dev
```

## Vercel environment variables

Configure these in Vercel Project Settings → Environment Variables for Preview and Production:

- `DATABASE_URL`: Neon pooled PostgreSQL connection string (server-side only).
- `DDPE_LOGIN_PASSWORD`: new private app password, at least 16 characters.
- `DDPE_SESSION_SECRET`: random secret, at least 32 characters.

Never put these values in frontend code, commit them to Git, or share them in public issues. If a credential was exposed, rotate it.

## Neon migrations

Run these SQL files in the Neon SQL Editor in order:

1. `db/migrations/001_ddpe_core.sql`
2. `db/migrations/002_tick_and_choice_identity.sql`
3. `db/migrations/003_market_scanner_currency.sql`

Execute them as ordinary SQL scripts. Do not use Explain or Explain Analyze on schema-changing migrations.

After configuring environment variables and applying migrations, deploy to Vercel and check `/api/health`. The endpoint must report database connectivity, schema readiness, and app configuration before login will work.

## API routes

- `GET /api/health`: reports safe configuration, database connection, and schema checks.
- `POST /api/login`: accepts the private app password and issues an HttpOnly session cookie.
- `POST /api/logout`: clears the session cookie.
- `GET /api/session`: checks the current session.
- `GET /api/settings` and `PUT /api/settings`: read and save settings.
- `POST /api/ticks`: persist validated tick batches.
- `GET /api/choices` and `POST /api/choices`: read and persist settled paper predictions.

## Research and execution boundaries

This application is a market-data research and paper-prediction console. It does not authenticate a Deriv account, buy contracts, monitor real open contracts, or enforce a daily loss limit against actual contract settlements. The displayed risk settings are not a live trading risk control. Keep live execution disabled.

The browser collector only runs while the dashboard is open. Vercel Functions are request-driven and are not a permanent WebSocket collection worker. The app does not provide continuous collection when the browser is closed.

The scanner's observed paper win rates and expected-value estimates are not proof of a durable trading edge. Validate chronologically out of sample and against actual proposal and settlement data before considering execution.

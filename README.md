# DDPE Vercel-only application

Mobile-first Vite + React + TypeScript trading research console with a Vercel Node.js API and Neon PostgreSQL persistence. Deriv contract execution is restricted to an explicitly selected demo account; live-account execution is disabled.

## Runtime and deployment

This repository deploys exclusively to Vercel.

- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`
- Node.js: 22.x (matches `package.json`)
- API entry point: `api/index.mjs` (Vercel Web Standard Function)
- API routing: `vercel.json` rewrites `/api/*` requests to the shared entry point
- Backend implementation: `server/api-handler.mjs`
- Database: Neon PostgreSQL via `@neondatabase/serverless`

## Local development

```sh
npm install
npm run test:api
npm run build
npm run dev
```

## Vercel environment variables

Configure these in Vercel Project Settings → Environment Variables for Preview and Production:

- `DATABASE_URL`: Neon pooled PostgreSQL connection string (server-side only).
- `DDPE_LOGIN_PASSWORD`: new private app password, at least 16 characters.
- `DDPE_SESSION_SECRET`: random secret, at least 32 characters.
- `DERIV_OAUTH_CLIENT_ID`: client ID from the registered Deriv OAuth application.
- `DERIV_OAUTH_REDIRECT_URI`: exact callback URL registered with Deriv, normally `https://lotusthebot.vercel.app/api/deriv/oauth/callback` for the production domain.
- `DERIV_TOKEN_ENCRYPTION_KEY`: base64url-encoded random 32-byte key used to encrypt Deriv access tokens at rest. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.

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
- `POST /api/deriv/oauth/start` and `GET /api/deriv/oauth/callback`: connect Deriv through OAuth.
- `GET /api/deriv/demo/status` and `GET /api/deriv/demo/accounts`: inspect the authorized connection and list verified demo accounts.
- `POST /api/deriv/demo/otp`: obtain a short-lived WebSocket URL for the selected demo account.
- `POST /api/deriv/demo/disconnect`: remove the stored Deriv connection.

## Research and execution boundaries

- Deriv OAuth tokens are encrypted server-side. The browser receives a short-lived demo WebSocket URL only after the backend verifies the selected account is a demo account.
- The Engine supports one-tick `DIGITDIFF` and `DIGITMATCH` purchases on the selected demo account. The real-account WebSocket endpoint and live execution controls remain disabled.
- Demo execution, market-data collection, and settlement observation run in the browser. Closing the dashboard stops the collector and the automatic demo bot; this is not a 24/7 worker.
- Demo trade history and daily demo P/L are currently held in browser storage. Daily loss/profit stops are browser-enforced safeguards, not server-enforced account-wide risk controls. They must not be treated as hard guarantees across browsers, devices, or sessions.
- The research scanner's paper hit rates and quote-based expected-value estimates are not proof of a durable trading edge. Validate chronologically out of sample and reconcile demo contract settlements before considering any live-trading design.

Vercel Functions are request-driven. They provide the authenticated API and OAuth/token operations, not a permanently running WebSocket collector or trading worker.

# DDPE secure backend setup

This branch adds the first server-side connection layer. It does not enable Deriv trading.

## Vercel deployment (recommended)

The repository includes `api/[...path].mjs`, which exposes the shared backend handler as a Vercel Web Function. Vercel's Node.js runtime supports standard Web Request/Response handlers. The Vite frontend builds to `dist`.

1. Import `ianboris/Drv-v1` into Vercel.
2. Select the `deploy/vercel-neon-adapter` branch for a preview deployment, or wait until the changes are reviewed and merged before using the production branch.
3. Keep the build command as `npm run build` and output directory as `dist` (also specified in `vercel.json`).
4. In Vercel Project Settings -> Environment Variables, add the three variables below for Preview first, then Production only after verification.
5. Apply the Neon migration in the Neon SQL Editor.
6. Deploy and test `https://YOUR-DEPLOYMENT/api/health` before attempting login.

The shared API implementation still uses Node.js APIs and `@neondatabase/serverless`; this Vercel adapter is not a Cloudflare Workers adapter.

## Netlify alternative

The same backend can still run on Netlify using the existing `netlify.toml` and function directory. Set the same variables in Netlify Site configuration -> Environment variables.

## Required server environment variables

Set these in your hosting provider's environment variables for the deployment contexts you intend to test:

- `DATABASE_URL`: Neon pooled PostgreSQL connection string. Keep it server-side.
- `DDPE_LOGIN_PASSWORD`: a new, strong app password of at least 16 characters. Do not reuse your Deriv token or another account password.
- `DDPE_SESSION_SECRET`: at least 32 random characters. Generate a fresh secret and keep it private.

Never put these values in React code, localStorage, GitHub, or a public issue. If credentials were previously pasted into a chat or committed to a repository, rotate them.

## Apply the database migration

Run `db/migrations/001_ddpe_core.sql` against the intended Neon database once. Verify all five tables exist before testing the API.

## Deploy and test

The backend function is exposed through same-origin routes on Vercel and Netlify:

- `GET /api/health`: reports whether the database and required app configuration are available.
- `POST /api/login`: body: `{"password":"your app password"}`; sets a Secure, HttpOnly, SameSite=Strict session cookie.
- `POST /api/logout`: clears the session cookie.
- `GET /api/settings`: reads the server-side settings.
- `PUT /api/settings`: saves validated settings.
- `POST /api/ticks`: stores a validated tick for the single configured owner.

The owner scope is currently a single-operator constant (`primary`). Do not use this as a multi-user identity system. The login password is a shared secret, so protect it and rotate it if exposed.

## Important limitations

- The dashboard now uses the login screen and reads/writes settings through these API routes. The endpoints still require deployment configuration and live testing.
- The authenticated browser collector posts live ticks to Neon in batches every five seconds while the dashboard is open. Historical ticks are used to seed the display but are not bulk-uploaded.
- This backend does not authenticate with Deriv, request proposals, buy contracts, monitor open contracts, or enforce the daily loss stop against real trades.
- No order execution is enabled. Keep it disabled until Deriv authentication, proposal/buy/settlement handling, persistent risk locking, duplicate-order protection and end-to-end tests are complete.
- Netlify Functions are request-driven serverless functions, not an always-on WebSocket worker. This implementation is suitable for bounded API requests, not a permanent tick-stream execution daemon.
- The health endpoint tests the database connection and reports configuration presence. It does not prove account authentication or trading readiness.


## Data integrity migration

Before deploying the runtime-fix branch, apply `db/migrations/002_tick_and_choice_identity.sql` after migration 001. It backfills stable IDs for existing tick and choice rows, permits distinct ticks and paper outcomes within the same Unix second, and creates the persistent login-throttle table. The backend health endpoint checks for this table and reports `schema_ready: false` until the migration is applied.


## Market-data collection scope

The browser collector requests the Deriv active-symbol list filtered to the DIGITDIFF contract type, then staggers historical seeding and live tick subscriptions for each returned underlying. The selected market controls the visible dashboard; all returned DIGITDIFF-capable markets are collected and their ticks/paper choices are persisted separately. If Deriv changes the active-symbol filter or returns no eligible symbols, check the browser's Deriv API error/status before assuming the feed is active.


## Account currency and execution boundary

The saved stake and daily-loss values are numeric amounts only. The application does not yet verify the Deriv account currency or account minimum stake. Do not interpret the displayed values as USD, and do not enable live purchases until the authenticated Deriv account currency and contract limits have been verified. Live execution remains disabled.

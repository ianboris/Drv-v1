# DDPE secure backend setup

This branch adds the first server-side connection layer. It does not enable Deriv trading.

## Netlify environment variables

Set these in Netlify Site configuration -> Environment variables, for the production and deploy-preview contexts you intend to test:

- `DATABASE_URL`: Neon pooled PostgreSQL connection string. Keep it server-side.
- `DDPE_LOGIN_PASSWORD`: a new, strong app password of at least 16 characters. Do not reuse your Deriv token or another account password.
- `DDPE_SESSION_SECRET`: at least 32 random characters. Generate a fresh secret and keep it private.

Never put these values in React code, localStorage, GitHub, or a public issue. If credentials were previously pasted into a chat or committed to a repository, rotate them.

## Apply the database migration

Run `db/migrations/001_ddpe_core.sql` against the intended Neon database once. Verify all five tables exist before testing the API.

## Deploy and test

The Netlify function is exposed through same-origin routes:

- `GET /api/health`: reports whether the database and required app configuration are available.
- `POST /api/login`: body: `{"password":"your app password"}`; sets a Secure, HttpOnly, SameSite=Strict session cookie.
- `POST /api/logout`: clears the session cookie.
- `GET /api/settings`: reads the server-side settings.
- `PUT /api/settings`: saves validated settings.
- `POST /api/ticks`: stores a validated tick for the single configured owner.

The owner scope is currently a single-operator constant (`primary`). Do not use this as a multi-user identity system. The login password is a shared secret, so protect it and rotate it if exposed.

## Important limitations

- The dashboard has not yet been wired to the login screen or these API routes in this branch. The endpoints must be deployed and tested before frontend migration.
- The tick endpoint is available but the existing browser collector is not yet posting ticks to it.
- This backend does not authenticate with Deriv, request proposals, buy contracts, monitor open contracts, or enforce the daily loss stop against real trades.
- No order execution is enabled. Keep it disabled until Deriv authentication, proposal/buy/settlement handling, persistent risk locking, duplicate-order protection and end-to-end tests are complete.
- Netlify Functions are request-driven serverless functions, not an always-on WebSocket worker. This implementation is suitable for bounded API requests, not a permanent tick-stream execution daemon.
- The health endpoint tests the database connection and reports configuration presence. It does not prove account authentication or trading readiness.

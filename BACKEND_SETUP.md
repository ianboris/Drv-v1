# DDPE Vercel + Neon setup

This repository is Vercel-only. There is no Netlify adapter, Netlify function, or Netlify configuration.

## 1. Vercel project configuration

Import `ianboris/Drv-v1` into Vercel and deploy the branch containing this change.

- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`
- Node.js runtime: 20 or later
- API function: `api/[...path].mjs`

The API route uses Vercel's standard Web Request/Response function interface and imports the backend implementation from `server/api-handler.mjs`.

## 2. Configure server environment variables

In Vercel → Project → Settings → Environment Variables, add the following to Preview first. Add them to Production after Preview verification.

- `DATABASE_URL`: copy the pooled connection string from the intended Neon project. Keep it server-side.
- `DDPE_LOGIN_PASSWORD`: a new private app password of at least 16 characters.
- `DDPE_SESSION_SECRET`: a random secret of at least 32 characters.

Do not paste credentials into GitHub files, frontend variables (such as `VITE_*`), or public issues. Rotate any credentials that were previously exposed.

## 3. Apply Neon migrations

In the Neon SQL Editor, select the exact database referenced by `DATABASE_URL` and execute these files in order:

1. `db/migrations/001_ddpe_core.sql`
2. `db/migrations/002_tick_and_choice_identity.sql`
3. `db/migrations/003_market_scanner_currency.sql`

Use the ordinary Run action. Do not prepend `EXPLAIN` and do not use Explain/Explain Analyze for DDL migrations.

## 4. Deploy and verify

After setting variables and applying migrations, redeploy the Vercel Preview deployment and open:

`https://YOUR-DEPLOYMENT.vercel.app/api/health`

Expected checks include:

- `database_configured: true`
- `database_connected: true`
- `schema_ready: true`
- `login_configured: true`
- `session_secret_configured: true`
- `ok: true`

If `database_configured` is false, the Vercel environment variable is missing or unavailable to that deployment environment. If it is true but `database_connected` is false, verify the connection string, Neon project/database/role, SSL, and Neon project availability. If the database connects but `schema_ready` is false, apply or verify all three migrations against the same Neon database.

A successful health check proves database reachability and the expected schema, not Deriv authentication or trading readiness.

## 5. API routes

- `GET /api/health`
- `POST /api/login`
- `POST /api/logout`
- `GET /api/session`
- `GET /api/settings`
- `PUT /api/settings`
- `POST /api/ticks`
- `GET /api/choices`
- `POST /api/choices`

The current owner scope is a single-operator constant (`primary`), not a multi-user identity system.

## 6. Operational limitations

- The browser collector posts live ticks while the dashboard is open. It is not a continuously running server worker.
- No Deriv account authorization, contract purchase, real settlement monitoring, or server-enforced daily loss stop is implemented.
- Stake and daily-loss settings are stored as configuration only; they do not constrain real orders because this build does not place orders.
- Keep live execution disabled until authentication, proposals, buys, contract monitoring, persistent risk controls, and end-to-end tests exist.

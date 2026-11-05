# DDPE backend foundation

This branch adds a first server-side foundation. It does **not** enable Deriv trading.

## Netlify environment variables

Set these in Netlify Site configuration > Environment variables. Give them Functions runtime scope and redeploy after setting them.

- `DATABASE_URL`: Neon pooled PostgreSQL connection string. Keep it server-side.
- `DDPE_APP_PASSWORD`: a strong, unique password for the single-owner dashboard login. Do not reuse the Deriv token.
- `DDPE_SESSION_SECRET`: at least 32 random bytes, encoded as a long random string.
- `DERIV_PAT`: Deriv personal access token. Not used by this foundation yet; reserve it for the later authenticated Deriv service.
- `DERIV_APP_ID`: current Deriv application ID. Not used by this foundation yet.

Never use a `VITE_` prefix for secrets. Never commit real values to GitHub or put them in browser storage.

## Apply the database migration

Run `db/migrations/001_ddpe_core.sql` once against the intended Neon database. The migration must succeed before persistent settings can be saved. Back up the database first if it already contains DDPE data.

## Deploy and verify

1. Deploy this branch as a Netlify Deploy Preview.
2. Open `/api/health`. It reports configuration booleans and whether Neon answers `SELECT 1`; it never returns secret values.
3. POST JSON `{"password":"YOUR_DDPE_APP_PASSWORD"}` to `/api/auth` from the same site origin. The server sets an HttpOnly, Secure, SameSite=Strict session cookie.
4. GET `/api/auth` to verify the session.
5. GET `/api/settings`, then PUT JSON `{"stake":1,"dailyLossLimit":2,"windowSize":100}`.
6. GET `/api/settings` again and confirm the saved values persist.

The React UI now checks the backend session and can log in from Settings. When authenticated, it loads and saves settings through the server API; when the backend is unavailable or signed out, it falls back to browser localStorage. The dashboard does not yet persist ticks or paper-prediction outcomes to Neon.

## Security and operational limitations

- This is a single-owner password gate, not multi-user identity management. It currently has no distributed login rate limiter; add one before production exposure (for example, a Neon-backed per-IP attempt window) and use a strong unique password.
- Rotate any Deriv or database credentials that were previously pasted into chats or other public/shared locations.
- The health endpoint does not authenticate Deriv and deliberately reports `liveExecution: false`.
- No proposal, buy, contract-monitoring, or STOP worker endpoint is included.
- Netlify Background Functions run for up to 15 minutes, not indefinitely. They cannot serve as a permanent always-on WebSocket trading daemon. Use them only for bounded tasks, or select a persistent worker host and confirm its cost before enabling automated execution.
- Before live trading, add CSRF protections for the deployed origin, rate limiting on login, server-side daily-loss accounting, idempotent order submission, and an authenticated Deriv WebSocket flow. Test on demo first.

# Lotus Deriv demo OAuth setup

This feature uses Deriv OAuth 2.0 Authorization Code + PKCE. Lotus requests only the `trade` scope. The OAuth access token is exchanged on the server and encrypted in Neon with AES-256-GCM. It is never returned to the browser.

## Register the OAuth application

In the Deriv developer dashboard, register an OAuth 2.0 application and enable the `trade` scope.

Register this exact HTTPS redirect URI:

```text
https://lotusthebot.vercel.app/api/deriv/oauth/callback
```

Use the OAuth application's client ID. Do not reuse an old legacy App ID unless Deriv explicitly confirms it is the OAuth client ID for the new API.

## Configure Vercel

Set these variables for Production (and Preview separately if preview OAuth is needed):

- `DERIV_OAUTH_CLIENT_ID`: client ID from the Deriv OAuth application.
- `DERIV_OAUTH_REDIRECT_URI`: `https://lotusthebot.vercel.app/api/deriv/oauth/callback`.
- `DERIV_TOKEN_ENCRYPTION_KEY`: a base64/base64url-encoded 32-byte random key.

Generate the encryption key locally with `openssl rand -base64 32`. Store it as a Vercel secret. Do not commit it, paste it into chat, or reuse it. Back it up securely: losing it makes stored encrypted Deriv tokens unreadable, requiring reauthorization.

## Connect a demo account

1. Sign in to Lotus with its existing app password.
2. Open Settings and choose **Connect Deriv Demo Account**.
3. Sign in to Deriv and approve the requested trade scope.
4. Lotus lists only Options accounts whose API response explicitly identifies `account_type: demo`.
5. Select the demo account and open its demo WebSocket session.

The backend verifies the account type again before issuing a one-time OTP. It rejects a real account and rejects any WebSocket URL that does not use Deriv's documented demo endpoint.

Deriv access tokens expire according to the `expires_in` value returned by OAuth. Deriv does not issue refresh tokens to third-party apps, so Lotus must ask the user to authorize again after expiry.

## Current testing boundaries

- Historical walk-forward replay scores one-step-ahead hit rates using only prior ticks.
- Historical replay does not claim historical contract payouts or net P/L because tick history alone does not reconstruct the quote/payout available at each historical moment.
- This integration opens an authenticated demo WebSocket. It does not yet buy demo contracts or calculate realized forward-test P/L.
- Real-account endpoints and live execution remain unavailable.

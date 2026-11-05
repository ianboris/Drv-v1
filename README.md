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

## Backend setup\n\nSee [docs/BACKEND_SETUP.md](docs/BACKEND_SETUP.md) for Netlify environment variables, Neon migration, authentication setup, and verification steps.\n\n## Scope and limitations

The repository includes a public Deriv market-data interface and an optional password-gated backend for persistent settings. It does not yet authenticate a Deriv trading account, submit proposals, buy contracts, persist tick/prediction history, or execute trades. Displayed digit-frequency anomalies are descriptive statistics, not validated predictive signals. Do not use them as evidence of positive expected value without chronological out-of-sample testing and payout-aware validation.

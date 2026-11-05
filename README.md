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

## Scope and limitations

This repository currently contains a public-market-data research interface only. It does not authenticate a Deriv account, submit proposals, buy contracts, or execute trades. Displayed digit-frequency anomalies are descriptive statistics, not validated predictive signals. Do not use them as evidence of positive expected value without chronological out-of-sample testing and payout-aware validation.

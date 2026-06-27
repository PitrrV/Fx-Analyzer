# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"AT Trading FX Command Center" — a fundamental FX-bias analyzer. It scores currencies from
economic-calendar events, COT (CFTC) positioning, retail sentiment, and central-bank policy,
then ranks currency pairs by bias strength. There is no backend and no build step: this is a
set of static HTML files deployed via GitHub Pages, with all state in the browser's
`localStorage` (optionally synced via Supabase).

## Commands

There is no `package.json`, no bundler, and no test runner — this is plain static HTML/JS.

- **Run locally**: open `index.html` (or `m.html`, `classic.html`) directly in a browser, or
  serve the repo root with any static file server (e.g. `npx serve .`). No install step needed.
- **Syntax-check `engine.js`**: `node --check engine.js`
- **Syntax/JSX-check an HTML frontend**: each `<script type="text/babel">` block must transpile
  cleanly. There's no checked-in validation script — quickly verify with Babel:
  ```js
  const fs=require("fs");const babel=require("@babel/core");
  const html=fs.readFileSync("index.html","utf8"); // or m.html / classic.html
  const m=html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
  babel.transformSync(m[1],{presets:["@babel/preset-react"]}); // throws on syntax error
  ```
  (requires `@babel/core` and `@babel/preset-react` available somewhere on `NODE_PATH`, e.g. a
  scratch `npm install` — there's no project-local `node_modules`).
- **Run a data-fetch script manually**: `node scripts/fetch-cot.js` (also `fetch-calendar.js`,
  `fetch-prices.js`, `fetch-retail.js`) — same scripts the GitHub Actions crons run. Pure
  Node built-ins only, no npm dependencies.

## Architecture

### Three frontends share one engine, with no shared UI/state code

- `index.html` — primary desktop UI ("PC"). A single large `FXApp extends React.Component`.
- `m.html` — mobile UI, function components, similar but independently implemented.
- `classic.html` — legacy/alternate UI, also independently implemented.

All three load React/ReactDOM/Babel-standalone from CDN and write JSX directly inside a
`<script type="text/babel">` block — transpiled in-browser, no build step. Each then loads
`engine.js` (plain `<script>`, runs before the babel block so its functions are global) and
`sync.js` (Supabase cloud sync), in that order:
```html
<script src="engine.js?v=YYYYMMDDx"></script>
<script src="sync.js?v=YYYYMMDDx"></script>
```

**Critical consequence**: `engine.js` holds the shared scoring/data logic (pure functions, no
React, no DOM), but UI features — including the trading journal, alerts, and most rendering —
are duplicated independently across all three HTML files. There is no shared
component/mutation layer. When changing a feature that exists in more than one frontend
(check by grepping for the feature name across `*.html`), update each copy separately and
keep their behavior consistent; they tend to drift (e.g. win-rate formulas differed between
`index.html` and `m.html` until reconciled).

### Cache-busting versions

Every HTML file pins `engine.js?v=...` (and `sync.js?v=...`) to a version string
(`YYYYMMDD` + a letter suffix for same-day changes, e.g. `20260627e`). **Any edit to
`engine.js` or `sync.js` requires bumping this suffix in all three HTML files**, or GitHub
Pages / browsers may serve a stale cached copy.

### `engine.js` — the scoring engine

A large file of standalone functions (no classes, no React) covering:
- **Data fetch + caching**: COT (`fetchCOTAuto`, `fetchCOTViaAPI`, `fetchActionCOTHistory`),
  retail sentiment (`fetchRetailSentiment`, OANDA order-book parsing), economic calendar
  (`fetchCalendar`, `fetchFFEvents`/ForexFactory scraping, FMP/Finnhub adapters), FX prices
  (`fetchActionPrices`).
- **Persistence**: thin `localStorage` read/write wrappers (`loadCOTHistory`/`saveCOTSnapshot`,
  `loadRetailHistory`, `loadScoreHistory`, `loadJournal`, `getAllPositions`, etc.) — these are
  generic getters/setters; outcome-specific or UI-specific logic is NOT here, it lives in each
  HTML file.
- **Scoring**: `scoreCurrency`, `calcConvictionScore`, `getCOTScore`, `getSentimentScore`,
  `getCBPolicyScore`, `calcCBDI`, `getDynamicWeights`, `rankPairs`, `buildForecastV5` — these
  combine calendar/COT/sentiment/CB-policy signals into per-currency and per-pair scores.
- `STANDARD_PAIRS` (top of file) defines the tradable pair universe; most functions take a
  currency code or a pair object from this list.

### Server-side data pipeline (GitHub Actions crons)

`scripts/fetch-{cot,calendar,prices,retail}.js` are dependency-free Node scripts mirroring the
client-side fetch logic in `engine.js`, run on a schedule by `.github/workflows/{cot,calendar,
prices,retail}.yml`. Each cron fetches fresh data, writes it to `data/*.json`, and commits only
if the file changed (`[skip ci]` commit message). The frontends then merge `data/*.json` into
the user's local history on load (e.g. `fetchActionCOTHistory` merges `data/cot_hist.json` into
`cot_hist` in `localStorage`) — this is what lets COT/calendar/price/retail history self-heal
even if a user hasn't opened the app in a while, without any manual import step.

### Cloud sync (`sync.js`)

Optional Supabase-backed sync, loaded by all three frontends. Merge policy: history-shaped
`localStorage` keys (calendar history, COT history, trading journal) are always merged
(union), never overwritten; scalar keys (API keys, settings) are local-wins. See the
`KEYS_SCALAR`/`KEYS_ARR`/`KEYS_OBJ`/`TRANSIENT` lists at the top of `sync.js` before adding a
new `localStorage` key that should (or must not) sync.

### `radar.html` / `ai-market-radar.html`

A separate, standalone tool (AI-driven FX news radar/squawk box) that does **not** load
`engine.js` — independent app, vanilla JS, no React/Babel, calls OpenRouter directly for news
analysis. `ai-market-radar.html` is just a redirect stub to `radar.html`.

### Deployment

Static GitHub Pages site served from `main`. Typical change flow used in this repo: develop on
a feature branch, validate (`node --check engine.js` + Babel JSX check on touched HTML files),
bump the cache-busting version suffix, then PR into `main`.

## Docs

`docs/ECONOMIC_CALENDAR_ARCHITECTURE.md` has the design rationale for the economic-calendar
data layer (provider independence, the `calData` 15-month-history vs `upcoming` 14-day-forecast
split, ForexFactory/FMP/Finnhub adapter normalization) — read it before touching calendar
fetch/merge logic.

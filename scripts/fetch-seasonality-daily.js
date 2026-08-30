// Denní historie pro "Sezónní okno" — server-side cron, bez API klíče,
// bez CORS (Node fetch, ne prohlížeč). Stahuje pro všechny standardní páry
// a píše data/fx_daily/{PAIR}.json ve tvaru {pair,dates,closes,updated},
// které klientský fetchFXDailyHistory() v engine.js čte jako statický
// soubor stejného originu — obchází veřejné CORS proxy (allorigins/
// corsproxy.io/codetabs), které se pro Stooq ukázaly nespolehlivé při
// přímém volání z prohlížeče.
//
// Primární zdroj Stooq, fallback Yahoo Finance (stejný vzor jako
// fetch-oil.js) — první živý běh z GitHub Actions ukázal, že Stooq vrací
// HTML/blok stránku místo CSV pro VŠECHNY páry stejně, nejspíš plošný
// blok datacentrových (Azure) IP adres runnerů, ne problém konkrétního
// páru nebo query parametrů.
const fs = require("fs");
const path = require("path");

const STANDARD_PAIRS = [
  "EURUSD", "USDJPY", "GBPUSD", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "EURGBP",
  "EURCHF", "EURAUD", "EURCAD", "EURJPY", "EURNZD", "GBPCHF", "GBPJPY", "GBPAUD",
  "GBPCAD", "GBPNZD", "AUDCAD", "AUDJPY", "AUDNZD", "AUDCHF", "NZDCAD", "NZDJPY",
  "NZDCHF", "CADJPY", "CADCHF", "CHFJPY",
];

function parseCSVRows(text) {
  return text.trim().split(/\r?\n/).slice(1).map((line) => line.split(","));
}

// Sobota/neděle nejsou forexový obchodní den (trh je zavřený od pátečního
// večera do nedělního večera NY času) — přesto se v datech ze Stooq i Yahoo
// občas objeví víkendem datovaná "denní" svíčka (nejspíš artefakt časového
// pásma zdroje/týdenního přeceňování). Nalezeno reálně v datech: víkendové
// záznamy se opakují prakticky každý týden a odpovídající počet pátečních
// záznamů je kvůli tomu podhodnocený — víkendová svíčka je zjevně
// mislabelovaná, ne skutečný obchodní den. Appka z tohohle souboru počítá
// "pozice v 60denním rozpětí" (position-in-range) — víkendový bod s cenou,
// co nemusí odpovídat žádnému skutečnému obchodování, dokázal tohle číslo
// citelně zkreslit (viz FX Weekly Audit 31.8.–4.9.2026, nález kvality dat).
function isWeekend(dateStr) {
  const dow = new Date(dateStr + "T00:00:00Z").getUTCDay();
  return dow === 0 || dow === 6;
}

// Ochrana proti tichému "downgradu" granularity — první živý běh s Yahoo
// fallbackem vrátil pro range=max&interval=1d jen ~273 bodů za 22 let
// (=měsíční data, ne denní), i když parametr interval=1d byl v URL.
// rows.length<200 by tohle nechytilo (273 > 200), protože kontroloval jen
// POČET bodů, ne jejich hustotu — mezera mezi po sobě jdoucími dny u
// skutečně denních FX dat je řádově dny (víkendy/svátky), ne měsíce.
function assertDailyResolution(dates) {
  if (dates.length < 200) throw new Error(`málo dat (${dates.length} dní)`);
  const gaps = [];
  for (let i = 1; i < dates.length; i++) {
    const d0 = Date.parse(dates[i - 1] + "T00:00:00Z"), d1 = Date.parse(dates[i] + "T00:00:00Z");
    if (!isNaN(d0) && !isNaN(d1)) gaps.push((d1 - d0) / 86400000);
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (!(median <= 10)) throw new Error(`data nejsou denní granularita (medián mezery mezi dny: ${median})`);
}

async function fetchPairStooq(pair) {
  const sym = pair.toLowerCase();
  const today = new Date();
  const d2 = today.getFullYear() + String(today.getMonth() + 1).padStart(2, "0") + String(today.getDate()).padStart(2, "0");
  const url = `https://stooq.com/q/d/l/?s=${sym}&d1=19900101&d2=${d2}&i=d`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  if (!text || /^<!DOCTYPE|exceeded/i.test(text)) throw new Error("neplatná odpověď (Stooq nejspíš blokuje datacentrové IP GitHub Actions)");
  const rows = parseCSVRows(text)
    .map((c) => ({ date: c[0], close: parseFloat(c[4]) }))
    .filter((row) => row.date && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.close) && !isWeekend(row.date));
  const dates = rows.map((row) => row.date), closes = rows.map((row) => row.close);
  assertDailyResolution(dates);
  return { pair, dates, closes, updated: new Date().toISOString() };
}

// Fallback — stejný vzor jako fromYahoo() ve fetch-oil.js. Yahoo FX symboly
// mají tvar "EURUSD=X". POZOR: range=max&interval=1d u Yahoo v praxi vrátilo
// jen ~273 bodů za 22 let (tiše převzorkováno na měsíční data) — explicitní
// period1/period2 (Unix timestampy) tohle chování obchází a vynutí skutečně
// denní granularitu.
async function fetchPairYahoo(pair) {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = Math.floor(new Date("2000-01-01T00:00:00Z").getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${pair}=X?period1=${period1}&period2=${period2}&interval=1d`;
  const r = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  const ts = res && res.timestamp, closes = res && res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close;
  if (!Array.isArray(ts) || !Array.isArray(closes)) throw new Error("neplatná struktura");
  const rows = ts.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
    .filter((row) => row.close != null && Number.isFinite(row.close) && !isWeekend(row.date));
  const outDates = rows.map((row) => row.date), outCloses = rows.map((row) => row.close);
  assertDailyResolution(outDates);
  return { pair, dates: outDates, closes: outCloses, updated: new Date().toISOString() };
}

async function fetchPair(pair) {
  try {
    return await fetchPairStooq(pair);
  } catch (e) {
    console.log("Stooq selhalo pro", pair, "-", e.message, "- zkouším Yahoo");
    return await fetchPairYahoo(pair);
  }
}

(async () => {
  fs.mkdirSync("data/fx_daily", { recursive: true });
  let changed = 0;
  const failed = [];
  for (const pair of STANDARD_PAIRS) {
    try {
      const data = await fetchPair(pair);
      const file = path.join("data/fx_daily", pair + ".json");
      let prev = null;
      try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
      const prevLast = prev && prev.dates && prev.dates[prev.dates.length - 1];
      const newLast = data.dates[data.dates.length - 1];
      if (!prev || prevLast !== newLast || prev.dates.length !== data.dates.length) {
        fs.writeFileSync(file, JSON.stringify(data));
        changed++;
        console.log("OK", pair, data.dates.length, "dní, poslední", newLast);
      } else {
        console.log("beze změny", pair);
      }
    } catch (e) {
      failed.push(pair + ": " + e.message);
      console.log("CHYBA", pair, e.message);
    }
    await new Promise((res) => setTimeout(res, 800)); // zdvořilé zpoždění mezi requesty na Stooq
  }
  console.log(`Hotovo: ${changed} souborů změněno, ${failed.length} párů selhalo.`);
  if (failed.length) console.log("Selhání:", failed.join("; "));
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

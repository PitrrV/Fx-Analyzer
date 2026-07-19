// Denní historie pro "Sezónní okno" — server-side cron, bez API klíče,
// bez CORS (Node fetch, ne prohlížeč). Stahuje ze Stooq (zdarma) pro
// všechny standardní páry a píše data/fx_daily/{PAIR}.json ve tvaru
// {pair,dates,closes,updated}, které klientský fetchFXDailyHistory()
// v engine.js čte jako statický soubor stejného originu — obchází
// veřejné CORS proxy (allorigins/corsproxy.io/codetabs), které se
// pro Stooq ukázaly nespolehlivé při přímém volání z prohlížeče.
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

async function fetchPair(pair) {
  const sym = pair.toLowerCase();
  const today = new Date();
  const d2 = today.getFullYear() + String(today.getMonth() + 1).padStart(2, "0") + String(today.getDate()).padStart(2, "0");
  const url = `https://stooq.com/q/d/l/?s=${sym}&d1=19900101&d2=${d2}&i=d`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  if (!text || /^<!DOCTYPE|exceeded/i.test(text)) throw new Error("neplatná odpověď");
  const rows = parseCSVRows(text)
    .map((c) => ({ date: c[0], close: parseFloat(c[4]) }))
    .filter((row) => row.date && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.close));
  if (rows.length < 200) throw new Error(`málo dat (${rows.length} dní)`);
  return { pair, dates: rows.map((row) => row.date), closes: rows.map((row) => row.close), updated: new Date().toISOString() };
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

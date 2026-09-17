// US100 (Nasdaq-100) cena — GitHub Action, bez API klíče. Yahoo Finance
// (^NDX, skutečný index — appka pro ropu/zlato používá stejnou konvenci
// kontinuálních futures/indexů, viz fetch-oil.js "CL=F"/fetch-gold-price.js
// "GC=F"). Píše data/us100_price.json ve STEJNÉM tvaru jako gold_price.json
// ({updated,source,current,date,series}) — fetchActionUS100Price()/
// loadUS100Price() v engine.js to mergnou do localStorage a
// getUS100RangePosition/getUS100EfficiencyRatio z toho počítají RP+ER
// exhaustion signál stejně jako u zlata (US100 dřív žádnou cenovou historii
// nemělo — skóre je jen COT+retail+makro, bez price-based komponenty).
const fs = require("fs");
const MS_DAY = 86400000;

async function fromYahoo() {
  const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5ENDX?range=1y&interval=1d", {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!r.ok) throw new Error("yahoo HTTP " + r.status);
  const j = await r.json();
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  const ts = res && res.timestamp, closes = res && res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close;
  if (!Array.isArray(ts) || !Array.isArray(closes)) throw new Error("neplatná struktura");
  const rows = ts.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
    .filter((r) => r.close != null && !isNaN(r.close));
  if (rows.length < 30) throw new Error("málo řádků: " + rows.length);
  const current = (res.meta && res.meta.regularMarketPrice) || rows[rows.length - 1].close;
  const date = (res.meta && res.meta.regularMarketTime) ? new Date(res.meta.regularMarketTime * 1000).toISOString() : rows[rows.length - 1].date;
  return { source: "yahoo", current, date, rows };
}

function closestOnOrBefore(rows, targetMs) {
  let best = rows[0];
  for (const r of rows) { if (new Date(r.date).getTime() <= targetMs) best = r; else break; }
  return best.close;
}

(async () => {
  const { source, current, date, rows } = await fromYahoo();
  if (!current || isNaN(current)) throw new Error("žádná platná cena US100");
  const nowMs = Date.now();
  const w4ago = closestOnOrBefore(rows, nowMs - 28 * MS_DAY);
  const w8ago = closestOnOrBefore(rows, nowMs - 56 * MS_DAY);
  const w13ago = closestOnOrBefore(rows, nowMs - 91 * MS_DAY);
  const series = rows.slice(-130).map((r) => r.close);

  const out = { updated: new Date().toISOString(), source, current: parseFloat(current.toFixed(2)), date, w4ago, w8ago, w13ago, series };

  let prev = {};
  try { prev = JSON.parse(fs.readFileSync("data/us100_price.json", "utf8")); } catch (e) {}
  if (prev.current === out.current && prev.date === out.date) { console.log("Cena US100 beze změny, nepřepisuji."); process.exit(0); }

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/us100_price.json", JSON.stringify(out));
  console.log("OK", source, "· US100", out.current, "·", out.date);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

// WTI ropa — server-side cron, bez API klíče. Stahuje aktuální i historickou
// cenu z Stooq (fallback Yahoo Finance chart API) a píše data/oil.json ve
// stejném tvaru, jaký čeká klientský fetchOilPrice()/loadOilData() v engine.js
// ({current,date,w4ago,w8ago,w13ago,series}) → fetchActionOil() v engine.js
// to mergne do localStorage["oil_wti_v1"], takže CAD ropný skór i UI panel
// jedou pro každého uživatele i bez vlastního Alpha Vantage klíče, a aktualizují
// se v intervalu cronu (15 min), ne jen jednou týdně.
const fs = require("fs");
const MS_DAY = 86400000;

function parseCSVRows(text) {
  return text.trim().split(/\r?\n/).slice(1).map((line) => line.split(","));
}

async function fromStooq() {
  const hist = await fetch("https://stooq.com/q/d/l/?s=cl.f&i=d", { signal: AbortSignal.timeout(15000) });
  if (!hist.ok) throw new Error("stooq history HTTP " + hist.status);
  const histText = await hist.text();
  if (!histText || /^<!DOCTYPE|exceeded/i.test(histText)) throw new Error("stooq history neplatná odpověď");
  const rows = parseCSVRows(histText)
    .map((c) => ({ date: c[0], close: parseFloat(c[4]) }))
    .filter((r) => r.date && !isNaN(r.close));
  if (rows.length < 30) throw new Error("stooq history málo řádků: " + rows.length);

  let current = rows[rows.length - 1].close;
  let date = rows[rows.length - 1].date;
  try {
    const snap = await fetch("https://stooq.com/q/l/?s=cl.f&f=sd2t2ohlcv&h&e=csv", { signal: AbortSignal.timeout(10000) });
    if (snap.ok) {
      const snapText = await snap.text();
      const c = parseCSVRows(snapText)[0];
      const close = c && parseFloat(c[6]);
      if (close && !isNaN(close)) { current = close; date = (c[1] || date) + (c[2] ? ("T" + c[2]) : ""); }
    }
  } catch (e) {}

  return { source: "stooq", current, date, rows };
}

async function fromYahoo() {
  const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/CL=F?range=1y&interval=1d", {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!r.ok) throw new Error("yahoo HTTP " + r.status);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  const ts = res?.timestamp, closes = res?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(closes)) throw new Error("yahoo: neplatná struktura");
  const rows = ts.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
    .filter((r) => r.close != null && !isNaN(r.close));
  if (rows.length < 30) throw new Error("yahoo history málo řádků: " + rows.length);
  const current = res?.meta?.regularMarketPrice || rows[rows.length - 1].close;
  const date = res?.meta?.regularMarketTime ? new Date(res.meta.regularMarketTime * 1000).toISOString() : rows[rows.length - 1].date;
  return { source: "yahoo", current, date, rows };
}

function closestOnOrBefore(rows, targetMs) {
  let best = rows[0];
  for (const r of rows) { if (new Date(r.date).getTime() <= targetMs) best = r; else break; }
  return best.close;
}

(async () => {
  let picked;
  try { picked = await fromStooq(); }
  catch (e) { console.log("stooq ERR", e.message); picked = await fromYahoo(); }

  const { source, current, date, rows } = picked;
  if (!current || isNaN(current)) throw new Error("žádná platná cena ropy");
  const nowMs = Date.now();
  const w4ago = closestOnOrBefore(rows, nowMs - 28 * MS_DAY);
  const w8ago = closestOnOrBefore(rows, nowMs - 56 * MS_DAY);
  const w13ago = closestOnOrBefore(rows, nowMs - 91 * MS_DAY);
  const series = rows.slice(-130).map((r) => r.close);

  const out = { updated: new Date().toISOString(), source, current: parseFloat(current.toFixed(2)), date, w4ago, w8ago, w13ago, series };

  let prev = {};
  try { prev = JSON.parse(fs.readFileSync("data/oil.json", "utf8")); } catch (e) {}
  if (prev.current === out.current && prev.date === out.date) { console.log("Cena ropy beze změny, nepřepisuji."); process.exit(0); }

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/oil.json", JSON.stringify(out));
  console.log("OK", source, "· WTI", out.current, "·", out.date);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

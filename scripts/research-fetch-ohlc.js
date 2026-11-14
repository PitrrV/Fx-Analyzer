// VÝZKUM (Reversal edge research) — jednorázový sběr historického OHLC pro 28 FX párů + zlato.
// Dispatch-only workflow (.github/workflows/research-ohlc.yml); sandbox Claude nemá odchozí síť na Yahoo.
// Neovlivňuje produkční kód ani data Analyzeru; píše jen data/research/ohlc/{SYMBOL}.json.
//
// Zdroj: Yahoo Finance chart API, interval 60m, max ~730 dní (limit Yahoo). Z hodinových barů se tady skládají:
//   H4 = 4hodinové svíčky zarovnané na UTC 00/04/08/12/16/20 (open = první H1 open, close = poslední H1 close)
//   D1 = UTC den (00:00–23:59 UTC; close = poslední H1 close dne) — konzistentní s časem, kdy Analyzer signál posílá (00:00 UTC)
// Co NENÍ: broker H4/D1 zarovnání (např. 17:00 New York) — viz limity ve výzkumné zprávě. Chybějící/neúplné bary se
// NEDOPLŇUJÍ; svíčky složené z méně než 3 H1 (H4) se vyřazují.
const fs = require("fs");
const path = require("path");
const OUT = path.join(__dirname, "..", "data", "research", "ohlc");

const FX = ["EURUSD","USDJPY","GBPUSD","AUDUSD","USDCAD","USDCHF","NZDUSD","EURGBP","EURCHF","EURAUD","EURCAD","EURJPY","EURNZD",
  "GBPCHF","GBPJPY","GBPAUD","GBPCAD","GBPNZD","AUDCAD","AUDJPY","AUDNZD","AUDCHF","NZDCAD","NZDJPY","NZDCHF","CADJPY","CADCHF","CHFJPY"];
const SYMBOLS = FX.map((p) => ({ name: p, ticker: p + "=X" })).concat([{ name: "XAUUSD", ticker: "XAUUSD=X" }]);

const H = 3600, H4S = 4 * H, DAY = 24 * H;
const r6 = (x) => (x == null ? null : Math.round(x * 1e6) / 1e6);

// rows: [{t (epoch s), o,h,l,c}] seřazené vzestupně, bez null
function aggregate(rows, bucketSec, minBars) {
  const m = new Map();
  for (const r of rows) {
    const k = Math.floor(r.t / bucketSec) * bucketSec;
    let b = m.get(k);
    if (!b) { b = { t: k, o: r.o, h: r.h, l: r.l, c: r.c, n: 1 }; m.set(k, b); }
    else { b.h = Math.max(b.h, r.h); b.l = Math.min(b.l, r.l); b.c = r.c; b.n++; }
  }
  return [...m.values()].filter((b) => b.n >= minBars).sort((a, b) => a.t - b.t);
}
const pack = (bars) => ({ t: bars.map((b) => b.t), o: bars.map((b) => r6(b.o)), h: bars.map((b) => r6(b.h)), l: bars.map((b) => r6(b.l)), c: bars.map((b) => r6(b.c)), n: bars.map((b) => b.n) });

async function fetchH1(ticker) {
  const p2 = Math.floor(Date.now() / 1000), p1 = p2 - 729 * DAY;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${p1}&period2=${p2}&interval=60m&includePrePost=false`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (research)" }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json(); const res = j.chart && j.chart.result && j.chart.result[0];
      if (!res || !res.timestamp) throw new Error("bez dat");
      const q = res.indicators.quote[0], rows = [];
      res.timestamp.forEach((t, i) => { if ([q.open[i], q.high[i], q.low[i], q.close[i]].every((v) => typeof v === "number" && isFinite(v))) rows.push({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] }); });
      return rows;
    } catch (e) { console.log(ticker, "pokus", attempt + 1, "ERR", e.message); await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); }
  }
  return null;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const meta = { generated: new Date().toISOString(), source: "Yahoo Finance chart API, interval=60m", h4Anchor: "UTC 00/04/08/12/16/20", d1Anchor: "UTC den", symbols: {} };
  for (const s of SYMBOLS) {
    const h1 = await fetchH1(s.ticker);
    if (!h1 || h1.length < 1000) { meta.symbols[s.name] = { ok: false, bars: h1 ? h1.length : 0 }; console.log(s.name, "NEÚSPĚCH"); continue; }
    const h4 = aggregate(h1, H4S, 3), d1 = aggregate(h1, DAY, 12);
    fs.writeFileSync(path.join(OUT, s.name + ".json"), JSON.stringify({ pair: s.name, h4: pack(h4), d1: pack(d1) }));
    meta.symbols[s.name] = { ok: true, h1Bars: h1.length, h4Bars: h4.length, d1Bars: d1.length, from: new Date(h1[0].t * 1000).toISOString(), to: new Date(h1[h1.length - 1].t * 1000).toISOString() };
    console.log(s.name, "OK", h4.length, "H4,", d1.length, "D1");
    await new Promise((r) => setTimeout(r, 400));
  }
  fs.writeFileSync(path.join(OUT, "_meta.json"), JSON.stringify(meta, null, 1));
}
if (require.main === module) main(); else module.exports = { aggregate };

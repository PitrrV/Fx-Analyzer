// Rozpad celoenginového replay backtestu (data/calibration_replay.json) PO
// PÁRECH — stejná rekonstrukce obchodů jako scripts/backtest-replay.js
// (diff = sc[base]-sc[quote], vstup denní fix X+1, žádný look-ahead), jen
// agregovaná per-pair místo přes celé pásmo/horizont. Čte už existující
// výstup, nic nestahuje, nic nepřepočítává.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const STANDARD_PAIRS = [
  { pair: "EURUSD", base: "EUR", quote: "USD" }, { pair: "USDJPY", base: "USD", quote: "JPY" },
  { pair: "GBPUSD", base: "GBP", quote: "USD" }, { pair: "AUDUSD", base: "AUD", quote: "USD" },
  { pair: "USDCAD", base: "USD", quote: "CAD" }, { pair: "USDCHF", base: "USD", quote: "CHF" },
  { pair: "NZDUSD", base: "NZD", quote: "USD" }, { pair: "EURGBP", base: "EUR", quote: "GBP" },
  { pair: "EURCHF", base: "EUR", quote: "CHF" }, { pair: "EURAUD", base: "EUR", quote: "AUD" },
  { pair: "EURCAD", base: "EUR", quote: "CAD" }, { pair: "EURJPY", base: "EUR", quote: "JPY" },
  { pair: "EURNZD", base: "EUR", quote: "NZD" }, { pair: "GBPCHF", base: "GBP", quote: "CHF" },
  { pair: "GBPJPY", base: "GBP", quote: "JPY" }, { pair: "GBPAUD", base: "GBP", quote: "AUD" },
  { pair: "GBPCAD", base: "GBP", quote: "CAD" }, { pair: "GBPNZD", base: "GBP", quote: "NZD" },
  { pair: "AUDCAD", base: "AUD", quote: "CAD" }, { pair: "AUDJPY", base: "AUD", quote: "JPY" },
  { pair: "AUDNZD", base: "AUD", quote: "NZD" }, { pair: "AUDCHF", base: "AUD", quote: "CHF" },
  { pair: "NZDCAD", base: "NZD", quote: "CAD" }, { pair: "NZDJPY", base: "NZD", quote: "JPY" },
  { pair: "NZDCHF", base: "NZD", quote: "CHF" }, { pair: "CADJPY", base: "CAD", quote: "JPY" },
  { pair: "CADCHF", base: "CAD", quote: "CHF" }, { pair: "CHFJPY", base: "CHF", quote: "JPY" },
];
const HORIZONS = [1, 3, 5, 10];

function aggregate(trades) {
  const n = trades.length;
  if (!n) return { n: 0, wr: null, pf: null, avg: null };
  const wins = trades.filter((t) => t.ret > 0).length;
  const gp = trades.filter((t) => t.ret > 0).reduce((a, b) => a + b.ret, 0);
  const gl = Math.abs(trades.filter((t) => t.ret < 0).reduce((a, b) => a + b.ret, 0));
  return { n, wr: +(wins / n * 100).toFixed(1), pf: gl > 0 ? +(gp / gl).toFixed(3) : null, avg: +(trades.reduce((a, b) => a + b.ret, 0) / n).toFixed(4) };
}

(async () => {
  const cal = JSON.parse(fs.readFileSync(path.join(ROOT, "data/calibration_replay.json"), "utf8"));
  const days = cal.dailyScores;
  const pxDays = cal.prices.days, pxRates = cal.prices.rates;
  const pairPrice = (p, i) => { const rr = pxRates[i]; const b = rr[p.base], q = rr[p.quote]; return (b && q) ? q / b : null; };
  const pxIdxOnOrAfter = (iso) => pxDays.findIndex((d) => d >= iso);

  console.log("Replay okno:", cal.window.from, "→", cal.window.to, "(", days.length, "dní )");

  // trades[pair][horizon] = []
  const trades = {}; STANDARD_PAIRS.forEach((p) => (trades[p.pair] = { 1: [], 3: [], 5: [], 10: [] }));
  for (const day of days) {
    const entryIdx = pxIdxOnOrAfter(new Date(Date.parse(day.d) + 86400000).toISOString().slice(0, 10));
    if (entryIdx < 0) continue;
    for (const p of STANDARD_PAIRS) {
      const diff = (day.sc[p.base] || 0) - (day.sc[p.quote] || 0);
      const p0 = pairPrice(p, entryIdx); if (p0 == null) continue;
      for (const H of HORIZONS) {
        if (entryIdx + H >= pxRates.length) continue;
        const p1 = pairPrice(p, entryIdx + H); if (p1 == null) continue;
        trades[p.pair][H].push({ d: day.d, diff, ret: (p1 / p0 - 1) * (diff > 0 ? 1 : -1) * 100 });
      }
    }
  }

  const rows = STANDARD_PAIRS.map((p) => {
    const byH = {}; HORIZONS.forEach((H) => (byH[H] = aggregate(trades[p.pair][H])));
    // "celkově" — všechny horizonty dohromady, hrubý souhrn pro řazení
    const allTrades = HORIZONS.flatMap((H) => trades[p.pair][H]);
    const overall = aggregate(allTrades);
    return { pair: p.pair, overall, byH };
  });

  rows.sort((a, b) => (b.overall.pf || 0) - (a.overall.pf || 0));

  console.log("\nPár        |  n  | WR%  | PF(vše) | avg%/obchod | PF h1d | PF h3d | PF h5d | PF h10d");
  console.log("-".repeat(95));
  for (const r of rows) {
    console.log(
      r.pair.padEnd(10) + " | " + String(r.overall.n).padStart(4) + " | " +
      String(r.overall.wr).padStart(5) + "|" + String(r.overall.pf).padStart(8) + " | " +
      String(r.overall.avg).padStart(11) + " | " +
      String(r.byH[1].pf).padStart(6) + " | " + String(r.byH[3].pf).padStart(6) + " | " +
      String(r.byH[5].pf).padStart(6) + " | " + String(r.byH[10].pf).padStart(7)
    );
  }

  const best = rows[0], worst = rows[rows.length - 1];
  console.log("\nNejlepší pár (celkové PF):", best.pair, JSON.stringify(best.overall));
  console.log("Nejhorší pár (celkové PF):", worst.pair, JSON.stringify(worst.overall));

  const out = { updated: new Date().toISOString(), source: "data/calibration_replay.json (per-pár rozpad)", window: cal.window, rows };
  fs.writeFileSync(path.join(ROOT, "data/calibration_replay_by_pair.json"), JSON.stringify(out, null, 2));
  console.log("\nOK · zapsáno data/calibration_replay_by_pair.json");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

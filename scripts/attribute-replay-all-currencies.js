// Atribuce komponent — VŠECHNY měny, ne jen JPY/CAD (rozšíření
// attribute-replay-components.js). Pro každou měnu a každou komponentu
// skóre (fund/policy/yield/cot/sent/season/oil/risk):
//   1) izolovaný obchodní test (diff_C = comp[base][C]-comp[quote][C],
//      stejný vstup den X+1, stejné horizonty jako backtest-replay.js)
//   2) stabilita komponenty pro tu měnu — kolikrát za replay okno změnila
//      znaménko (0 = jeden setrvalý signál, hodně = šum/whipsaw) a průměrná
//      |hodnota|
// Cíl: najít, jestli různé měny potřebují jinak vážené komponenty (ne
// jedno plošné nastavení pro všech 8), a kde konkrétně je komponenta u
// dané měny buď šumová (hodně flipů), nebo stabilní-ale-špatným-směrem
// (málo flipů, PF<1).
//
// Čte existující data/calibration_replay.json (žádný nový fetch/přepočet
// enginu) — reálné Frankfurter kurzy a point-in-time komponenty skóre už
// jsou v něm uložené z posledního běhu scripts/backtest-replay.js.
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
const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
const HORIZONS = [1, 3, 5, 10];
const COMPONENTS = ["fund_data", "policy", "yield", "cot", "sent", "season", "oil", "risk"];

function aggregate(trades) {
  const n = trades.length;
  if (!n) return { n: 0, wr: null, pf: null, avg: null };
  const wins = trades.filter((t) => t.ret > 0).length;
  const gp = trades.filter((t) => t.ret > 0).reduce((a, b) => a + b.ret, 0);
  const gl = Math.abs(trades.filter((t) => t.ret < 0).reduce((a, b) => a + b.ret, 0));
  return { n, wr: +(wins / n * 100).toFixed(1), pf: gl > 0 ? +(gp / gl).toFixed(3) : null, avg: +(trades.reduce((a, b) => a + b.ret, 0) / n).toFixed(4) };
}
function stability(days, ccy, comp) {
  let flips = 0, prevSign = null, nonZero = 0, sumAbs = 0;
  for (const day of days) {
    const v = (day.comp[ccy] && day.comp[ccy][comp]) || 0;
    const s = v > 0 ? 1 : v < 0 ? -1 : 0;
    if (s !== 0) { nonZero++; sumAbs += Math.abs(v); if (prevSign !== null && s !== prevSign) flips++; prevSign = s; }
  }
  return { flips, nonZero, avgAbs: nonZero ? +(sumAbs / nonZero).toFixed(3) : 0 };
}

(async () => {
  const cal = JSON.parse(fs.readFileSync(path.join(ROOT, "data/calibration_replay.json"), "utf8"));
  const days = cal.dailyScores;
  const pxDays = cal.prices.days, pxRates = cal.prices.rates;
  const pairPrice = (p, i) => { const rr = pxRates[i]; const b = rr[p.base], q = rr[p.quote]; return (b && q) ? q / b : null; };
  const pxIdxOnOrAfter = (iso) => pxDays.findIndex((d) => d >= iso);

  console.log("Replay okno:", cal.window.from, "→", cal.window.to, "(", days.length, "dní )\n");

  const sigKeys = ["score", ...COMPONENTS];
  // ccy -> pairs containing it
  const pairsOf = {}; CURRENCIES.forEach((c) => (pairsOf[c] = STANDARD_PAIRS.filter((p) => p.base === c || p.quote === c)));

  // sesbírej obchody: results[ccy][sigKey] = []
  const results = {}; CURRENCIES.forEach((c) => { results[c] = {}; sigKeys.forEach((k) => (results[c][k] = [])); });

  for (const day of days) {
    const entryIdx = pxIdxOnOrAfter(new Date(Date.parse(day.d) + 86400000).toISOString().slice(0, 10));
    if (entryIdx < 0) continue;
    for (const p of STANDARD_PAIRS) {
      const p0 = pairPrice(p, entryIdx); if (p0 == null) continue;
      const diffs = { score: (day.sc[p.base] || 0) - (day.sc[p.quote] || 0) };
      for (const c of COMPONENTS) {
        const cb = day.comp[p.base] && day.comp[p.base][c], cq = day.comp[p.quote] && day.comp[p.quote][c];
        diffs[c] = (cb || 0) - (cq || 0);
      }
      for (const H of HORIZONS) {
        if (entryIdx + H >= pxRates.length) continue;
        const p1 = pairPrice(p, entryIdx + H); if (p1 == null) continue;
        const rawRet = (p1 / p0 - 1) * 100;
        for (const k of sigKeys) {
          if (diffs[k] === 0) continue;
          const ret = rawRet * Math.sign(diffs[k]);
          if (pairsOf[p.base].includes(p)) results[p.base][k].push({ ret });
          if (pairsOf[p.quote].includes(p)) results[p.quote][k].push({ ret });
        }
      }
    }
  }

  const table = {};
  for (const ccy of CURRENCIES) {
    table[ccy] = { pairs: pairsOf[ccy].map((p) => p.pair), score: aggregate(results[ccy].score), components: {} };
    for (const c of COMPONENTS) {
      table[ccy].components[c] = { ...aggregate(results[ccy][c]), stability: stability(days, ccy, c) };
    }
  }

  for (const ccy of CURRENCIES) {
    const t = table[ccy];
    console.log(`\n=== ${ccy} (páry: ${t.pairs.join(",")}) ===`);
    console.log(`  CELÉ SKÓRE: n=${t.score.n} WR=${t.score.wr}% PF=${t.score.pf}`);
    const rows = COMPONENTS.map((c) => ({ c, ...t.components[c] })).sort((a, b) => (b.pf || 0) - (a.pf || 0));
    for (const r of rows) {
      console.log(`  ${r.c.padEnd(10)} PF=${String(r.pf).padStart(6)}  WR=${String(r.wr).padStart(5)}%  n=${String(r.n).padStart(5)}  | flipy=${String(r.stability.flips).padStart(3)}  ø|hodnota|=${r.stability.avgAbs}`);
    }
    const best = rows[0], worst = rows[rows.length - 1];
    console.log(`  → nejlepší izolovaná komponenta: ${best.c} (PF ${best.pf}) | nejhorší: ${worst.c} (PF ${worst.pf})`);
  }

  // souhrnná tabulka pro rychlé srovnání napříč měnami
  console.log("\n\n=== SOUHRN — nejlepší/nejhorší komponenta per měna ===");
  console.log("Měna | celé skóre PF | nejlepší komponenta (PF) | nejhorší komponenta (PF)");
  for (const ccy of CURRENCIES) {
    const t = table[ccy];
    const rows = COMPONENTS.map((c) => ({ c, ...t.components[c] })).sort((a, b) => (b.pf || 0) - (a.pf || 0));
    const best = rows[0], worst = rows[rows.length - 1];
    console.log(`${ccy}   | ${String(t.score.pf).padStart(6)}       | ${best.c.padEnd(10)} (${best.pf})     | ${worst.c.padEnd(10)} (${worst.pf})`);
  }

  const out = { updated: new Date().toISOString(), source: "data/calibration_replay.json (atribuce komponent, VŠECHNY měny)", window: cal.window, table };
  fs.writeFileSync(path.join(ROOT, "data/calibration_replay_attribution_all.json"), JSON.stringify(out, null, 2));
  console.log("\nOK · zapsáno data/calibration_replay_attribution_all.json");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

// Atribuce komponent — KTERÁ složka skóre (fund/policy/yield/cot/sent/season/
// oil/risk) táhne CAD-quote páry nahoru a JPY páry dolů v celoenginovém
// replay backtestu? Čte existující data/calibration_replay.json (dailyScores
// nese per-currency komponenty i celkové skóre, prices nese denní kurzy) —
// žádný nový fetch, žádný přepočet enginu.
//
// Metoda: pro každou komponentu C zvlášť postavíme ALTERNATIVNÍ signál
// diff_C = comp[base][C] - comp[quote][C] (misto celého váženého skóre) a
// přehrajeme STEJNÝ obchodní test (stejný vstup den X+1, stejné horizonty)
// jen s tímhle izolovaným signálem. Komponenta, jejíž izolovaný PF pro
// JPY/CAD páry kopíruje (nebo je horší než) PF celého skóre, je hlavní
// podezřelý — komponenta s dobrým izolovaným PF naopak NENÍ viník (může být
// dokonce přehlušena ostatními).
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
const COMPONENTS = ["fund_data", "policy", "yield", "cot", "sent", "season", "oil", "risk"];

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

  const jpyPairs = STANDARD_PAIRS.filter((p) => p.base === "JPY" || p.quote === "JPY");
  const cadPairs = STANDARD_PAIRS.filter((p) => p.base === "CAD" || p.quote === "CAD");
  console.log("JPY páry:", jpyPairs.map((p) => p.pair).join(","));
  console.log("CAD páry:", cadPairs.map((p) => p.pair).join(","));

  // pro každou komponentu (+ "score" = celé skóre, kontrolní baseline) sesbírej
  // obchody zvlášť pro JPY-páry a CAD-páry, přes všechny horizonty dohromady
  const groups = { jpy: jpyPairs, cad: cadPairs, all: STANDARD_PAIRS };
  const sigKeys = ["score", ...COMPONENTS];
  const results = {}; // group -> sigKey -> aggregate
  for (const g of Object.keys(groups)) results[g] = {};
  for (const g of Object.keys(groups)) for (const k of sigKeys) results[g][k] = [];

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
          if (diffs[k] === 0) continue; // žádný signál z týhle komponenty ten den — nehodnotíme
          const ret = rawRet * Math.sign(diffs[k]);
          for (const g of Object.keys(groups)) {
            if (groups[g].some((gp) => gp.pair === p.pair)) results[g][k].push({ ret });
          }
        }
      }
    }
  }

  console.log("\n=== Izolovaná predikční síla každé komponenty (PF), přes všechny horizonty ===\n");
  console.log("Komponenta   |  JPY páry (n/WR/PF)      |  CAD páry (n/WR/PF)      |  Všechny páry (n/WR/PF)");
  console.log("-".repeat(100));
  const table = {};
  for (const k of sigKeys) {
    const rj = aggregate(results.jpy[k]), rc = aggregate(results.cad[k]), ra = aggregate(results.all[k]);
    table[k] = { jpy: rj, cad: rc, all: ra };
    const fmt = (r) => `n=${String(r.n).padStart(5)} WR=${String(r.wr).padStart(5)}% PF=${String(r.pf).padStart(6)}`;
    console.log(k.padEnd(13) + "| " + fmt(rj) + " | " + fmt(rc) + " | " + fmt(ra));
  }

  const out = { updated: new Date().toISOString(), source: "data/calibration_replay.json (atribuce komponent, izolovaný diff per komponenta)", window: cal.window, jpyPairs: jpyPairs.map((p) => p.pair), cadPairs: cadPairs.map((p) => p.pair), table };
  fs.writeFileSync(path.join(ROOT, "data/calibration_replay_attribution.json"), JSON.stringify(out, null, 2));
  console.log("\nOK · zapsáno data/calibration_replay_attribution.json");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

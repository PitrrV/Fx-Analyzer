// Kalibrace sezónnosti — má měsíční sezónní bias měn (SEASONALITY tabulka
// v engine.js, dnes váha 2 %) skutečnou OUT-OF-SAMPLE predikční hodnotu?
//
// Zdroj: data/fx_daily/*.json — stejný denní cenový pipeline jako "Sezónní
// okno" v appce (viz scripts/fetch-seasonality-daily.js), teď až ~20-22 let
// napříč všemi 28 páry. Dřív appka měla k dispozici jen pár let z Alpha
// Vantage FX_MONTHLY (cache), takže tohle je první test, který má dost
// historie na to nebýt jen curve-fit na tu samou vzorku.
//
// Dvě měření:
//  1) STATIC — dnešní hardcoded SEASONALITY tabulka z engine.js (jak žije
//     v produkci) proti VŠEM dostupným rokům. Přímo odpovídá na "jak se
//     chová TOHLE, co appka dneska reálně počítá".
//  2) WALK-FORWARD — sezónní skóre měny/měsíce se přepočítá z EXPANDING
//     okna jen z let PŘED testovaným rokem (žádný look-ahead, stejná
//     disciplína jako scripts/backtest-replay.js) — ptá se "kdyby appka
//     seasonality tabulku sama průběžně přeučovala z historie, měla by to
//     genuinní predikční hodnotu, nebo je to jen šum?".
//
// Currency-level měsíční "síla" se odvozuje ze VŠECH 28 párů (base kladně,
// quote záporně, průměr) — přímá obdoba metody v backtest-impact.js
// (ccyReturnPct), jen z vlastních denních dat místo Frankfurter USD-koše.
//
// Měřicí nástroj — engine.js se tímhle skriptem nemění, jen zapisuje
// data/calibration_seasonality.json.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// ── zkopírováno 1:1 z engine.js, ať je to identické s produkcí ──
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
const SEASONALITY = {
  USD: [0, -1, -1, -1, -1, 0, 0, 1, 2, 1, 0, 0],
  EUR: [1, 1, 1, 0, 1, 0, -1, -1, -1, 0, 0, -1],
  GBP: [0, 0, 1, 1, 0, -1, -1, -1, 1, 1, 0, 0],
  JPY: [2, 1, 0, -1, -1, -1, 0, 1, 1, 0, -1, 0],
  AUD: [1, 1, 1, 0, -1, -1, -1, 0, 0, 0, 1, 1],
  CAD: [-1, 0, 0, -1, -1, 0, 1, 1, 1, 1, 0, -1],
  CHF: [1, 0, 0, 0, 1, 1, 0, -1, -1, -1, 0, 1],
  NZD: [1, 1, 0, 0, -1, -1, -1, 0, 0, 0, 1, 1],
};
const MIN_TRAIN_YEARS = 5; // kolik let musí být v expanding okně, než začne testování daného roku

function monthlyCloses(daily) {
  // {"YYYY-M": {first, last}} — první a poslední obchodní den v měsíci
  const byMonth = new Map();
  for (let i = 0; i < daily.dates.length; i++) {
    const d = daily.dates[i], c = daily.closes[i];
    if (!Number.isFinite(c)) continue;
    const key = d.slice(0, 4) + "-" + (+d.slice(5, 7) - 1); // rok-měsíc(0-idx)
    let m = byMonth.get(key);
    if (!m) { m = { first: c, last: c }; byMonth.set(key, m); } else m.last = c;
  }
  return byMonth;
}
function aggregate(trades) {
  const n = trades.length;
  if (!n) return { n: 0, wr: null, pf: null, avg: null };
  const wins = trades.filter((t) => t.ret > 0).length;
  const gp = trades.filter((t) => t.ret > 0).reduce((a, b) => a + b.ret, 0);
  const gl = Math.abs(trades.filter((t) => t.ret < 0).reduce((a, b) => a + b.ret, 0));
  return { n, wr: +(wins / n * 100).toFixed(1), pf: gl > 0 ? +(gp / gl).toFixed(3) : gp > 0 ? null : null, avg: +(trades.reduce((a, b) => a + b.ret, 0) / n).toFixed(4) };
}
const BANDS = [[0, 1, "slabý <1"], [1, 2, "střední 1–2"], [2, 99, "silný 2+"]];
function gridFor(trades) {
  const sorted = [...trades].sort((a, b) => (a.y - b.y) || (a.m - b.m));
  const mid = sorted[Math.floor(sorted.length / 2)];
  const midKey = mid ? mid.y * 12 + mid.m : 0;
  return BANDS.map(([lo, hi, label]) => {
    const sel = trades.filter((t) => Math.abs(t.diff) >= lo && Math.abs(t.diff) < hi);
    const h1 = aggregate(sel.filter((t) => t.y * 12 + t.m < midKey));
    const h2 = aggregate(sel.filter((t) => t.y * 12 + t.m >= midKey));
    return { band: label, ...aggregate(sel), half1: h1, half2: h2, robust: h1.n >= 20 && h2.n >= 20 && h1.pf != null && h2.pf != null && h1.pf > 1 && h2.pf > 1 };
  });
}

(async () => {
  // ── načíst denní data + spočítat měsíční returny všech párů ──
  const monthlyByPair = {}; // pair -> Map("Y-M" -> ret%)
  const monthKeysByPair = {};
  for (const p of STANDARD_PAIRS) {
    const file = path.join(ROOT, "data/fx_daily", p.pair + ".json");
    if (!fs.existsSync(file)) { console.log("chybí", file, "- přeskakuji", p.pair); continue; }
    const daily = JSON.parse(fs.readFileSync(file, "utf8"));
    const byMonth = monthlyCloses(daily);
    const rets = new Map();
    for (const [key, { first, last }] of byMonth) rets.set(key, (last / first - 1) * 100);
    monthlyByPair[p.pair] = rets;
  }
  console.log("Načteno měsíčních řad pro", Object.keys(monthlyByPair).length, "/", STANDARD_PAIRS.length, "párů.");

  // ── currency-level měsíční síla ze všech párů, co danou měnu obsahují ──
  // strength[c].get("Y-M") = průměr signed příspěvků (base:+, quote:-)
  const strength = {}; CURRENCIES.forEach((c) => (strength[c] = new Map()));
  const contribBuf = {}; CURRENCIES.forEach((c) => (contribBuf[c] = new Map())); // key -> [vals]
  for (const p of STANDARD_PAIRS) {
    const rets = monthlyByPair[p.pair]; if (!rets) continue;
    for (const [key, ret] of rets) {
      if (!contribBuf[p.base].has(key)) contribBuf[p.base].set(key, []);
      contribBuf[p.base].get(key).push(ret);
      if (!contribBuf[p.quote].has(key)) contribBuf[p.quote].set(key, []);
      contribBuf[p.quote].get(key).push(-ret);
    }
  }
  for (const c of CURRENCIES) for (const [key, vals] of contribBuf[c]) strength[c].set(key, vals.reduce((a, b) => a + b, 0) / vals.length);

  // rozsah let: od prvního roku, kde má aspoň 6/8 měn data, do posledního KOMPLETNÍHO měsíce
  const now = new Date();
  const curKey = now.getUTCFullYear() * 12 + now.getUTCMonth(); // aktuální (nekompletní) měsíc vyloučit
  let allYears = new Set();
  CURRENCIES.forEach((c) => strength[c].forEach((_, key) => allYears.add(+key.split("-")[0])));
  const years = [...allYears].sort((a, b) => a - b);
  const startYear = years[0], endYear = years[years.length - 1];
  console.log("Rozsah let (currency-level):", startYear, "→", endYear);

  // ── (1) STATIC — dnešní produkční SEASONALITY tabulka proti všem letům ──
  const staticTrades = [];
  for (let y = startYear; y <= endYear; y++) {
    for (let m = 0; m < 12; m++) {
      if (y * 12 + m >= curKey) continue; // vynech nekompletní/budoucí měsíc
      const key = y + "-" + m;
      for (const p of STANDARD_PAIRS) {
        const ret = monthlyByPair[p.pair] && monthlyByPair[p.pair].get(key);
        if (ret == null) continue;
        const diff = (SEASONALITY[p.base][m] || 0) - (SEASONALITY[p.quote][m] || 0);
        if (diff === 0) continue;
        staticTrades.push({ y, m, pair: p.pair, diff, ret: ret * Math.sign(diff) });
      }
    }
  }
  const staticGrid = gridFor(staticTrades);
  const staticOverall = aggregate(staticTrades);

  // ── (2) WALK-FORWARD — expanding okno, jen roky < Y, min. MIN_TRAIN_YEARS ──
  const wfTrades = [];
  const testFromYear = startYear + MIN_TRAIN_YEARS;
  for (let Y = testFromYear; Y <= endYear; Y++) {
    // sezónní skóre měny/měsíce = průměr strength[c][y][m] pro všechna y < Y
    const seasonal = {}; CURRENCIES.forEach((c) => (seasonal[c] = new Array(12).fill(null)));
    for (const c of CURRENCIES) {
      for (let m = 0; m < 12; m++) {
        const vals = [];
        for (let y = startYear; y < Y; y++) { const v = strength[c].get(y + "-" + m); if (v != null) vals.push(v); }
        if (vals.length >= 3) seasonal[c][m] = vals.reduce((a, b) => a + b, 0) / vals.length;
      }
    }
    for (let m = 0; m < 12; m++) {
      if (Y * 12 + m >= curKey) continue;
      const key = Y + "-" + m;
      for (const p of STANDARD_PAIRS) {
        const ret = monthlyByPair[p.pair] && monthlyByPair[p.pair].get(key);
        if (ret == null) continue;
        const sb = seasonal[p.base][m], sq = seasonal[p.quote][m];
        if (sb == null || sq == null) continue;
        const diff = sb - sq;
        if (diff === 0) continue;
        wfTrades.push({ y: Y, m, pair: p.pair, diff, ret: ret * Math.sign(diff) });
      }
    }
  }
  const wfGrid = gridFor(wfTrades);
  const wfOverall = aggregate(wfTrades);
  console.log("Walk-forward test od roku", testFromYear, "(", MIN_TRAIN_YEARS, "let trénovacího okna ).");

  console.log("\n=== (1) STATIC — dnešní SEASONALITY tabulka, celá historie ===");
  console.log("Celkem:", staticOverall);
  for (const g of staticGrid) console.log(` ${g.band}: n=${g.n} WR=${g.wr}% PF=${g.pf} avg=${g.avg}% | h1 PF=${g.half1.pf} (n${g.half1.n}) | h2 PF=${g.half2.pf} (n${g.half2.n}) ${g.robust ? "✅ROBUST" : ""}`);

  console.log("\n=== (2) WALK-FORWARD — expanding okno, bez look-ahead ===");
  console.log("Celkem:", wfOverall);
  for (const g of wfGrid) console.log(` ${g.band}: n=${g.n} WR=${g.wr}% PF=${g.pf} avg=${g.avg}% | h1 PF=${g.half1.pf} (n${g.half1.n}) | h2 PF=${g.half2.pf} (n${g.half2.n}) ${g.robust ? "✅ROBUST" : ""}`);

  const out = {
    updated: new Date().toISOString(),
    source: "data/fx_daily/*.json (denní ceny, currency-level síla odvozená ze všech 28 párů)",
    window: { startYear, endYear, walkForwardFrom: testFromYear, minTrainYears: MIN_TRAIN_YEARS },
    static: { overall: staticOverall, grid: staticGrid },
    walkForward: { overall: wfOverall, grid: wfGrid },
    note: "Měřicí nástroj — nic v engine.js se automaticky neupravuje. Porovnej PF/WR obou režimů a robust flagy (obě poloviny okna PF>1, n>=20) před případnou změnou váhy 'sea' v getDynamicWeights().",
  };
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data/calibration_seasonality.json"), JSON.stringify(out, null, 2));
  console.log("\nOK · zapsáno data/calibration_seasonality.json");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

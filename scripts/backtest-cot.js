// COT bias — server-side backtest/kalibrace (běží automaticky, bez uživatelského
// Alpha Vantage klíče). Stejná matematika jako "🔬 Backtest & Kalibrace" v classic.html
// (runCOTBacktest/runBacktestSweep), jen ceny bere z Frankfurter (ECB, bez klíče) místo
// z Alpha Vantage v prohlížeči. Testuje: když COT rozdíl (base−quote) přesáhne práh,
// jak dopadl obchod ve směru toho rozdílu po N týdnech — na reálných historických cenách.
// Píše data/calibration.json; appka ho zatím nečte (žádná UI vazba) — je to měřicí nástroj,
// ne vstup do skóre. Engine se tímto skriptem NEMĚNÍ.
const fs = require("fs");

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
const CUR = ["EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
const BT_HORIZONS = [1, 2, 4, 8];           // týdny dopředu
const BT_DIFFS = [0, 1, 1.5, 2, 2.5, 3];    // prahy |COT diff|
const BT_MIN_TRADES = 30;                    // minimální vzorek pro důvěryhodnost

async function fetchHistoricalRates(startDate, endDate) {
  const url = `https://api.frankfurter.app/${startDate}..${endDate}?from=USD&to=${CUR.join(",")}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("Frankfurter HTTP " + r.status);
  const j = await r.json();
  if (!j || !j.rates || !Object.keys(j.rates).length) throw new Error("Frankfurter: prázdná odpověď");
  return j.rates; // { "2024-11-05": {EUR:.., GBP:..}, ... }
}

// Postaví pro každou měnu setříděnou řadu {date, v}. USD = konstanta 1.
function buildSeries(ratesByDate) {
  const series = { USD: [] };
  CUR.forEach((c) => (series[c] = []));
  const dates = Object.keys(ratesByDate).sort();
  for (const d of dates) {
    const row = ratesByDate[d];
    series.USD.push({ date: d, v: 1 });
    CUR.forEach((c) => { if (row[c] != null) series[c].push({ date: d, v: row[c] }); });
  }
  return series;
}
// Binární hledání nejbližší ceny v okamžiku >= targetMs (stejná logika jako btPriceOnOrAfter v classic.html).
function priceOnOrAfter(s, targetMs) {
  let lo = 0, hi = s.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = Date.parse(s[mid].date + "T00:00:00Z");
    if (t >= targetMs) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans < 0 ? null : s[ans].v;
}
function pairPrice(series, base, quote, targetMs) {
  const b = priceOnOrAfter(series[base] || [], targetMs);
  const q = priceOnOrAfter(series[quote] || [], targetMs);
  if (b == null || q == null || q === 0) return null;
  return q / b; // stejná konvence jako engine.js _pxFrom(): rates[quote]/rates[base]
}

// Rolling percentil COT skóre — jen z minulosti (žádný look-ahead), pro test "vyhýbat se crowded".
function buildPercentiles(weeks, dates) {
  const CURRENCIES = [...CUR, "USD"];
  const pct = {}; CURRENCIES.forEach((c) => (pct[c] = {}));
  CURRENCIES.forEach((c) => {
    const past = [];
    for (const d of dates) {
      const v = weeks[d]?.scores?.[c];
      if (typeof v !== "number") continue;
      pct[c][d] = past.length ? Math.round((past.filter((x) => x <= v).length / past.length) * 100) : 50;
      past.push(v);
    }
  });
  return pct;
}
function aggregate(trades) {
  const n = trades.length;
  if (!n) return { n: 0, wr: null, pf: null, avg: null };
  const wins = trades.filter((t) => t.ret > 0).length;
  const gp = trades.filter((t) => t.ret > 0).reduce((a, b) => a + b.ret, 0);
  const gl = Math.abs(trades.filter((t) => t.ret < 0).reduce((a, b) => a + b.ret, 0));
  return { n, wins, wr: parseFloat((wins / n * 100).toFixed(1)), pf: gl > 0 ? parseFloat((gp / gl).toFixed(3)) : (gp > 0 ? Infinity : null),
    avg: parseFloat((trades.reduce((a, b) => a + b.ret, 0) / n).toFixed(3)) };
}
// Jádro: COT historie × páry → forward výnos ve směru COT diffu. Identické s runCOTBacktest() v classic.html.
function runCOTBacktest(series, weeks, pctMap, { horizonWeeks, diffThreshold, avoidExtremes }) {
  const dates = Object.keys(weeks).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const horizonMs = horizonWeeks * 7 * 86400000;
  const trades = []; const byPair = {};
  for (const pr of STANDARD_PAIRS) {
    for (const d of dates) {
      const sc = weeks[d]?.scores; if (!sc) continue;
      const diff = (sc[pr.base] ?? 0) - (sc[pr.quote] ?? 0);
      if (Math.abs(diff) < diffThreshold) continue;
      if (avoidExtremes && pctMap) {
        const pb = pctMap[pr.base]?.[d], pq = pctMap[pr.quote]?.[d];
        const crowded = (pb != null && (pb >= 88 || pb <= 12)) || (pq != null && (pq >= 88 || pq <= 12));
        if (crowded) continue;
      }
      const t0 = Date.parse(d + "T00:00:00Z");
      const p0 = pairPrice(series, pr.base, pr.quote, t0);
      const p1 = pairPrice(series, pr.base, pr.quote, t0 + horizonMs);
      if (p0 == null || p1 == null) continue;
      const dir = diff > 0 ? 1 : -1;
      const ret = (p1 / p0 - 1) * dir * 100;
      const tr = { pair: pr.pair, date: d, diff: parseFloat(diff.toFixed(2)), dir, ret: parseFloat(ret.toFixed(4)) };
      trades.push(tr); (byPair[pr.pair] = byPair[pr.pair] || []).push(tr);
    }
  }
  const agg = aggregate(trades); agg.byPair = byPair; return agg;
}
// Test konkrétního tvrzení "silný fundament/COT + pozice už v extrému = zralý/rizikovější
// trend" (ne binární filtr on/off jako runCOTBacktest, ale 3 pásma zralosti pozicování).
// favoredPct = percentil MĚNY, na kterou obchod sází (ne obou stran) — to je přesně ta
// informace, kterou by "kontextová karta" použila pro rozlišení fresh/maturing/aging.
const MATURITY_DIFF_MIN = 1; // stejný práh jako nejnižší "reálný signál" v gridu
function classifyMaturity(diff, pctBase, pctQuote) {
  const dir = diff > 0 ? 1 : -1;
  const favoredPct = dir === 1 ? pctBase : pctQuote;
  if (favoredPct == null) return null;
  if (favoredPct >= 88) return "aging";     // měna, na kterou sázíme, je už crowded ve svůj prospěch
  if (favoredPct >= 70) return "maturing";
  return "fresh";
}
function runMaturityTest(series, weeks, pctMap) {
  const dates = Object.keys(weeks).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const out = {};
  for (const h of BT_HORIZONS) {
    const horizonMs = h * 7 * 86400000;
    const buckets = { fresh: [], maturing: [], aging: [] };
    for (const pr of STANDARD_PAIRS) {
      for (const d of dates) {
        const sc = weeks[d]?.scores; if (!sc) continue;
        const diff = (sc[pr.base] ?? 0) - (sc[pr.quote] ?? 0);
        if (Math.abs(diff) < MATURITY_DIFF_MIN) continue;
        const pctBase = pctMap[pr.base]?.[d], pctQuote = pctMap[pr.quote]?.[d];
        const bucket = classifyMaturity(diff, pctBase, pctQuote);
        if (!bucket) continue;
        const t0 = Date.parse(d + "T00:00:00Z");
        const p0 = pairPrice(series, pr.base, pr.quote, t0);
        const p1 = pairPrice(series, pr.base, pr.quote, t0 + horizonMs);
        if (p0 == null || p1 == null) continue;
        const dir = diff > 0 ? 1 : -1;
        const ret = (p1 / p0 - 1) * dir * 100;
        buckets[bucket].push({ ret });
      }
    }
    out[`h${h}`] = { fresh: aggregate(buckets.fresh), maturing: aggregate(buckets.maturing), aging: aggregate(buckets.aging) };
  }
  return out;
}
function runSweep(series, weeks) {
  const dates = Object.keys(weeks).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const pctMap = buildPercentiles(weeks, dates);
  const grid = [];
  for (const h of BT_HORIZONS) for (const df of BT_DIFFS) {
    const r = runCOTBacktest(series, weeks, pctMap, { horizonWeeks: h, diffThreshold: df, avoidExtremes: false });
    grid.push({ horizon: h, diff: df, n: r.n, wr: r.wr, pf: r.pf, avg: r.avg });
  }
  const valid = grid.filter((g) => g.n >= BT_MIN_TRADES && g.pf != null && isFinite(g.pf));
  const best = valid.slice().sort((a, b) => b.pf - a.pf)[0] || grid.slice().sort((a, b) => b.n - a.n)[0];
  let extremeCompare = null, byPairBest = null;
  if (best) {
    const off = runCOTBacktest(series, weeks, pctMap, { horizonWeeks: best.horizon, diffThreshold: best.diff, avoidExtremes: false });
    const on = runCOTBacktest(series, weeks, pctMap, { horizonWeeks: best.horizon, diffThreshold: best.diff, avoidExtremes: true });
    extremeCompare = { off: aggregate(off.trades || (function () { const t = []; Object.values(off.byPair).forEach((a) => t.push(...a)); return t; })()), on: aggregate((function () { const t = []; Object.values(on.byPair).forEach((a) => t.push(...a)); return t; })()) };
    byPairBest = Object.fromEntries(Object.entries(off.byPair).map(([p, trades]) => [p, aggregate(trades)]).sort((a, b) => (b[1].pf || 0) - (a[1].pf || 0)));
  }
  return { grid, best, extremeCompare, byPairBest, pctMap, weeksUsed: dates.length, dateFrom: dates[0], dateTo: dates.at(-1) };
}

(async () => {
  let cotHist;
  try { cotHist = JSON.parse(fs.readFileSync("data/cot_hist.json", "utf8")); }
  catch (e) { throw new Error("data/cot_hist.json nenalezen/nečitelný: " + e.message); }
  const weeks = cotHist.weeks || {};
  const dates = Object.keys(weeks).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (dates.length < BT_MIN_TRADES) throw new Error("Málo COT týdnů pro backtest: " + dates.length);

  const startDate = dates[0];
  const endDate = new Date().toISOString().slice(0, 10);
  console.log(`Stahuji historické kurzy ${startDate} → ${endDate}…`);
  const ratesByDate = await fetchHistoricalRates(startDate, endDate);
  const series = buildSeries(ratesByDate);
  console.log(`Kurzy: ${Object.keys(ratesByDate).length} obchodních dní.`);

  const res = runSweep(series, weeks);
  if (!res.best) throw new Error("Backtest nevrátil žádný validní výsledek (nedostatek dat?).");
  const maturity = runMaturityTest(series, weeks, res.pctMap);

  const summary = `COT backtest ${res.dateFrom} → ${res.dateTo} (${res.weeksUsed} týdnů, ${STANDARD_PAIRS.length} párů). ` +
    `Nejlepší nastavení: |diff| ≥ ${res.best.diff}, horizont ${res.best.horizon}t → WR ${res.best.wr}%, PF ${res.best.pf === Infinity ? "∞" : res.best.pf}, ` +
    `průměr ${res.best.avg > 0 ? "+" : ""}${res.best.avg}%/obchod, n=${res.best.n}.`;
  console.log(summary);
  const m1 = maturity.h1;
  console.log(`Zralost pozicování (1t): fresh WR ${m1.fresh.wr}%/PF ${m1.fresh.pf} (n=${m1.fresh.n}) · maturing WR ${m1.maturing.wr}%/PF ${m1.maturing.pf} (n=${m1.maturing.n}) · aging WR ${m1.aging.wr}%/PF ${m1.aging.pf} (n=${m1.aging.n})`);

  const out = {
    updated: new Date().toISOString(),
    source: "Frankfurter (ECB) denní kurzy × CFTC TFF COT historie",
    dateFrom: res.dateFrom, dateTo: res.dateTo, weeksUsed: res.weeksUsed, pairsUsed: STANDARD_PAIRS.length,
    grid: res.grid, best: res.best, extremeCompare: res.extremeCompare, byPairBest: res.byPairBest,
    maturityTest: maturity,
    summary,
  };

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync("data/calibration.json", "utf8")); } catch (e) {}
  const same = prev && JSON.stringify(prev.grid) === JSON.stringify(out.grid) && JSON.stringify(prev.best) === JSON.stringify(out.best)
    && JSON.stringify(prev.maturityTest) === JSON.stringify(out.maturityTest);
  if (same) { console.log("Kalibrace beze změny, nepřepisuji."); process.exit(0); }

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/calibration.json", JSON.stringify(out));
  console.log("OK · zapsáno data/calibration.json");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

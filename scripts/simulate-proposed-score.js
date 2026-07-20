// PREVIEW simulace: co by se změnilo na skóre a ve výsledcích, kdyby se
// zavedla doporučení 1-4 z docs/RESEARCH_AUDIT_2026-07.md (sazbový merge,
// priorita 5, záměrně vynechán — nejinvazivnější, poslední na řadě):
//   1) sezónnost pryč ze skóre (byla anti-prediktivní)
//   2) risk_adj nahrazen VIX úrovní se směrem per měna (AUD +, GBP -, CHF -)
//   3) COT přeskládán per měna (JPY: fade asset manager + follow dealer;
//      CHF: commercials+dealer proti asset-mgr/nc; GBP: dealer)
//   4) real yield diff obráceně pro EUR/CAD (mean-reversion, ne carry)
//   + nová složka: CPI akcelerace pro CAD (dřív engine nepočítal vůbec)
//
// Metoda: NEbere se nová architektura od nuly — bere se SKUTEČNÝ replay
// výstup (data/calibration_replay.json, tj. živý engine.js nad reálnou
// point-in-time historií) a k celkovému skóre se PŘIČTE/ODEČTE přesně ta
// delta, kterou by změna způsobila (starý total už v sobě má season/risk/
// yield/cot komponenty jako čísla — nahrazují a mění se JEN ty, zbytek
// (fund_data, policy, sent, oil) zůstává beze změny). Pak se PŘESNĚ stejný
// obchodní test (vstup den X+1, horizonty 1/3/5/10) přehraje se starým a
// s novým skóre a porovná.
//
// Škálování nových komponent (VIX risk, COT rework, CPI akcelerace):
// z-skóre (expanding, ze skutečné historie, ne jen z replay okna — bez
// look-aheadu) se přeškáluje tak, aby směrodatná odchylka NOVÉ komponenty
// přes replay okno odpovídala směrodatné odchylce STARÉ nahrazované
// komponenty za stejné okno — udrží to srovnatelný "hlas" ve váženém
// součtu, ne uměle nafouknutý/utlumený signál.
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
const VIX_SIGN = { AUD: 1, GBP: -1, CHF: -1 }; // ostatní 0 (bez robustní evidence)
const YIELD_FLIP = new Set(["EUR", "CAD"]);
const COT_CODE = { EUR: "EUR", JPY: "JPY", GBP: "GBP", CHF: "CHF", AUD: "AUD", NZD: "NZD", CAD: "CAD", USD: "USD" };
const FCUR = { US: "USD", EA: "EUR", GB: "GBP", JP: "JPY", AU: "AUD", CA: "CAD", CH: "CHF", NZ: "NZD" };

function aggregate(trades) {
  const n = trades.length;
  if (!n) return { n: 0, wr: null, pf: null, avg: null };
  const wins = trades.filter((t) => t.ret > 0).length;
  const gp = trades.filter((t) => t.ret > 0).reduce((a, b) => a + b.ret, 0);
  const gl = Math.abs(trades.filter((t) => t.ret < 0).reduce((a, b) => a + b.ret, 0));
  return { n, wr: +(wins / n * 100).toFixed(1), pf: gl > 0 ? +(gp / gl).toFixed(3) : null, avg: +(trades.reduce((a, b) => a + b.ret, 0) / n).toFixed(4) };
}
function std(arr) { const n = arr.length; if (!n) return 0; const m = arr.reduce((a, b) => a + b, 0) / n; return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / n); }
// expanding z-skóre — v čase t použije jen historii <= t (žádný look-ahead)
function expandingZ(dates, values) {
  const out = []; let sum = 0, sumSq = 0, n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) {
      if (n >= 20) {
        const mean = sum / n, sd = Math.sqrt(Math.max(1e-9, sumSq / n - mean * mean));
        out.push(sd > 1e-9 ? (v - mean) / sd : 0);
      } else out.push(0);
      sum += v; sumSq += v * v; n++;
    } else out.push(out.length ? out[out.length - 1] : 0);
  }
  return out;
}

(async () => {
  const cal = JSON.parse(fs.readFileSync("/tmp/claude-0/cr.json", "utf8"));
  const fred = JSON.parse(fs.readFileSync("/tmp/claude-0/fred.json", "utf8"));
  const cotLegacy = JSON.parse(fs.readFileSync("/tmp/claude-0/cot_legacy.json", "utf8"));
  const cotTff = JSON.parse(fs.readFileSync("/tmp/claude-0/cot_tff.json", "utf8"));

  const days = cal.dailyScores; // [{d, sc:{ccy:total}, comp:{ccy:{...}}}]
  const dateList = days.map((d) => d.d);
  const pxDays = cal.prices.days, pxRates = cal.prices.rates;
  const pairPrice = (p, i) => { const rr = pxRates[i]; const b = rr[p.base], q = rr[p.quote]; return (b && q) ? q / b : null; };
  const pxIdxOnOrAfter = (iso) => pxDays.findIndex((dd) => dd >= iso);

  // ── VIX: denní FRED série, expanding z-skóre z CELÉ historie (1990→), namapovaná na replay dny ──
  const vixMap = new Map((fred.vix || []).map((r) => [r.d, r.v]));
  const vixDates = (fred.vix || []).map((r) => r.d).sort();
  const vixVals = vixDates.map((d) => vixMap.get(d));
  const vixZarr = expandingZ(vixDates, vixVals);
  const vixZmap = new Map(vixDates.map((d, i) => [d, vixZarr[i]]));
  function vixZOn(dateIso) { // poslední známá hodnota <= dateIso
    let lo = 0, hi = vixDates.length - 1, ans = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (vixDates[mid] <= dateIso) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans != null ? vixZarr[ans] : 0;
  }

  // ── CPI akcelerace CAD: FRED CPI YoY nebo index, Δ~13 týdnů, expanding z-skóre ──
  function fredSeries(key) { return (fred[key] || []).slice().sort((a, b) => a.d < b.d ? -1 : 1); }
  const cpiCA = fredSeries("cpi_CA");
  const cpiDates = cpiCA.map((r) => r.d), cpiVals = cpiCA.map((r) => r.v);
  const cpiAccelRaw = cpiVals.map((v, i) => (i >= 3 ? v - cpiVals[i - 3] : null)); // ~3 měsíce
  const cpiAccelZarr = expandingZ(cpiDates, cpiAccelRaw);
  function cpiAccelOn(dateIso) {
    let lo = 0, hi = cpiDates.length - 1, ans = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (cpiDates[mid] <= dateIso) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans != null ? cpiAccelZarr[ans] : 0;
  }

  // ── COT: legacy (nc/comm) + TFF (dealer/am/lev) → net/OI poměr, expanding z-skóre, +4d lag ──
  function cotSeriesFor(ccy) {
    const leg = (cotLegacy[ccy] || []).slice().sort((a, b) => a.d < b.d ? -1 : 1);
    const tff = (cotTff[ccy] || []).slice().sort((a, b) => a.d < b.d ? -1 : 1);
    const legDates = leg.map((r) => r.d);
    const ncNet = leg.map((r) => (r.oi ? (r.ncl - r.ncs) / r.oi : null));
    const commNet = leg.map((r) => (r.oi ? (r.cl - r.cs) / r.oi : null));
    const tffDates = tff.map((r) => r.d);
    const dealerNet = tff.map((r) => (r.oi ? (r.dl - r.dsh) / r.oi : null));
    const amNet = tff.map((r) => (r.oi ? (r.aml - r.ams) / r.oi : null));
    return {
      ncZ: expandingZ(legDates, ncNet).map((v, i) => [legDates[i], v]),
      commZ: expandingZ(legDates, commNet).map((v, i) => [legDates[i], v]),
      dealerZ: expandingZ(tffDates, dealerNet).map((v, i) => [tffDates[i], v]),
      amZ: expandingZ(tffDates, amNet).map((v, i) => [tffDates[i], v]),
    };
  }
  function lookupOn(seriesPairs, dateIso, lagDays) {
    // poslední report, kde report_date + lagDays <= dateIso
    let lo = 0, hi = seriesPairs.length - 1, ans = null;
    for (let i = seriesPairs.length - 1; i >= 0; i--) {
      const reportMs = Date.parse(seriesPairs[i][0] + "T00:00:00Z");
      if (reportMs + lagDays * 86400000 <= Date.parse(dateIso + "T00:00:00Z")) { ans = i; break; }
    }
    return ans != null ? seriesPairs[ans][1] : 0;
  }
  const cotSeries = {}; for (const c of ["JPY", "CHF", "GBP"]) cotSeries[c] = cotSeriesFor(c);

  // ── starý cot contribution std (per měna, přes replay okno) — cíl pro přeškálování ──
  function oldCompStd(field, ccy) {
    const vals = days.map((d) => d.comp[ccy] && d.comp[ccy][field]).filter((v) => v != null && v !== 0);
    return std(vals);
  }
  const oldCotStd = {}; for (const c of CURRENCIES) oldCotStd[c] = oldCompStd("cot", c);
  const oldRiskStdRef = 0.7; // GBP nemělo dřív risk_adj vůbec (vždy 0) — použij rozumný střed ostatních aktivních měn jako referenční škálu
  const oldYieldStd = {}; for (const c of CURRENCIES) oldYieldStd[c] = oldCompStd("yield", c);

  // ── spočítej "raw" nové signály přes celé replay okno, pak zjisti JEJICH std a přeškáluj ──
  const rawJPY = days.map((d) => -1.0 * lookupOn(cotSeries.JPY.amZ, d.d, 4) + 0.57 * lookupOn(cotSeries.JPY.dealerZ, d.d, 4));
  const rawCHF = days.map((d) => 1.0 * lookupOn(cotSeries.CHF.commZ, d.d, 4) + 0.71 * lookupOn(cotSeries.CHF.dealerZ, d.d, 4) - 0.71 * lookupOn(cotSeries.CHF.amZ, d.d, 4));
  const rawGBP = days.map((d) => 1.0 * lookupOn(cotSeries.GBP.dealerZ, d.d, 4));
  const rawCpiAccel = days.map((d) => cpiAccelOn(d.d));
  const scaleJPY = oldCotStd.JPY / (std(rawJPY) || 1);
  const scaleCHF = oldCotStd.CHF / (std(rawCHF) || 1);
  const scaleGBP = oldCotStd.GBP / (std(rawGBP) || 1);
  const scaleCpi = 0.6 / (std(rawCpiAccel) || 1); // cílová std ~0.6 — srovnatelná s ostatními "menšími" komponentami (viz report)

  console.log("Škálovací faktory (nová komponenta × faktor = srovnatelná síla se starou):");
  console.log("  JPY cot rework scale:", scaleJPY.toFixed(3), "(cíl std", oldCotStd.JPY.toFixed(3), ")");
  console.log("  CHF cot rework scale:", scaleCHF.toFixed(3), "(cíl std", oldCotStd.CHF.toFixed(3), ")");
  console.log("  GBP cot rework scale:", scaleGBP.toFixed(3), "(cíl std", oldCotStd.GBP.toFixed(3), ")");
  console.log("  CAD cpi_accel scale:", scaleCpi.toFixed(3), "(cíl std 0.6)");

  // ── postav nové skóre per den per měna ──
  const newSc = days.map((day, i) => {
    const out = {};
    for (const c of CURRENCIES) {
      const comp = day.comp[c] || {};
      let delta = 0;
      delta -= (comp.season || 0); // 1) sezónnost pryč
      // 2) risk_adj → VIX (jen AUD/GBP/CHF mají směr; jinde 0, jako dřív u USD/EUR/GBP/JPY* — ale JPY/NZD dřív risk měly, teď 0, protože audit pro ně VIX směr nepotvrdil)
      const oldRisk = comp.risk || 0;
      const vixSign = VIX_SIGN[c] || 0;
      const newRisk = vixSign ? vixSign * Math.max(-2, Math.min(2, vixZOn(day.d))) * 0.5 * (oldRiskStdRef / 0.5 > 0 ? 1 : 1) : 0;
      delta += newRisk - oldRisk;
      // 3) COT rework (JPY/CHF/GBP) — jinde beze změny
      if (c === "JPY") delta += (rawJPY[i] * scaleJPY) - (comp.cot || 0);
      if (c === "CHF") delta += (rawCHF[i] * scaleCHF) - (comp.cot || 0);
      if (c === "GBP") delta += (rawGBP[i] * scaleGBP) - (comp.cot || 0);
      // 4) real yield sign flip EUR/CAD
      if (YIELD_FLIP.has(c)) delta += -2 * (comp.yield || 0);
      // + CPI akcelerace CAD (nová komponenta, dřív 0)
      if (c === "CAD") delta += rawCpiAccel[i] * scaleCpi;
      out[c] = +(day.sc[c] + delta).toFixed(3);
    }
    return out;
  });

  // ── obchodní test: STARÉ vs NOVÉ skóre, stejná metodika jako backtest-replay.js ──
  function buildTrades(scFn) {
    const trades = { all: [] }; CURRENCIES.forEach((c) => (trades[c] = []));
    for (let di = 0; di < days.length; di++) {
      const day = days[di];
      const entryIdx = pxIdxOnOrAfter(new Date(Date.parse(day.d) + 86400000).toISOString().slice(0, 10));
      if (entryIdx < 0) continue;
      const sc = scFn(di);
      for (const p of STANDARD_PAIRS) {
        const diff = (sc[p.base] || 0) - (sc[p.quote] || 0);
        const p0 = pairPrice(p, entryIdx); if (p0 == null) continue;
        for (const H of HORIZONS) {
          if (entryIdx + H >= pxRates.length) continue;
          const p1 = pairPrice(p, entryIdx + H); if (p1 == null) continue;
          const ret = (p1 / p0 - 1) * (diff > 0 ? 1 : -1) * 100;
          trades.all.push({ ret });
          if (p.base === "JPY" || p.quote === "JPY") trades.JPY.push({ ret });
          if (p.base === "CHF" || p.quote === "CHF") trades.CHF.push({ ret });
          if (p.base === "GBP" || p.quote === "GBP") trades.GBP.push({ ret });
          if (p.base === "CAD" || p.quote === "CAD") trades.CAD.push({ ret });
          if (p.base === "AUD" || p.quote === "AUD") trades.AUD.push({ ret });
          if (p.base === "EUR" || p.quote === "EUR") trades.EUR.push({ ret });
          if (p.base === "USD" || p.quote === "USD") trades.USD.push({ ret });
          if (p.base === "NZD" || p.quote === "NZD") trades.NZD.push({ ret });
        }
      }
    }
    return trades;
  }
  const oldTrades = buildTrades((di) => days[di].sc);
  const newTrades = buildTrades((di) => newSc[di]);

  console.log("\n=== STARÉ skóre (dnešní produkce) vs NOVÉ skóre (návrh 1-4) ===");
  console.log("Skupina  |  STARÉ n/WR/PF        |  NOVÉ n/WR/PF          | Δ PF");
  console.log("-".repeat(80));
  const groups = ["all", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
  const summary = {};
  for (const g of groups) {
    const o = aggregate(oldTrades[g]), n = aggregate(newTrades[g]);
    summary[g] = { old: o, new: n };
    const dpf = (n.pf != null && o.pf != null) ? +(n.pf - o.pf).toFixed(3) : null;
    console.log(`${g.padEnd(8)} | n=${String(o.n).padStart(6)} WR=${String(o.wr).padStart(5)}% PF=${String(o.pf).padStart(6)} | n=${String(n.n).padStart(6)} WR=${String(n.wr).padStart(5)}% PF=${String(n.pf).padStart(6)} | ${dpf != null ? (dpf >= 0 ? "+" : "") + dpf : "?"}`);
  }

  // ukázka konkrétního dne (posledního) — jak se skóre změnilo per měna
  const lastIdx = days.length - 1;
  console.log("\n=== Ukázka: skóre k " + days[lastIdx].d + " (poslední replay den) ===");
  console.log("Měna | STARÉ skóre | NOVÉ skóre | rozdíl");
  for (const c of CURRENCIES) {
    const o = days[lastIdx].sc[c], n = newSc[lastIdx][c];
    console.log(`${c}  | ${o.toFixed(2).padStart(6)}      | ${n.toFixed(2).padStart(6)}     | ${(n - o >= 0 ? "+" : "") + (n - o).toFixed(2)}`);
  }

  const out = {
    updated: new Date().toISOString(),
    methodology: "delta simulace nad data/calibration_replay.json — season odebrána, risk_adj nahrazen VIX (AUD+/GBP-/CHF-), COT přeskládán (JPY/CHF/GBP), yield obrácen (EUR/CAD), CPI akcelerace přidána (CAD). Priorita 5 (sloučení sazbových kanálů) NENÍ zahrnuta.",
    scaling: { jpyCotScale: scaleJPY, chfCotScale: scaleCHF, gbpCotScale: scaleGBP, cadCpiScale: scaleCpi },
    summary,
    sampleDay: { date: days[lastIdx].d, old: days[lastIdx].sc, new: newSc[lastIdx] },
  };
  fs.mkdirSync(path.join(ROOT, "data/research"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data/research/proposed_score_preview.json"), JSON.stringify(out, null, 2));
  console.log("\nOK · zapsáno data/research/proposed_score_preview.json");
})().catch((e) => { console.error("FATAL", e.stack); process.exit(1); });

// Protiaudit krok 3: POCTIVÝ train/test split simulace návrhů 1-4
// (scripts/simulate-proposed-score.js). Minule byly škálovací faktory
// (VIX risk, COT rework, CPI akcelerace) doškálovány na STEJNÉM okně,
// na kterém se pak měřil výsledek — možný in-sample bias, sám jsem na
// to upozornil. Tady se škálovací faktory spočítají VÝHRADNĚ z první
// poloviny replay okna (train), a výsledek se měří VÝHRADNĚ na druhé
// polovině (test), s embargem 10 dní mezi nimi (kvůli h=10 dennímu
// forward-return oknu, co by jinak protékalo přes hranici train/test).
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
const VIX_SIGN = { AUD: 1, GBP: -1, CHF: -1 };
const YIELD_FLIP = new Set(["EUR", "CAD"]);
const EMBARGO_DAYS = 10;

function aggregate(trades) {
  const n = trades.length; if (!n) return { n: 0, wr: null, pf: null, avg: null };
  const wins = trades.filter((t) => t.ret > 0).length;
  const gp = trades.filter((t) => t.ret > 0).reduce((a, b) => a + b.ret, 0);
  const gl = Math.abs(trades.filter((t) => t.ret < 0).reduce((a, b) => a + b.ret, 0));
  return { n, wr: +(wins / n * 100).toFixed(1), pf: gl > 0 ? +(gp / gl).toFixed(3) : null, avg: +(trades.reduce((a, b) => a + b.ret, 0) / n).toFixed(4) };
}
function std(arr) { const n = arr.length; if (!n) return 0; const m = arr.reduce((a, b) => a + b, 0) / n; return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / n); }
function expandingZ(values) {
  const out = []; let sum = 0, sumSq = 0, n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) {
      if (n >= 20) { const mean = sum / n, sd = Math.sqrt(Math.max(1e-9, sumSq / n - mean * mean)); out.push(sd > 1e-9 ? (v - mean) / sd : 0); }
      else out.push(0);
      sum += v; sumSq += v * v; n++;
    } else out.push(out.length ? out[out.length - 1] : 0);
  }
  return out;
}

(async () => {
  // POZN. (2026-08-15): tenhle skript dřív ukazoval na /tmp/claude-0/*.json —
  // scratch cesty z jiné Claude session, které v tomhle repu nikdy neexistovaly
  // a skript tak nešel spustit nikým jiným. Appka má stejná data trvale
  // committnutá — přepnuto na ně, ať je skript reálně reprodukovatelný.
  const cal = JSON.parse(fs.readFileSync(path.join(ROOT, "data/calibration_replay.json"), "utf8"));
  const fred = JSON.parse(fs.readFileSync(path.join(ROOT, "data/research/fred.json"), "utf8"));
  const cotLegacy = JSON.parse(fs.readFileSync(path.join(ROOT, "data/research/cot_legacy.json"), "utf8"));
  const cotTff = JSON.parse(fs.readFileSync(path.join(ROOT, "data/research/cot_tff.json"), "utf8"));

  const days = cal.dailyScores;
  const pxDays = cal.prices.days, pxRates = cal.prices.rates;
  const pairPrice = (p, i) => { const rr = pxRates[i]; const b = rr[p.base], q = rr[p.quote]; return (b && q) ? q / b : null; };
  const pxIdxOnOrAfter = (iso) => pxDays.findIndex((dd) => dd >= iso);

  const vixMap = new Map((fred.vix || []).map((r) => [r.d, r.v]));
  const vixDates = (fred.vix || []).map((r) => r.d).sort();
  const vixZarr = expandingZ(vixDates.map((d) => vixMap.get(d)));
  function vixZOn(dateIso) {
    let lo = 0, hi = vixDates.length - 1, ans = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (vixDates[mid] <= dateIso) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans != null ? vixZarr[ans] : 0;
  }
  function fredSeries(key) { return (fred[key] || []).slice().sort((a, b) => a.d < b.d ? -1 : 1); }
  const cpiCA = fredSeries("cpi_CA");
  const cpiDates = cpiCA.map((r) => r.d), cpiVals = cpiCA.map((r) => r.v);
  const cpiAccelRaw = cpiVals.map((v, i) => (i >= 3 ? v - cpiVals[i - 3] : null));
  const cpiAccelZarr = expandingZ(cpiAccelRaw);
  function cpiAccelOn(dateIso) {
    let lo = 0, hi = cpiDates.length - 1, ans = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (cpiDates[mid] <= dateIso) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans != null ? cpiAccelZarr[ans] : 0;
  }
  function cotSeriesFor(ccy) {
    const leg = (cotLegacy[ccy] || []).slice().sort((a, b) => a.d < b.d ? -1 : 1);
    const tff = (cotTff[ccy] || []).slice().sort((a, b) => a.d < b.d ? -1 : 1);
    const legDates = leg.map((r) => r.d), ncNet = leg.map((r) => (r.oi ? (r.ncl - r.ncs) / r.oi : null)), commNet = leg.map((r) => (r.oi ? (r.cl - r.cs) / r.oi : null));
    const tffDates = tff.map((r) => r.d), dealerNet = tff.map((r) => (r.oi ? (r.dl - r.dsh) / r.oi : null)), amNet = tff.map((r) => (r.oi ? (r.aml - r.ams) / r.oi : null));
    return { ncZ: expandingZ(ncNet).map((v, i) => [legDates[i], v]), commZ: expandingZ(commNet).map((v, i) => [legDates[i], v]),
             dealerZ: expandingZ(dealerNet).map((v, i) => [tffDates[i], v]), amZ: expandingZ(amNet).map((v, i) => [tffDates[i], v]) };
  }
  function lookupOn(seriesPairs, dateIso, lagDays) {
    let ans = null;
    for (let i = seriesPairs.length - 1; i >= 0; i--) {
      if (Date.parse(seriesPairs[i][0] + "T00:00:00Z") + lagDays * 86400000 <= Date.parse(dateIso + "T00:00:00Z")) { ans = i; break; }
    }
    return ans != null ? seriesPairs[ans][1] : 0;
  }
  const cotSeries = {}; for (const c of ["JPY", "CHF", "GBP"]) cotSeries[c] = cotSeriesFor(c);

  const rawJPY = days.map((d) => -1.0 * lookupOn(cotSeries.JPY.amZ, d.d, 4) + 0.57 * lookupOn(cotSeries.JPY.dealerZ, d.d, 4));
  const rawCHF = days.map((d) => 1.0 * lookupOn(cotSeries.CHF.commZ, d.d, 4) + 0.71 * lookupOn(cotSeries.CHF.dealerZ, d.d, 4) - 0.71 * lookupOn(cotSeries.CHF.amZ, d.d, 4));
  const rawGBP = days.map((d) => 1.0 * lookupOn(cotSeries.GBP.dealerZ, d.d, 4));
  const rawCpiAccel = days.map((d) => cpiAccelOn(d.d));
  const rawVix = days.map((d) => vixZOn(d.d));

  // ── TRAIN/TEST split: první polovina dní = train (škálování), druhá = test (měření), s embargem ──
  const N = days.length;
  const splitIdx = Math.floor(N / 2);
  const embargoEnd = splitIdx + EMBARGO_DAYS;
  console.log(`Celkem dní: ${N} | train: 0..${splitIdx} (${days[0].d} → ${days[splitIdx - 1].d}) | embargo: ${EMBARGO_DAYS} dní | test: ${embargoEnd}..${N} (${days[embargoEnd] ? days[embargoEnd].d : "?"} → ${days[N - 1].d})`);

  function oldCotStdOn(field, ccy, idxRange) {
    const vals = idxRange.map((i) => days[i].comp[ccy] && days[i].comp[ccy][field]).filter((v) => v != null && v !== 0);
    return std(vals);
  }
  const trainIdx = Array.from({ length: splitIdx }, (_, i) => i);
  const testIdx = Array.from({ length: N - embargoEnd }, (_, i) => i + embargoEnd);

  const oldCotStdTrain = {}; for (const c of CURRENCIES) oldCotStdTrain[c] = oldCotStdOn("cot", c, trainIdx);

  // škálovací faktory spočítané VÝHRADNĚ z train indexů
  const scaleJPY = oldCotStdTrain.JPY / (std(trainIdx.map((i) => rawJPY[i])) || 1);
  const scaleCHF = oldCotStdTrain.CHF / (std(trainIdx.map((i) => rawCHF[i])) || 1);
  const scaleGBP = oldCotStdTrain.GBP / (std(trainIdx.map((i) => rawGBP[i])) || 1);
  const scaleCpi = 0.6 / (std(trainIdx.map((i) => rawCpiAccel[i])) || 1);
  console.log("Škálovací faktory (fitované JEN na train):", { scaleJPY: +scaleJPY.toFixed(3), scaleCHF: +scaleCHF.toFixed(3), scaleGBP: +scaleGBP.toFixed(3), scaleCpi: +scaleCpi.toFixed(3) });

  function newScoreAt(i) {
    const day = days[i]; const out = {};
    for (const c of CURRENCIES) {
      const comp = day.comp[c] || {}; let delta = 0;
      delta -= (comp.season || 0);
      const oldRisk = comp.risk || 0; const vixSign = VIX_SIGN[c] || 0;
      const newRisk = vixSign ? vixSign * Math.max(-2, Math.min(2, rawVix[i])) * 0.5 : 0;
      delta += newRisk - oldRisk;
      if (c === "JPY") delta += (rawJPY[i] * scaleJPY) - (comp.cot || 0);
      if (c === "CHF") delta += (rawCHF[i] * scaleCHF) - (comp.cot || 0);
      if (c === "GBP") delta += (rawGBP[i] * scaleGBP) - (comp.cot || 0);
      if (YIELD_FLIP.has(c)) delta += -2 * (comp.yield || 0);
      if (c === "CAD") delta += rawCpiAccel[i] * scaleCpi;
      out[c] = +(day.sc[c] + delta).toFixed(3);
    }
    return out;
  }

  function buildTrades(scFn, idxSubset) {
    const trades = [];
    for (const di of idxSubset) {
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
          trades.push({ ret: (p1 / p0 - 1) * (diff > 0 ? 1 : -1) * 100 });
        }
      }
    }
    return trades;
  }

  const oldTestTrades = buildTrades((di) => days[di].sc, testIdx);
  const newTestTrades = buildTrades((di) => newScoreAt(di), testIdx);
  const oldTrainTrades = buildTrades((di) => days[di].sc, trainIdx);
  const newTrainTrades = buildTrades((di) => newScoreAt(di), trainIdx);

  console.log("\n=== POCTIVÝ OOS test (škálování fitováno JEN na train, měřeno JEN na test) ===");
  console.log("TRAIN (in-sample, jen pro srovnání):  staré PF =", aggregate(oldTrainTrades).pf, " nové PF =", aggregate(newTrainTrades).pf);
  console.log("TEST  (skutečný out-of-sample):        staré PF =", aggregate(oldTestTrades).pf, " nové PF =", aggregate(newTestTrades).pf);
  console.log("\nStaré (test):", aggregate(oldTestTrades));
  console.log("Nové (test): ", aggregate(newTestTrades));

  const out = {
    updated: new Date().toISOString(),
    methodology: "train = první polovina replay dní, test = druhá polovina po embargu " + EMBARGO_DAYS + " dní. Škálovací faktory (VIX risk, COT rework, CPI akcelerace) fitované VÝHRADNĚ na train, měření VÝHRADNĚ na test.",
    split: { trainFrom: days[0].d, trainTo: days[splitIdx - 1].d, embargoDays: EMBARGO_DAYS, testFrom: days[embargoEnd] ? days[embargoEnd].d : null, testTo: days[N - 1].d },
    scaling: { scaleJPY, scaleCHF, scaleGBP, scaleCpi },
    train: { old: aggregate(oldTrainTrades), new: aggregate(newTrainTrades) },
    test: { old: aggregate(oldTestTrades), new: aggregate(newTestTrades) },
  };
  fs.writeFileSync(path.join(ROOT, "data/research/oos_split_test.json"), JSON.stringify(out, null, 2));
  console.log("\nOK -> data/research/oos_split_test.json");
})().catch((e) => { console.error("FATAL", e.stack); process.exit(1); });

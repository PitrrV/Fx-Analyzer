// Kolik z OOS zlepšení (PF 0.875->1.029) přežije REALISTICKÉ náklady
// (spread + swap)? Dosavadní PF čísla byla vždy hrubá (mid-price), tohle
// je první test s náklady odečtenými. Konzervativní odhad spreadů (pipy)
// a swapu (typický retail broker, ne institucionální).
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
// Konzervativní round-trip náklad jako % z ceny — majors ~1.5 pipu spread
// (round-trip = 1x, ne 2x, protože vstup i výstup nese jen poloviční spread
// v market-order modelu), kříže/exoti širší. Swap: ~-0.5 až -1.5% p.a. na
// typickou pozici při držení přes noc, tj. cca 0.003-0.02%/den podle páru
// (zjednodušeno na plochou přirážku dle horizontu).
const SPREAD_PCT = {
  EURUSD: 0.00015, USDJPY: 0.00015, GBPUSD: 0.0002, AUDUSD: 0.0002, USDCAD: 0.0002, USDCHF: 0.0002, NZDUSD: 0.00025,
  EURGBP: 0.0002, EURCHF: 0.00025, EURAUD: 0.0003, EURCAD: 0.0003, EURJPY: 0.0002, EURNZD: 0.00035,
  GBPCHF: 0.0003, GBPJPY: 0.00025, GBPAUD: 0.00035, GBPCAD: 0.00035, GBPNZD: 0.0004,
  AUDCAD: 0.0003, AUDJPY: 0.00025, AUDNZD: 0.00035, AUDCHF: 0.0003,
  NZDCAD: 0.00035, NZDJPY: 0.0003, NZDCHF: 0.00035, CADJPY: 0.00025, CADCHF: 0.0003, CHFJPY: 0.0003,
};
const SWAP_PCT_PER_DAY = 0.00008; // ~0.008%/den plochý odhad (drobná, ale nenulová přirážka)

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
  const cal = JSON.parse(fs.readFileSync("/tmp/claude-0/cr.json", "utf8"));
  const fred = JSON.parse(fs.readFileSync("/tmp/claude-0/fred.json", "utf8"));
  const cotLegacy = JSON.parse(fs.readFileSync("/tmp/claude-0/cot_legacy.json", "utf8"));
  const cotTff = JSON.parse(fs.readFileSync("/tmp/claude-0/cot_tff.json", "utf8"));
  const days = cal.dailyScores;
  const pxDays = cal.prices.days, pxRates = cal.prices.rates;
  const pairPrice = (p, i) => { const rr = pxRates[i]; const b = rr[p.base], q = rr[p.quote]; return (b && q) ? q / b : null; };
  const pxIdxOnOrAfter = (iso) => pxDays.findIndex((dd) => dd >= iso);

  const vixMap = new Map((fred.vix || []).map((r) => [r.d, r.v]));
  const vixDates = (fred.vix || []).map((r) => r.d).sort();
  const vixZarr = expandingZ(vixDates.map((d) => vixMap.get(d)));
  function vixZOn(dateIso) { let lo=0,hi=vixDates.length-1,ans=null; while(lo<=hi){const mid=(lo+hi)>>1; if(vixDates[mid]<=dateIso){ans=mid;lo=mid+1;}else hi=mid-1;} return ans!=null?vixZarr[ans]:0; }
  function fredSeries(key) { return (fred[key] || []).slice().sort((a, b) => a.d < b.d ? -1 : 1); }
  const cpiCA = fredSeries("cpi_CA");
  const cpiDates = cpiCA.map((r) => r.d), cpiVals = cpiCA.map((r) => r.v);
  const cpiAccelRaw = cpiVals.map((v, i) => (i >= 3 ? v - cpiVals[i - 3] : null));
  const cpiAccelZarr = expandingZ(cpiAccelRaw);
  function cpiAccelOn(dateIso) { let lo=0,hi=cpiDates.length-1,ans=null; while(lo<=hi){const mid=(lo+hi)>>1; if(cpiDates[mid]<=dateIso){ans=mid;lo=mid+1;}else hi=mid-1;} return ans!=null?cpiAccelZarr[ans]:0; }
  function cotSeriesFor(ccy) {
    const leg=(cotLegacy[ccy]||[]).slice().sort((a,b)=>a.d<b.d?-1:1), tff=(cotTff[ccy]||[]).slice().sort((a,b)=>a.d<b.d?-1:1);
    const legDates=leg.map(r=>r.d), ncNet=leg.map(r=>r.oi?(r.ncl-r.ncs)/r.oi:null), commNet=leg.map(r=>r.oi?(r.cl-r.cs)/r.oi:null);
    const tffDates=tff.map(r=>r.d), dealerNet=tff.map(r=>r.oi?(r.dl-r.dsh)/r.oi:null), amNet=tff.map(r=>r.oi?(r.aml-r.ams)/r.oi:null);
    return {commZ:expandingZ(commNet).map((v,i)=>[legDates[i],v]), dealerZ:expandingZ(dealerNet).map((v,i)=>[tffDates[i],v]), amZ:expandingZ(amNet).map((v,i)=>[tffDates[i],v])};
  }
  function lookupOn(seriesPairs, dateIso, lagDays) {
    let ans=null;
    for (let i=seriesPairs.length-1;i>=0;i--) { if (Date.parse(seriesPairs[i][0]+"T00:00:00Z")+lagDays*86400000 <= Date.parse(dateIso+"T00:00:00Z")) { ans=i; break; } }
    return ans!=null?seriesPairs[ans][1]:0;
  }
  const cotSeries = {}; for (const c of ["JPY","CHF"]) cotSeries[c] = cotSeriesFor(c);
  // GBP dealer VYŘAZEN (protiaudit) — jen JPY (am+dealer) a CHF (comm+dealer-am), per finální doporučení
  const rawJPY = days.map((d) => -1.0*lookupOn(cotSeries.JPY.amZ,d.d,4) + 0.57*lookupOn(cotSeries.JPY.dealerZ,d.d,4));
  const rawCHF = days.map((d) => 1.0*lookupOn(cotSeries.CHF.commZ,d.d,4)); // JEN commercials (dealer/AM vyřazeny jako nestabilní)
  const rawCpiAccel = days.map((d) => cpiAccelOn(d.d));
  const rawVix = days.map((d) => vixZOn(d.d));

  function oldCotStd(field, ccy) { const vals = days.map(d=>d.comp[ccy]&&d.comp[ccy][field]).filter(v=>v!=null&&v!==0); return std(vals); }
  const scaleJPY = oldCotStd("cot","JPY") / (std(rawJPY)||1);
  const scaleCHF = oldCotStd("cot","CHF") / (std(rawCHF)||1);
  const scaleCpi = 0.6 / (std(rawCpiAccel)||1);

  function newScoreAt(i) {
    const day = days[i]; const out = {};
    for (const c of CURRENCIES) {
      const comp = day.comp[c] || {}; let delta = 0;
      delta -= (comp.season || 0);
      const oldRisk = comp.risk || 0; const vixSign = VIX_SIGN[c] || 0;
      const newRisk = vixSign ? vixSign * Math.max(-2, Math.min(2, rawVix[i])) * 0.5 : 0;
      delta += newRisk - oldRisk;
      if (c === "JPY") delta += (rawJPY[i]*scaleJPY) - (comp.cot||0);
      if (c === "CHF") delta += (rawCHF[i]*scaleCHF) - (comp.cot||0); // GBP COT beze změny (dealer vyřazen)
      if (YIELD_FLIP.has(c) && c === "CAD") delta += -2*(comp.yield||0); // jen CAD, EUR vyřazeno
      if (c === "CAD") delta += rawCpiAccel[i]*scaleCpi;
      out[c] = +(day.sc[c]+delta).toFixed(3);
    }
    return out;
  }

  function buildTrades(scFn, withCosts) {
    const trades = [];
    for (let di = 0; di < days.length; di++) {
      const day = days[di];
      const entryIdx = pxIdxOnOrAfter(new Date(Date.parse(day.d)+86400000).toISOString().slice(0,10));
      if (entryIdx < 0) continue;
      const sc = scFn(di);
      for (const p of STANDARD_PAIRS) {
        const diff = (sc[p.base]||0)-(sc[p.quote]||0);
        const p0 = pairPrice(p, entryIdx); if (p0 == null) continue;
        for (const H of HORIZONS) {
          if (entryIdx+H >= pxRates.length) continue;
          const p1 = pairPrice(p, entryIdx+H); if (p1 == null) continue;
          let ret = (p1/p0-1) * (diff>0?1:-1) * 100;
          if (withCosts) {
            const spreadPct = (SPREAD_PCT[p.pair]||0.00035) * 100;
            const swapPct = SWAP_PCT_PER_DAY * H * 100;
            ret -= (spreadPct + swapPct);
          }
          trades.push({ ret });
        }
      }
    }
    return trades;
  }

  const oldGross = buildTrades((di)=>days[di].sc, false);
  const oldNet = buildTrades((di)=>days[di].sc, true);
  const newGross = buildTrades((di)=>newScoreAt(di), false);
  const newNet = buildTrades((di)=>newScoreAt(di), true);

  console.log("=== HRUBÉ (bez nákladů) vs ČISTÉ (spread+swap odečtené) ===\n");
  console.log("STARÉ skóre:  hrubé", aggregate(oldGross), "\n              čisté", aggregate(oldNet));
  console.log("\nNOVÉ skóre:   hrubé", aggregate(newGross), "\n              čisté", aggregate(newNet));

  const out = { updated: new Date().toISOString(),
    methodology: "spread = konzervativní pipy/páry (0.15-0.4 bps roundtrip), swap = 0.008%/den plochá přirážka × horizont dní",
    old: { gross: aggregate(oldGross), net: aggregate(oldNet) },
    new: { gross: aggregate(newGross), net: aggregate(newNet) } };
  fs.writeFileSync(path.join(ROOT, "data/research/cost_adjusted.json"), JSON.stringify(out, null, 2));
  console.log("\nOK -> data/research/cost_adjusted.json");
})().catch((e) => { console.error("FATAL", e.stack); process.exit(1); });

// RP+ER — FINÁLNÍ kombinovaný filtr, DIAGNOSTICKÝ (appka ho nečte). Cíl:
// na celém 2letém, Yahoo-denním, víkendově vyčištěném okně (stejná metodika
// jako backtest-rper-entry-model.js) najít nejlepší KOMBINACI potvrzovacích
// filtrů pro RP+ER signál. Testuje:
//   1) Trend zarovnání (50denní SMA) — SHORT v downtrendu / LONG v uptrendu
//      = "pullback ve směru trendu" vs. SHORT v uptrendu / LONG v downtrendu
//      = "čistá sázka na zvrat" — čistě z ceny, 2y testovatelné.
//   2) COT divergence-kontrarián (viz scripts/audcheck session nález) — obě
//      měny páru klasifikované STRONG/WEAK/NEUTRAL podle VLASTNÍ 2leté COT
//      historie (getCOTPercentile ekvivalent), a jestli obchod jede S nebo
//      PROTI čisté divergenci.
//   3) Kombinace obou — matice trend x COT, hledá nejlepší buňku s
//      rozumnou velikostí vzorku.
// Výstup: data/backtest_rper_ultimate.json.
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
const YEARS_BACK = 2;
const MIN_MOVE_PCT = 0.05;

async function fetchYahooDaily(symbol, range) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`, {
    signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!r.ok) throw new Error("Yahoo " + symbol + " HTTP " + r.status);
  const j = await r.json();
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  const ts = res && res.timestamp, closes = res && res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close;
  if (!Array.isArray(ts) || !Array.isArray(closes)) throw new Error("Yahoo " + symbol + ": neplatná struktura");
  const isWeekend = (d) => { const day = new Date(d + "T00:00:00Z").getUTCDay(); return day === 0 || day === 6; };
  return ts.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
    .filter((r) => r.close != null && !isNaN(r.close) && !isWeekend(r.date));
}

function rangePositionAt(prices, endIdx, days = 10) {
  const start = Math.max(0, endIdx - days + 1);
  let mn = Infinity, mx = -Infinity, last = null;
  for (let i = start; i <= endIdx; i++) { const px = prices[i]; if (px == null) continue; if (px < mn) mn = px; if (px > mx) mx = px; last = px; }
  if (last == null || !(mx > mn)) return null;
  const rp = (last - mn) / (mx - mn);
  return { rp, zone: rp <= 0.33 ? "low" : rp >= 0.67 ? "high" : "mid" };
}
function efficiencyRatioAt(prices, endIdx, days = 10) {
  const startIdx = endIdx - days; if (startIdx < 0) return null;
  const p0 = prices[startIdx], p1 = prices[endIdx];
  if (p0 == null || p1 == null) return null;
  let sumAbs = 0;
  for (let i = startIdx + 1; i <= endIdx; i++) { const a = prices[i - 1], b = prices[i]; if (a == null || b == null) continue; sumAbs += Math.abs(b - a); }
  if (sumAbs === 0) return null;
  return { er: Math.abs(p1 - p0) / sumAbs };
}
function smaAt(prices, endIdx, days = 50) {
  const start = endIdx - days + 1; if (start < 0) return null;
  let sum = 0, n = 0;
  for (let i = start; i <= endIdx; i++) { const px = prices[i]; if (px == null) return null; sum += px; n++; }
  return n === days ? sum / days : null;
}
function findEpisodes(dates, prices) {
  const episodes = []; let open = null;
  for (let i = 0; i < prices.length; i++) {
    const rp = rangePositionAt(prices, i), er = efficiencyRatioAt(prices, i);
    const zone = rp ? (rp.rp >= 0.8 ? "high" : rp.rp <= 0.2 ? "low" : null) : null;
    if (open && zone !== open.zone) { open.resolvedIdx = i; open.resolvedDate = dates[i]; open.resolvedPrice = prices[i]; episodes.push(open); open = null; }
    if (!open && rp && er) {
      if (zone === "high" && er.er > 0.5) open = { type: "SHORT", zone: "high", onsetIdx: i, onsetDate: dates[i], onsetPrice: prices[i] };
      else if (zone === "low" && er.er >= 0.2 && er.er < 0.65) open = { type: "LONG", zone: "low", onsetIdx: i, onsetDate: dates[i], onsetPrice: prices[i] };
    }
  }
  if (open) { open.ongoing = true; episodes.push(open); }
  for (const ep of episodes) {
    const sma50 = smaAt(prices, ep.onsetIdx, 50);
    if (sma50 != null) {
      ep.trendAtOnset = ep.onsetPrice > sma50 ? "UP" : ep.onsetPrice < sma50 ? "DOWN" : "FLAT";
      ep.trendAligned = ep.trendAtOnset === "FLAT" ? null : (ep.type === "SHORT" ? ep.trendAtOnset === "DOWN" : ep.trendAtOnset === "UP");
    } else { ep.trendAtOnset = null; ep.trendAligned = null; }
    if (ep.ongoing) continue;
    const pctChange = ((ep.resolvedPrice - ep.onsetPrice) / ep.onsetPrice) * 100;
    ep.pctChange = +pctChange.toFixed(3);
    const predictedDown = ep.type === "SHORT";
    const moved = Math.abs(pctChange) > MIN_MOVE_PCT;
    const correct = moved && ((predictedDown && pctChange < 0) || (!predictedDown && pctChange > 0));
    ep.outcome = !moved ? "CHOP" : correct ? "CORRECT" : "WRONG";
  }
  return episodes;
}
function summarize(eps) {
  const resolved = eps.filter((e) => !e.ongoing && e.outcome !== "CHOP");
  const correct = resolved.filter((e) => e.outcome === "CORRECT"), wrong = resolved.filter((e) => e.outcome === "WRONG");
  const gp = correct.reduce((s, e) => s + Math.abs(e.pctChange), 0), gl = wrong.reduce((s, e) => s + Math.abs(e.pctChange), 0);
  return { n: resolved.length, winRate: resolved.length ? +((correct.length / resolved.length) * 100).toFixed(1) : null, pf: gl > 0 ? +(gp / gl).toFixed(2) : null };
}

(async () => {
  const cotHist = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "cot_hist.json"), "utf8"));
  const cotDates = Object.keys(cotHist.weeks).sort();
  function percentileAsOf(cur, targetDate) {
    const usable = cotDates.filter((d) => d <= targetDate);
    if (usable.length < 12) return null;
    const windowDates = usable.slice(-104);
    const scores = windowDates.map((d) => cotHist.weeks[d].scores && cotHist.weeks[d].scores[cur]).filter((v) => typeof v === "number");
    if (scores.length < 12) return null;
    const curV = scores[scores.length - 1], hist = scores.slice(0, -1);
    return Math.round((hist.filter((s) => s <= curV).length / hist.length) * 100);
  }
  function state(v) { return v == null ? "NEUTRAL" : v >= 67 ? "STRONG" : v <= 33 ? "WEAK" : "NEUTRAL"; }
  function cotCombo(type, base, quote, onsetDate) {
    const bC = state(percentileAsOf(base, onsetDate)), qC = state(percentileAsOf(quote, onsetDate));
    if ((bC === "STRONG" && qC === "WEAK") || (bC === "WEAK" && qC === "STRONG")) {
      const expectBaseUp = bC === "STRONG";
      const agrees = expectBaseUp ? type === "LONG" : type === "SHORT";
      return agrees ? "divergence_agree" : "divergence_contra";
    }
    if (bC === "STRONG" && qC === "STRONG") return "both_strong";
    if (bC === "WEAK" && qC === "WEAK") return "both_weak";
    return "mixed_neutral";
  }

  const allEpisodes = [];
  for (const { pair, base, quote } of STANDARD_PAIRS) {
    let rows;
    try { rows = await fetchYahooDaily(pair + "=X", `${YEARS_BACK}y`); }
    catch (e) { console.log(`${pair}: fetch ERR ${e.message}, přeskakuji`); continue; }
    if (rows.length < 60) { console.log(`${pair}: málo dat, přeskakuji`); continue; }
    const dates = rows.map((r) => r.date), prices = rows.map((r) => r.close);
    const episodes = findEpisodes(dates, prices);
    for (const ep of episodes) {
      if (ep.ongoing || ep.outcome === "CHOP") continue;
      const combo = cotCombo(ep.type, base, quote, ep.onsetDate);
      allEpisodes.push({ pair, base, quote, type: ep.type, onsetDate: ep.onsetDate, pctChange: ep.pctChange, outcome: ep.outcome, trendAligned: ep.trendAligned, cotCombo: combo });
    }
    console.log(`${pair}: ${episodes.length} epizod zpracováno`);
    await new Promise((res) => setTimeout(res, 120));
  }

  console.log("\n=== CELKEM (baseline, bez filtru) ===");
  console.log(JSON.stringify(summarize(allEpisodes)));

  console.log("\n=== 1) Trend zarovnání samotné ===");
  const trendAligned = allEpisodes.filter((e) => e.trendAligned === true);
  const trendCounter = allEpisodes.filter((e) => e.trendAligned === false);
  console.log("Pullback VE SMĚRU trendu (trendAligned=true):", JSON.stringify(summarize(trendAligned)));
  console.log("Čistý zvrat PROTI trendu (trendAligned=false):", JSON.stringify(summarize(trendCounter)));

  console.log("\n=== 2) COT kombo samotné ===");
  for (const c of ["divergence_contra", "divergence_agree", "both_strong", "both_weak", "mixed_neutral"]) {
    console.log(c.padEnd(20), JSON.stringify(summarize(allEpisodes.filter((e) => e.cotCombo === c))));
  }

  console.log("\n=== 3) KOMBINACE: trend x COT kombo (matice) ===");
  const combos = ["divergence_contra", "divergence_agree", "both_strong", "both_weak", "mixed_neutral"];
  const results = {};
  for (const tr of [true, false]) {
    for (const c of combos) {
      const subset = allEpisodes.filter((e) => e.trendAligned === tr && e.cotCombo === c);
      const s = summarize(subset);
      const key = (tr ? "trend_ALIGNED" : "trend_COUNTER") + "__" + c;
      results[key] = s;
      console.log(key.padEnd(40), JSON.stringify(s));
    }
  }

  // Najít nejlepší buňku s rozumným vzorkem (n>=15)
  const ranked = Object.entries(results).filter(([, s]) => s.n >= 15 && s.pf != null).sort((a, b) => b[1].pf - a[1].pf);
  console.log("\n=== NEJLEPŠÍ KOMBINACE (n>=15), seřazeno podle PF ===");
  for (const [k, s] of ranked) console.log(k.padEnd(40), JSON.stringify(s));

  fs.writeFileSync(path.join(ROOT, "data", "backtest_rper_ultimate.json"), JSON.stringify({
    generated: new Date().toISOString(),
    methodology: "Yahoo denní close (weekend filtr), 2y okno. Trend = 50denní SMA zarovnání (pullback vs. čistý zvrat). COT kombo = STRONG/WEAK/NEUTRAL percentil vlastní 2leté historie obou měn páru, point-in-time k onsetDate. Hledá nejlepší kombinovaný potvrzovací filtr pro RP+ER.",
    baseline: summarize(allEpisodes),
    trendOnly: { aligned: summarize(trendAligned), counter: summarize(trendCounter) },
    cotOnly: Object.fromEntries(combos.map((c) => [c, summarize(allEpisodes.filter((e) => e.cotCombo === c))])),
    combined: results,
    bestRanked: ranked,
    episodes: allEpisodes,
  }));
  console.log("\nUloženo do data/backtest_rper_ultimate.json");
})();

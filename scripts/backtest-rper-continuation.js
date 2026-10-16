// RP+ER — POKRAČOVÁNÍ POHYBU PO UZAVŘENÍ epizody, DIAGNOSTICKÝ (appka ho
// nečte). Uživatelský postřeh: cena často pokračuje ve směru obchodu i PO
// TOM, co appka epizodu technicky uzavře (RP opustí zónu, ve které vznikla —
// to je jediný důvod uzavření, ne že by se "pohyb vyčerpal"). Tenhle skript
// měří: pro KAŽDOU vyřešenou (CORRECT i WRONG) epizodu za celé 2leté okno,
// kolik cena ještě ujela ve SMĚRU PŮVODNÍHO OBCHODU N dní PO uzavření
// (+3/+5/+10 obchodních dní) — aby bylo vidět, kolik se reálně nechává na
// stole tím, že appka/trader bere uzavření jako konec příběhu.
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
const FOLLOWUP_DAYS = [3, 5, 10];

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
function summarizePct(arr) {
  if (!arr.length) return { n: 0 };
  const avg = arr.reduce((s, v) => s + v, 0) / arr.length;
  const positive = arr.filter((v) => v > 0).length;
  const sorted = [...arr].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { n: arr.length, avg: +avg.toFixed(3), median: +median.toFixed(3), pctPositive: +((positive / arr.length) * 100).toFixed(1) };
}

(async () => {
  const byOutcome = { CORRECT: {}, WRONG: {} };
  for (const d of FOLLOWUP_DAYS) { byOutcome.CORRECT[d] = []; byOutcome.WRONG[d] = []; }
  const allRecords = [];

  for (const { pair, base, quote } of STANDARD_PAIRS) {
    let rows;
    try { rows = await fetchYahooDaily(pair + "=X", `${YEARS_BACK}y`); }
    catch (e) { console.log(`${pair}: fetch ERR ${e.message}, přeskakuji`); continue; }
    if (rows.length < 60) { console.log(`${pair}: málo dat, přeskakuji`); continue; }
    const dates = rows.map((r) => r.date), prices = rows.map((r) => r.close);
    const episodes = findEpisodes(dates, prices);
    for (const ep of episodes) {
      if (ep.ongoing || ep.outcome === "CHOP") continue;
      const dirSign = ep.type === "LONG" ? 1 : -1;
      const rec = { pair, type: ep.type, onsetDate: ep.onsetDate, resolvedDate: ep.resolvedDate, outcome: ep.outcome, pctChangeAtResolution: ep.pctChange };
      for (const d of FOLLOWUP_DAYS) {
        const idx = ep.resolvedIdx + d;
        if (idx >= prices.length) { rec["fwd" + d] = null; continue; }
        const fwdPct = ((prices[idx] - ep.resolvedPrice) / ep.resolvedPrice) * 100 * dirSign;
        rec["fwd" + d] = +fwdPct.toFixed(3);
        byOutcome[ep.outcome][d].push(fwdPct);
      }
      allRecords.push(rec);
    }
    console.log(`${pair}: ${episodes.length} epizod`);
    await new Promise((res) => setTimeout(res, 120));
  }

  console.log("\n=== Pokračování pohybu PO uzavření epizody (směrově upraveno na původní obchod) ===");
  for (const outcome of ["CORRECT", "WRONG"]) {
    console.log(`\n-- ${outcome} epizody --`);
    for (const d of FOLLOWUP_DAYS) {
      console.log(`  +${d} obch. dní po uzavření:`, JSON.stringify(summarizePct(byOutcome[outcome][d])));
    }
  }

  // Srovnání: u CORRECT epizod, kolik procentních bodů navíc přidá držení dál (medián fwd10 vs. medián pctChange při uzavření)
  const correctRecs = allRecords.filter((r) => r.outcome === "CORRECT");
  const atResolution = correctRecs.map((r) => Math.abs(r.pctChangeAtResolution));
  console.log("\n=== Srovnání: zisk PŘI uzavření vs. PO uzavření (jen CORRECT) ===");
  console.log("Zisk při uzavření (medián/avg):", JSON.stringify(summarizePct(atResolution)));
  for (const d of FOLLOWUP_DAYS) console.log(`Dodatečný zisk +${d}d po uzavření:`, JSON.stringify(summarizePct(byOutcome.CORRECT[d])));

  fs.writeFileSync(path.join(ROOT, "data", "backtest_rper_continuation.json"), JSON.stringify({
    generated: new Date().toISOString(),
    methodology: "Yahoo denní close (weekend filtr), 2y okno. Pro každou vyřešenou (CORRECT/WRONG) RP+ER epizodu měří pohyb ceny +3/+5/+10 obchodních dní PO technickém uzavření (RP opustil zónu), směrově upraveno na původní obchod (kladné = pokračuje ve směru obchodu). Cíl: zjistit, jestli/kolik se nechává na stole tím, že appka/trader bere technické uzavření jako konec obchodu.",
    byOutcome,
    records: allRecords,
  }));
  console.log("\nUloženo do data/backtest_rper_continuation.json");
})();

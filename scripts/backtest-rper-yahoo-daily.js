// RP+ER — DIAGNOSTICKÉ srovnání cenového zdroje: tenhle skript je BYTOVĚ
// stejná metodika jako scripts/backtest-rper.js (stejné rangePositionAt/
// efficiencyRatioAt/findEpisodes/summarize, zkopírované beze změny), jediný
// rozdíl je ZDROJ denní ceny:
//   backtest-rper.js        → Frankfurter API = ECB referenční kurz,
//                              fixovaný JEDNOU denně ~14:15 SEČ/SELČ (~12-13
//                              UTC) — poledne, ne konec dne.
//   backtest-rper-yahoo-daily.js (tenhle) → Yahoo Finance denní close
//                              (interval=1d), stejný zdroj jako appka naživo
//                              používá (data/prices.json, Yahoo tiky) —
//                              takže tohle je metodicky KONZISTENTNÍ s tím,
//                              co appka doopravdy posílá (getRangePosition/
//                              getEfficiencyRatio v engine.js počítají z
//                              posledního UZAVŘENÉHO UTC dne, ne poledního
//                              ECB fixingu).
//
// Důvod vzniku: vizuální kontrola (Claude Cowork, TradingView, 2026-10-11)
// našla, že "onset cena" ze scripts/backtest-rper.js odpovídá ceně kolem
// 12:00 UTC, ne skutečné denní uzávěrce — u EURCAD rozdíl 31,5 pips. Tenhle
// skript ověřuje, jak moc se tím mění výsledná kalibrace (win rate/PF/
// epizody), když se počítá ze STEJNÉHO zdroje jako appka.
//
// Výstup: data/backtest_rper_yahoo.json — appka ho nečte, nic neovlivňuje.
// Srovnání s data/backtest_rper.json (Frankfurter) je účel tohohle běhu.
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
  return ts.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
    .filter((r) => r.close != null && !isNaN(r.close));
}

// ── Identická matematika jako scripts/backtest-rper.js (a engine.js
// getRangePosition/getEfficiencyRatio), jen zkopírovaná sem, ať je tenhle
// skript nezávislý na tom souboru. ──────────────────────────────────────
function rangePositionAt(prices, endIdx, days = 10) {
  const start = Math.max(0, endIdx - days + 1);
  let mn = Infinity, mx = -Infinity, last = null;
  for (let i = start; i <= endIdx; i++) {
    const px = prices[i]; if (px == null || !isFinite(px)) continue;
    if (px < mn) mn = px; if (px > mx) mx = px; last = px;
  }
  if (last == null || !(mx > mn)) return null;
  const rp = (last - mn) / (mx - mn);
  return { rp, zone: rp <= 0.33 ? "low" : rp >= 0.67 ? "high" : "mid" };
}
function efficiencyRatioAt(prices, endIdx, days = 10) {
  const startIdx = endIdx - days; if (startIdx < 0) return null;
  const p0 = prices[startIdx], p1 = prices[endIdx];
  if (p0 == null || p1 == null || !isFinite(p0) || !isFinite(p1)) return null;
  let sumAbs = 0;
  for (let i = startIdx + 1; i <= endIdx; i++) {
    const a = prices[i - 1], b = prices[i];
    if (a == null || b == null || !isFinite(a) || !isFinite(b)) continue;
    sumAbs += Math.abs(b - a);
  }
  if (sumAbs === 0) return null;
  return { er: Math.abs(p1 - p0) / sumAbs };
}
function findEpisodes(dates, prices) {
  const episodes = [];
  let open = null;
  for (let i = 0; i < prices.length; i++) {
    const rp = rangePositionAt(prices, i, 10);
    const er = efficiencyRatioAt(prices, i, 10);
    const zone = rp ? (rp.rp >= 0.8 ? "high" : rp.rp <= 0.2 ? "low" : null) : null;

    if (open && zone !== open.zone) {
      open.resolvedIdx = i; open.resolvedDate = dates[i]; open.resolvedPrice = prices[i];
      episodes.push(open); open = null;
    }
    if (!open && rp && er) {
      if (zone === "high" && er.er > 0.5) {
        open = { type: "SHORT", zone: "high", onsetIdx: i, onsetDate: dates[i], onsetPrice: prices[i], onsetRP: +rp.rp.toFixed(3), onsetER: +er.er.toFixed(3) };
      } else if (zone === "low" && er.er >= 0.2 && er.er < 0.65) {
        open = { type: "LONG", zone: "low", onsetIdx: i, onsetDate: dates[i], onsetPrice: prices[i], onsetRP: +rp.rp.toFixed(3), onsetER: +er.er.toFixed(3) };
      }
    }
  }
  if (open) { open.ongoing = true; episodes.push(open); }

  for (const ep of episodes) {
    if (ep.ongoing) continue;
    const pctChange = ((ep.resolvedPrice - ep.onsetPrice) / ep.onsetPrice) * 100;
    ep.daysToResolution = ep.resolvedIdx - ep.onsetIdx;
    ep.pctChange = +pctChange.toFixed(3);
    const predictedDown = ep.type === "SHORT";
    const moved = Math.abs(pctChange) > MIN_MOVE_PCT;
    const correct = moved && ((predictedDown && pctChange < 0) || (!predictedDown && pctChange > 0));
    ep.outcome = !moved ? "CHOP" : correct ? "CORRECT" : "WRONG";
  }
  return episodes;
}
function summarize(episodes) {
  const resolved = episodes.filter((e) => !e.ongoing);
  const correct = resolved.filter((e) => e.outcome === "CORRECT");
  const wrong = resolved.filter((e) => e.outcome === "WRONG");
  const chop = resolved.filter((e) => e.outcome === "CHOP");
  const decided = correct.length + wrong.length;
  const gp = correct.reduce((s, e) => s + Math.abs(e.pctChange), 0);
  const gl = wrong.reduce((s, e) => s + Math.abs(e.pctChange), 0);
  return {
    total: episodes.length, resolved: resolved.length, ongoing: episodes.length - resolved.length,
    correct: correct.length, wrong: wrong.length, chop: chop.length,
    winRate: decided ? +((correct.length / decided) * 100).toFixed(1) : null,
    pf: gl > 0 ? +(gp / gl).toFixed(2) : null,
    avgDaysToResolution: resolved.length ? +(resolved.reduce((s, e) => s + e.daysToResolution, 0) / resolved.length).toFixed(1) : null,
  };
}

(async () => {
  const results = {};
  for (const { pair } of STANDARD_PAIRS) {
    let rows;
    try { rows = await fetchYahooDaily(pair + "=X", `${YEARS_BACK}y`); }
    catch (e) { console.log(`${pair}: fetch ERR ${e.message}, přeskakuji`); continue; }
    if (rows.length < 30) { console.log(`${pair}: málo dat (${rows.length}), přeskakuji`); continue; }
    const dates = rows.map((r) => r.date), prices = rows.map((r) => r.close);
    const episodes = findEpisodes(dates, prices);
    results[pair] = { episodes, stats: summarize(episodes), days: dates.length, range: { start: dates[0], end: dates[dates.length - 1] } };
    console.log(`${pair}: ${dates.length} dní (${dates[0]}→${dates[dates.length - 1]}), ${episodes.length} epizod, win rate ${results[pair].stats.winRate}%, PF ${results[pair].stats.pf}`);
    await new Promise((res) => setTimeout(res, 120));
  }

  const allResolved = [];
  for (const pair in results) for (const ep of results[pair].episodes) if (!ep.ongoing) allResolved.push(ep);
  const overall = summarize(allResolved);
  console.log(`\nCELKEM: ${allResolved.length} vyřešených epizod, win rate ${overall.winRate}%, PF ${overall.pf}`);

  const out = {
    generated: new Date().toISOString(),
    methodology: "STEJNÁ metodika jako scripts/backtest-rper.js, ale cenový zdroj je Yahoo Finance DENNÍ close (interval=1d) místo Frankfurter/ECB referenčního kurzu — konzistentní s tím, co appka naživo používá (data/prices.json, getRangePosition/getEfficiencyRatio počítají z posledního uzavřeného UTC dne). Viz hlavička souboru pro kontext (Cowork/TradingView nález 2026-10-11).",
    overall,
    perInstrument: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.stats])),
    episodes: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { episodes: v.episodes }])),
  };
  fs.writeFileSync(path.join(ROOT, "data", "backtest_rper_yahoo.json"), JSON.stringify(out));
  console.log("Uloženo do data/backtest_rper_yahoo.json");
})();

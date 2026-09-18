// RP+ER exhaustion signál — server-side backtest/kalibrace (měřicí nástroj,
// appka ho nečte, engine se tímto skriptem NEMĚNÍ — stejný princip jako
// scripts/backtest-cot.js). Stahuje si VLASTNÍ delší historii cen (Frankfurter
// pro FX, Yahoo pro zlato/US100) — appčina vlastní data/prices.json je jen
// krátké přírůstkové okno (desítky dní, roste teprve od nedávna), zatímco
// tenhle skript chce roky zpět, ať má na čem měřit.
//
// Metodika (point-in-time, bez look-aheadu): pro každý nástroj se den po dni
// počítá STEJNÉ RP(10)/ER(10) jako engine.js (getRangePosition/
// getEfficiencyRatio/getGoldRangePosition/…), ale nad libovolným historickým
// okamžikem, ne jen "posledních 10 dní". Epizoda signálu = první den, kdy RP
// vstoupí do extrému (≥80 % nebo ≤20 %) SOUČASNĚ s ER v pásmu (stejné prahy
// jako getRPERSignal v index.html) — VYNECHÁVÁ fundamentální filtr (appka ho
// navíc vyžaduje pro reálné zobrazení/alert), protože appka nemá k dispozici
// historii denního fundamentálního skóre pro zlato/US100 a pro FX jen ~2
// měsíce (data/engine_hist.json) — tohle testuje ČISTĚ technický spouštěč.
// Epizoda končí (= "vyřešena"), když RP opustí ZÓNU, ve které vznikla — bez
// ohledu na to, jestli ER mezitím na chvíli vypadlo z pásma.
//
// Výstup: data/backtest_rper.json — epizody + agregované statistiky (win
// rate, PF, průměr dní do vyřešení) po nástrojích i celkově.
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
const CUR = ["EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
const YEARS_BACK = 2;
const MIN_MOVE_PCT = 0.05; // pod tímhle % je "CHOP" (šum), ne CORRECT/WRONG

async function fetchFrankfurterHist(startDate, endDate) {
  const url = `https://api.frankfurter.app/${startDate}..${endDate}?from=USD&to=${CUR.join(",")}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("Frankfurter HTTP " + r.status);
  const j = await r.json();
  if (!j || !j.rates) throw new Error("Frankfurter: prázdná odpověď");
  return j.rates; // { "2024-11-05": {EUR:.., GBP:..}, ... }
}

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

// ── RP+ER point-in-time (STEJNÁ matematika jako engine.js getRangePosition/
// getEfficiencyRatio/getGoldRangePosition/getGoldEfficiencyRatio, jen
// parametrizovaná libovolným koncovým indexem místo "posledních N") ────────
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

// ── Epizody: RP≥80%+ER>0.5 → SHORT / RP≤20%+ER 0.20-0.65 → LONG (stejné
// prahy jako getRPERSignal v index.html). Epizoda běží, dokud RP neopustí
// zónu, ve které vznikla (viz komentář v hlavičce souboru). ────────────────
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
    [5, 10, 20].forEach((h) => {
      const idx = ep.onsetIdx + h;
      if (idx < prices.length) ep["ret" + h + "d"] = +(((prices[idx] - ep.onsetPrice) / ep.onsetPrice) * 100).toFixed(3);
    });
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
    pf: gl > 0 ? +(gp / gl).toFixed(2) : (gp > 0 ? null : null),
    avgDaysToResolution: resolved.length ? +(resolved.reduce((s, e) => s + e.daysToResolution, 0) / resolved.length).toFixed(1) : null,
  };
}

(async () => {
  const today = new Date();
  const startDate = new Date(today.getTime() - YEARS_BACK * 365 * 86400000).toISOString().slice(0, 10);
  const endDate = today.toISOString().slice(0, 10);

  console.log(`Stahuji historické FX kurzy ${startDate} → ${endDate}…`);
  const ratesByDate = await fetchFrankfurterHist(startDate, endDate);
  const fxDates = Object.keys(ratesByDate).sort();
  console.log(`FX: ${fxDates.length} obchodních dní`);

  const results = {};
  for (const { pair, base, quote } of STANDARD_PAIRS) {
    const dates = [], prices = [];
    for (const d of fxDates) {
      const row = ratesByDate[d];
      const b = base === "USD" ? 1 : row[base], q = quote === "USD" ? 1 : row[quote];
      if (b == null || q == null) continue;
      dates.push(d); prices.push(q / b);
    }
    if (prices.length < 30) { console.log(`${pair}: málo dat (${prices.length}), přeskakuji`); continue; }
    const episodes = findEpisodes(dates, prices);
    results[pair] = { episodes, stats: summarize(episodes) };
    console.log(`${pair}: ${prices.length} dní, ${episodes.length} epizod, win rate ${results[pair].stats.winRate}%`);
  }

  console.log("Stahuji historii zlata (Yahoo GC=F, 2y)…");
  try {
    const goldRows = await fetchYahooDaily("GC=F", "2y");
    const dates = goldRows.map((r) => r.date), prices = goldRows.map((r) => r.close);
    const episodes = findEpisodes(dates, prices);
    results.XAUUSD = { episodes, stats: summarize(episodes) };
    console.log(`XAUUSD: ${prices.length} dní, ${episodes.length} epizod, win rate ${results.XAUUSD.stats.winRate}%`);
  } catch (e) { console.log("Zlato ERR", e.message); }

  console.log("Stahuji historii US100 (Yahoo ^NDX, 1y — 2y na tomhle indexu vrací 404, viz scripts/fetch-us100-price.js)…");
  try {
    // fetchYahooDaily() si symbol sama URL-enkóduje — "^NDX" SUROVĚ, ne
    // předem enkódované "%5ENDX" (to by se enkódovalo podruhé na neplatné
    // "%255ENDX" → Yahoo 404, živě odchyceno v prvních dvou bězích workflow).
    const us100Rows = await fetchYahooDaily("^NDX", "1y");
    const dates = us100Rows.map((r) => r.date), prices = us100Rows.map((r) => r.close);
    const episodes = findEpisodes(dates, prices);
    results.US100 = { episodes, stats: summarize(episodes) };
    console.log(`US100: ${prices.length} dní, ${episodes.length} epizod, win rate ${results.US100.stats.winRate}%`);
  } catch (e) { console.log("US100 ERR", e.message); }

  const allEpisodes = Object.values(results).flatMap((r) => r.episodes);
  const overall = summarize(allEpisodes);
  const byType = { SHORT: summarize(allEpisodes.filter((e) => e.type === "SHORT")), LONG: summarize(allEpisodes.filter((e) => e.type === "LONG")) };

  const out = {
    generated: new Date().toISOString(),
    methodology: "Point-in-time RP(10)/ER(10), STEJNÉ prahy jako getRPERSignal (index.html), BEZ fundamentálního filtru (appka ho navíc vyžaduje pro živé zobrazení/alert). Epizoda = od prvního dne v extrému+ER pásmu do dne, kdy RP opustí tu zónu. MIN_MOVE_PCT=" + MIN_MOVE_PCT + "% (pod tím je CHOP).",
    range: { startDate, endDate, years: YEARS_BACK },
    overall, byType,
    perInstrument: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.stats])),
    episodes: results,
  };

  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "backtest_rper.json"), JSON.stringify(out));
  console.log("\n=== CELKEM ===");
  console.log(JSON.stringify({ overall, byType }, null, 2));
  console.log("Zapsáno data/backtest_rper.json");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

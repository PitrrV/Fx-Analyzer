// RP+ER — entry-model backtest na CELÉM 2letém okně (ne jen 12-14 korelovaných
// signálech jako vizuální kontrola Cowork). Staví na stejné point-in-time
// RP(10)/ER(10) logice jako scripts/backtest-rper-yahoo-daily.js (Yahoo denní
// close, konzistentní se zdrojem appky — viz hlavička toho souboru), se dvěma
// opravami/doplňky nad rámec toho skriptu:
//
// 1) WEEKEND FIX: Yahoo denní historie u FX obsahuje i so/ne "duch dny"
//    (skoro beze změny, appka je u data/prices.json už filtruje přes
//    isWeekend() — viz scripts/fetch-prices.js, reálně ověřený problém
//    20.9.2026). Tenhle skript to samé dělá tady, protože
//    backtest-rper-yahoo-daily.js to nemělo (nález Cowork, vizuální kontrola
//    v2, 2026-10-11 — 3 ze 14 signálů vznikly z neděle).
//
// 2) ENTRY MODEL SIMULACE: appka dnes drží signál, dokud RP neopustí zónu
//    (žádný TP/SL). Cowork na 12 signálech tohoto týdne (OANDA 1H) ukázal, že
//    11/12 dosáhlo aspoň +25 pips zisku, ale 5 se pak otočilo do ztráty —
//    navrhl TP ~0,3-0,4×ATR a SL ~0,5×ATR místo čekání na konec zóny. Tenhle
//    skript to simuluje na denních high/low (OHLC, ne jen close) pro KAŽDOU
//    epizodu za 2 roky: vstup = onsetPrice (close dne D), od D+1 dál se
//    kontroluje denní high/low proti TP/SL úrovni. Když oba padnou do
//    stejného dne, konzervativně se počítá SL jako první (nevíme pořadí
//    uvnitř dne — stejná výhrada jako Cowork u 1H dat).
//
// Výstup: data/backtest_rper_entry_model.json — appka ho nečte, nic
// neovlivňuje. Srovnává 3 varianty: appka dnes (drž do konce zóny), TP/SL
// v ATR násobcích, a D+1 svíčka proti směru = exit.
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
const ATR_PERIOD = 14;
const TP_ATR_MULT = 0.35;
const SL_ATR_MULT = 0.5;

async function fetchYahooDailyOHLC(symbol, range) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`, {
    signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!r.ok) throw new Error("Yahoo " + symbol + " HTTP " + r.status);
  const j = await r.json();
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  const ts = res && res.timestamp;
  const q = res && res.indicators && res.indicators.quote && res.indicators.quote[0];
  if (!Array.isArray(ts) || !q) throw new Error("Yahoo " + symbol + ": neplatná struktura");
  const isWeekend = (d) => { const day = new Date(d + "T00:00:00Z").getUTCDay(); return day === 0 || day === 6; };
  return ts.map((t, i) => ({
    date: new Date(t * 1000).toISOString().slice(0, 10),
    open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i],
  })).filter((r) => r.close != null && !isNaN(r.close) && r.high != null && r.low != null && !isWeekend(r.date));
}

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
function atrAt(bars, endIdx, period = ATR_PERIOD) {
  const start = endIdx - period + 1; if (start < 1) return null;
  let sum = 0, n = 0;
  for (let i = start; i <= endIdx; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    if (h == null || l == null || pc == null) continue;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    n++;
  }
  return n === period ? sum / period : null;
}

function findEpisodes(bars) {
  const dates = bars.map((b) => b.date), prices = bars.map((b) => b.close);
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
        open = { type: "SHORT", zone: "high", onsetIdx: i, onsetDate: dates[i], onsetPrice: prices[i] };
      } else if (zone === "low" && er.er >= 0.2 && er.er < 0.65) {
        open = { type: "LONG", zone: "low", onsetIdx: i, onsetDate: dates[i], onsetPrice: prices[i] };
      }
    }
  }
  if (open) { open.ongoing = true; episodes.push(open); }

  for (const ep of episodes) {
    const atr = atrAt(bars, ep.onsetIdx);
    ep.atrAtOnset = atr;
    if (ep.ongoing) continue;
    const pctChange = ((ep.resolvedPrice - ep.onsetPrice) / ep.onsetPrice) * 100;
    ep.daysToResolution = ep.resolvedIdx - ep.onsetIdx;
    ep.pctChange = +pctChange.toFixed(3);
    const predictedDown = ep.type === "SHORT";
    const moved = Math.abs(pctChange) > MIN_MOVE_PCT;
    const correct = moved && ((predictedDown && pctChange < 0) || (!predictedDown && pctChange > 0));
    ep.outcome = !moved ? "CHOP" : correct ? "CORRECT" : "WRONG";

    // ── Entry model simulace (TP/SL v ATR násobcích + D+1 pin-proti-směru exit) ──
    if (atr && atr > 0) {
      const dirSign = ep.type === "LONG" ? 1 : -1;
      const tpPrice = ep.onsetPrice + dirSign * TP_ATR_MULT * atr;
      const slPrice = ep.onsetPrice - dirSign * SL_ATR_MULT * atr;
      let exitIdx = null, exitReason = null, exitPrice = null;
      for (let i = ep.onsetIdx + 1; i < bars.length; i++) {
        const bar = bars[i];
        const hitTP = dirSign > 0 ? bar.high >= tpPrice : bar.low <= tpPrice;
        const hitSL = dirSign > 0 ? bar.low <= slPrice : bar.high >= slPrice;
        if (hitSL) { exitIdx = i; exitReason = "SL"; exitPrice = slPrice; break; } // konzervativně SL první při kolizi ve stejném dni
        if (hitTP) { exitIdx = i; exitReason = "TP"; exitPrice = tpPrice; break; }
        if (i - ep.onsetIdx >= 30) { exitIdx = i; exitReason = "TIMEOUT_30D"; exitPrice = bar.close; break; }
      }
      if (exitIdx == null) { exitReason = "NO_DATA"; }
      else {
        const pctEM = ((exitPrice - ep.onsetPrice) / ep.onsetPrice) * 100 * dirSign;
        ep.entryModel = { tpPrice: +tpPrice.toFixed(5), slPrice: +slPrice.toFixed(5), exitDate: dates[exitIdx], exitReason, daysHeld: exitIdx - ep.onsetIdx, pctChangeSigned: +pctEM.toFixed(3) };
      }

      // D+1 svíčka proti směru = exit (první úplný den po onsetu)
      const d1 = bars[ep.onsetIdx + 1];
      if (d1) {
        const body = Math.abs(d1.close - d1.open), range = d1.high - d1.low || 1e-9;
        const upperWick = d1.high - Math.max(d1.open, d1.close), lowerWick = Math.min(d1.open, d1.close) - d1.low;
        const pinAgainst = dirSign > 0 ? (upperWick / range >= 0.5) : (lowerWick / range >= 0.5);
        const pinWith = dirSign > 0 ? (lowerWick / range >= 0.5) : (upperWick / range >= 0.5);
        const pctD1 = ((d1.close - ep.onsetPrice) / ep.onsetPrice) * 100 * dirSign;
        ep.d1Candle = { pinAgainst, pinWith, pctChangeSignedAtD1Close: +pctD1.toFixed(3) };
      }
    }
  }
  return episodes;
}

function summarize(episodes, pctKey) {
  const resolved = episodes.filter((e) => !e.ongoing && e.outcome !== undefined);
  const withMetric = resolved.filter((e) => e[pctKey] != null);
  const correct = withMetric.filter((e) => e[pctKey] > 0);
  const wrong = withMetric.filter((e) => e[pctKey] <= 0);
  const gp = correct.reduce((s, e) => s + Math.abs(e[pctKey]), 0);
  const gl = wrong.reduce((s, e) => s + Math.abs(e[pctKey]), 0);
  return {
    n: withMetric.length,
    winRate: withMetric.length ? +((correct.length / withMetric.length) * 100).toFixed(1) : null,
    pf: gl > 0 ? +(gp / gl).toFixed(2) : null,
    totalPct: +withMetric.reduce((s, e) => s + e[pctKey], 0).toFixed(2),
  };
}

(async () => {
  const results = {};
  for (const { pair } of STANDARD_PAIRS) {
    let bars;
    try { bars = await fetchYahooDailyOHLC(pair + "=X", `${YEARS_BACK}y`); }
    catch (e) { console.log(`${pair}: fetch ERR ${e.message}, přeskakuji`); continue; }
    if (bars.length < 30) { console.log(`${pair}: málo dat (${bars.length}), přeskakuji`); continue; }
    const episodes = findEpisodes(bars);
    results[pair] = { episodes };
    console.log(`${pair}: ${bars.length} dní, ${episodes.length} epizod`);
    await new Promise((res) => setTimeout(res, 120));
  }

  const allResolved = [];
  for (const pair in results) for (const ep of results[pair].episodes) {
    if (ep.ongoing || ep.outcome === "CHOP") continue;
    allResolved.push(ep);
  }
  // appka dnes: pctChange (signed podle výsledku — predicted correct = kladné)
  const appkaMetric = allResolved.map((e) => Object.assign({}, e, { _appka: e.outcome === "CORRECT" ? Math.abs(e.pctChange) : -Math.abs(e.pctChange) }));
  const withEM = allResolved.filter((e) => e.entryModel && e.entryModel.pctChangeSigned != null).map((e) => Object.assign({}, e, { _em: e.entryModel.pctChangeSigned }));
  const withD1 = allResolved.filter((e) => e.d1Candle);

  // D+1 exit varianta: pokud D+1 je pin PROTI směru, zavřít na D+1 close; jinak držet appka-metodou (pctChange)
  const d1ExitMetric = withD1.map((e) => {
    if (e.d1Candle.pinAgainst) return Object.assign({}, e, { _d1: e.d1Candle.pctChangeSignedAtD1Close });
    return Object.assign({}, e, { _d1: e.outcome === "CORRECT" ? Math.abs(e.pctChange) : -Math.abs(e.pctChange) });
  });

  const summaryAppka = summarize(appkaMetric, "_appka");
  const summaryEM = summarize(withEM, "_em");
  const summaryD1 = summarize(d1ExitMetric, "_d1");

  console.log("\n=== SROVNÁNÍ (celé 2leté okno, bez CHOP) ===");
  console.log("Appka dnes (drž do konce zóny):", JSON.stringify(summaryAppka));
  console.log(`Entry model (TP ${TP_ATR_MULT}×ATR / SL ${SL_ATR_MULT}×ATR):`, JSON.stringify(summaryEM));
  console.log("D+1 pin-proti-směru exit (jinak appka):", JSON.stringify(summaryD1));

  const out = {
    generated: new Date().toISOString(),
    methodology: `Point-in-time RP(10)/ER(10) na Yahoo denních OHLC (se/ne vyřazeno, konzistentní s appkou), 2leté okno. Entry model: TP=${TP_ATR_MULT}×ATR14 od onsetu, SL=${SL_ATR_MULT}×ATR14, kontrola denní high/low od D+1, při kolizi TP/SL ve stejném dni konzervativně SL první (pořadí uvnitř dne neznáme). D+1 exit: pokud první celý den po onsetu zavře jako pin svíčka PROTI směru signálu (knot ≥50% rozpětí), zavřít na jeho close; jinak appka standardní (drž do konce zóny). Vychází z vizuální kontroly Claude Cowork (TradingView/OANDA, 2026-10-11) na 12-14 korelovaných signálech jednoho týdne — tohle je stejná hypotéza ověřená na celém 2letém, nekorelovaném vzorku.`,
    params: { TP_ATR_MULT, SL_ATR_MULT, ATR_PERIOD, MIN_MOVE_PCT },
    comparison: { appkaDnes: summaryAppka, entryModelATR: summaryEM, d1PinExit: summaryD1 },
    perInstrument: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { episodeCount: v.episodes.length }])),
    episodes: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { episodes: v.episodes }])),
  };
  fs.writeFileSync(path.join(ROOT, "data", "backtest_rper_entry_model.json"), JSON.stringify(out));
  console.log("Uloženo do data/backtest_rper_entry_model.json");
})();

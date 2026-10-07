// RP+ER — intradenní (přesně LIVE styl appky) srovnávací backtest, DIAGNOSTICKÝ.
// scripts/backtest-rper.js počítá RP(10)/ER(10) JEDNOU DENNĚ z uzavírací ceny.
// Appka naživo (scripts/bias-alerts.js, engine.js getRangePosition/
// getEfficiencyRatio) ale čte data/prices.json.hist, jehož POSLEDNÍ záznam
// ("dnes") se přepisuje živou tikující cenou při KAŽDÉM 15min cronu — takže
// RP+ER se naživo přepočítává mnohokrát za den, ne jen jednou na close.
// Tenhle skript replikuje PŘESNĚ tu živou mechaniku: pro den D vezme 9
// posledních UZAVŘENÝCH denních cen (D-9..D-1, z data/fx_daily/*.json, stejný
// zdroj appka používá pro sezónnost) + intradenní cenovou cestu dne D (Yahoo)
// jako postupně se měnící "10. hodnotu", a sleduje, kolikrát/jak dlouho
// RP+ER zóna naskočí/zmizí BĚHEM JEDNOHO DNE — ne jen na konci dne.
//
// Yahoo intradenní historie má OMEZENÉ okno zpět (desítky dní, ne roky) —
// skript to zkouší (15m/60d, fallback 5m/60d, fallback 1m/7d) a HONESTNĚ
// reportuje, jaké okno se reálně povedlo stáhnout. Srovnání s denním
// backtestem (data/backtest_rper.json) se dělá JEN za stejné překrývající
// se okno, ať je to čestné (ne 2 roky denní vs pár týdnů intradenní).
//
// Výstup: data/backtest_rper_intraday.json — appka ho nečte, nic neovlivňuje.
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
const MIN_MOVE_PCT = 0.05;

async function fetchYahooIntraday(symbol, range, interval) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`, {
    signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!r.ok) throw new Error("Yahoo " + symbol + " HTTP " + r.status);
  const j = await r.json();
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  const ts = res && res.timestamp, closes = res && res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close;
  if (!Array.isArray(ts) || !Array.isArray(closes)) throw new Error("Yahoo " + symbol + ": neplatná struktura");
  return ts.map((t, i) => ({ t: t * 1000, date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
    .filter((r) => r.close != null && !isNaN(r.close));
}
// Appka pro FX kotuje páry base/quote jako quote-měna za 1 base-měnu
// (STANDARD_PAIRS), Yahoo FX symboly jsou "BASEQUOTE=X" — přesně stejný tvar
// jako appčin `pair` field, žádný převod navíc není potřeba.
async function fetchBestIntraday(pair) {
  const attempts = [["60d", "15m"], ["60d", "5m"], ["7d", "1m"]];
  for (const [range, interval] of attempts) {
    try {
      const rows = await fetchYahooIntraday(pair + "=X", range, interval);
      if (rows.length >= 50) return { rows, range, interval };
    } catch (e) { console.log(`${pair} ${range}/${interval} ERR ${e.message}`); }
  }
  return null;
}

function computeRpEr(priorCloses10, liveToday) {
  // priorCloses10: [D-10 .. D-1] chronologicky, přesně 10 uzavíracích cen.
  const rpWindow = priorCloses10.slice(1).concat([liveToday]); // D-9..D-1 + živá = 10 hodnot (stejně jako getRangePosition)
  let mn = Infinity, mx = -Infinity;
  for (const px of rpWindow) { if (px < mn) mn = px; if (px > mx) mx = px; }
  if (!(mx > mn)) return null;
  const rp = (liveToday - mn) / (mx - mn);
  let sumAbs = 0;
  for (let i = 1; i < priorCloses10.length; i++) sumAbs += Math.abs(priorCloses10[i] - priorCloses10[i - 1]);
  sumAbs += Math.abs(liveToday - priorCloses10[priorCloses10.length - 1]);
  if (sumAbs === 0) return { rp, er: null };
  const er = Math.abs(liveToday - priorCloses10[0]) / sumAbs; // stejně jako getEfficiencyRatio (days=10)
  return { rp, er };
}

function summarize(episodes) {
  const resolved = episodes.filter((e) => !e.ongoing);
  const correct = resolved.filter((e) => e.outcome === "CORRECT");
  const wrong = resolved.filter((e) => e.outcome === "WRONG");
  const chop = resolved.filter((e) => e.outcome === "CHOP");
  const decided = correct.length + wrong.length;
  const gp = correct.reduce((s, e) => s + Math.abs(e.pctChange), 0);
  const gl = wrong.reduce((s, e) => s + Math.abs(e.pctChange), 0);
  const avgMinutes = resolved.length ? resolved.reduce((s, e) => s + e.durationMinutes, 0) / resolved.length : null;
  return {
    total: episodes.length, resolved: resolved.length, ongoing: episodes.length - resolved.length,
    correct: correct.length, wrong: wrong.length, chop: chop.length,
    winRate: decided ? +((correct.length / decided) * 100).toFixed(1) : null,
    pf: gl > 0 ? +(gp / gl).toFixed(2) : null,
    avgDurationMinutes: avgMinutes != null ? +avgMinutes.toFixed(0) : null,
    underHour: resolved.filter((e) => e.durationMinutes < 60).length,
    underDay: resolved.filter((e) => e.durationMinutes < 24 * 60).length,
  };
}

(async () => {
  const results = {};
  let coverageStart = null, coverageEnd = null, coverageMeta = {};
  for (const { pair } of STANDARD_PAIRS) {
    let dailySeries;
    try { dailySeries = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "fx_daily", pair + ".json"), "utf8")); }
    catch (e) { console.log(pair + ": chybí data/fx_daily, přeskakuji"); continue; }
    const dDates = dailySeries.dates, dCloses = dailySeries.closes;
    const dateIdx = new Map(dDates.map((d, i) => [d, i]));

    console.log(`${pair}: stahuji intradenní historii…`);
    const intraday = await fetchBestIntraday(pair);
    if (!intraday) { console.log(pair + ": žádný intradenní zdroj nedostupný, přeskakuji"); continue; }
    coverageMeta[pair] = { range: intraday.range, interval: intraday.interval, bars: intraday.rows.length };
    const firstDay = intraday.rows[0].date, lastDay = intraday.rows[intraday.rows.length - 1].date;
    if (!coverageStart || firstDay < coverageStart) coverageStart = firstDay;
    if (!coverageEnd || lastDay > coverageEnd) coverageEnd = lastDay;

    // priorCloses10 cache per den (počítá se jen jednou na den, ne na bar)
    const priorCache = new Map();
    function priorClosesFor(day) {
      if (priorCache.has(day)) return priorCache.get(day);
      const idx = dateIdx.get(day);
      let result = null;
      if (idx != null && idx >= 10) result = dCloses.slice(idx - 10, idx); // D-10..D-1
      else {
        // den není v denní historii na přesný index (víkend/svátek) — najdi nejbližší předchozí index
        let i = dDates.length - 1;
        while (i >= 0 && dDates[i] >= day) i--;
        if (i >= 9) result = dCloses.slice(i - 9, i + 1);
      }
      priorCache.set(day, result);
      return result;
    }

    const episodes = [];
    let open = null;
    for (const bar of intraday.rows) {
      const priorCloses10 = priorClosesFor(bar.date);
      if (!priorCloses10 || priorCloses10.length !== 10) continue;
      const re = computeRpEr(priorCloses10, bar.close);
      if (!re || re.er == null) continue;
      const zone = re.rp >= 0.8 ? "high" : re.rp <= 0.2 ? "low" : null;

      if (open && zone !== open.zone) {
        open.resolvedT = bar.t; open.resolvedDate = bar.date; open.resolvedPrice = bar.close;
        open.durationMinutes = Math.round((bar.t - open.onsetT) / 60000);
        const pctChange = ((open.resolvedPrice - open.onsetPrice) / open.onsetPrice) * 100;
        open.pctChange = +pctChange.toFixed(3);
        const predictedDown = open.type === "SHORT";
        const moved = Math.abs(pctChange) > MIN_MOVE_PCT;
        const correct = moved && ((predictedDown && pctChange < 0) || (!predictedDown && pctChange > 0));
        open.outcome = !moved ? "CHOP" : correct ? "CORRECT" : "WRONG";
        episodes.push(open); open = null;
      }
      if (!open) {
        if (zone === "high" && re.er > 0.5) {
          open = { type: "SHORT", zone: "high", onsetT: bar.t, onsetDate: bar.date, onsetPrice: bar.close, onsetRP: +re.rp.toFixed(3), onsetER: +re.er.toFixed(3) };
        } else if (zone === "low" && re.er >= 0.2 && re.er < 0.65) {
          open = { type: "LONG", zone: "low", onsetT: bar.t, onsetDate: bar.date, onsetPrice: bar.close, onsetRP: +re.rp.toFixed(3), onsetER: +re.er.toFixed(3) };
        }
      }
    }
    if (open) { open.ongoing = true; episodes.push(open); }
    results[pair] = { episodes, stats: summarize(episodes), meta: coverageMeta[pair] };
    console.log(`${pair}: ${intraday.rows.length} barů (${intraday.range}/${intraday.interval}), ${episodes.length} epizod, win rate ${results[pair].stats.winRate}%, průměr trvání ${results[pair].stats.avgDurationMinutes} min`);
  }

  // Srovnání s DENNÍM backtestem — jen za stejné překrývající se okno.
  let dailyComparison = null;
  try {
    const dailyBt = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "backtest_rper.json"), "utf8"));
    const dailyInWindow = [];
    for (const { pair } of STANDARD_PAIRS) {
      const r = dailyBt.episodes && dailyBt.episodes[pair]; if (!r) continue;
      for (const ep of r.episodes) {
        if (ep.ongoing) continue;
        if (ep.onsetDate >= coverageStart && ep.onsetDate <= coverageEnd) dailyInWindow.push(ep);
      }
    }
    const gp = dailyInWindow.filter(e=>e.outcome==="CORRECT").reduce((s,e)=>s+Math.abs(e.pctChange),0);
    const gl = dailyInWindow.filter(e=>e.outcome==="WRONG").reduce((s,e)=>s+Math.abs(e.pctChange),0);
    const decided = dailyInWindow.filter(e=>e.outcome==="CORRECT"||e.outcome==="WRONG").length;
    const correct = dailyInWindow.filter(e=>e.outcome==="CORRECT").length;
    dailyComparison = {
      window: { start: coverageStart, end: coverageEnd },
      episodeCount: dailyInWindow.length,
      winRate: decided ? +((correct/decided)*100).toFixed(1) : null,
      pf: gl>0 ? +(gp/gl).toFixed(2) : null,
    };
  } catch (e) { console.log("Denní srovnání ERR", e.message); }

  const allIntraday = Object.values(results).flatMap(r => r.episodes);
  const overall = summarize(allIntraday);
  const out = {
    generated: new Date().toISOString(),
    methodology: "Intradenní (živý) styl RP+ER — replikuje PŘESNĚ to, co appka naživo posílá (data/prices.json.hist poslední záznam se přepisuje živou cenou každých ~15 min): pro den D se bere 9 posledních UZAVŘENÝCH denních cen (D-9..D-1) + intradenní cenová cesta dne D (Yahoo) jako postupně se měnící 'dnešní' hodnota. Okno zpět omezeno Yahoo intradenní historií (viz coverage) — NENÍ to 2 roky jako denní backtest, srovnání níže je proto JEN za překrývající se okno.",
    coverage: { start: coverageStart, end: coverageEnd, perPair: coverageMeta },
    overall,
    dailyComparisonSameWindow: dailyComparison,
    perInstrument: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.stats])),
    episodes: results,
  };
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "backtest_rper_intraday.json"), JSON.stringify(out));
  console.log("\n=== CELKEM INTRADENNÍ ===");
  console.log(JSON.stringify(overall, null, 2));
  console.log("\n=== SROVNÁNÍ: DENNÍ backtest za stejné okno ===");
  console.log(JSON.stringify(dailyComparison, null, 2));
  console.log("Zapsáno data/backtest_rper_intraday.json");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

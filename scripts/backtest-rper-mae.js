// RP+ER — MAE/MFE analýza (entry-model podklad), DIAGNOSTICKÝ, appka ho
// nečte. Cíl: na dostupném intradenním okně (Yahoo, ~60 dní zpět — delší
// historie Yahoo nenabízí, viz backtest-rper-intraday.js) zjistit, jak hluboko
// cena typicky jde PROTI směru RP+ER obchodu (MAE), než se (u výher) otočí
// směrem signálu — orientační vodítko pro SL/entry timing, ne pro výsledek
// obchodu samotný (ten měří scripts/backtest-rper.js na denním close).
//
// Metodika: vezme VYŘEŠENÉ (CORRECT/WRONG, CHOP vynechán — tam není co měřit)
// epizody z data/backtest_rper.json, jejichž onsetDate padne do staženého
// intradenního okna. Pro každou projde bar-by-bar cestu od onsetu (cca denní
// close, 21:00 UTC) do resolvedDate a spočítá:
//   MAE = nejhlubší pohyb PROTI směru obchodu během držení (v %, pak v pips)
//   MFE = nejlepší pohyb VE směru obchodu během držení
// Žádný look-ahead navíc — jen převzatý onset/resolved ze stávajícího
// denního backtestu, jen "vyplněný" intradenní cestou pro MAE.
//
// Výstup: data/backtest_rper_mae.json.
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
  return ts.map((t, i) => ({ t: t * 1000, close: closes[i] })).filter((r) => r.close != null && !isNaN(r.close));
}
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
function pipSize(pair) { return pair.includes("JPY") ? 0.01 : 0.0001; }
function avg(arr, key) { return arr.length ? arr.reduce((s, r) => s + r[key], 0) / arr.length : null; }
function median(arr, key) { const s = arr.map((r) => r[key]).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; }

(async () => {
  const bt = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "backtest_rper.json"), "utf8"));
  const results = [];
  const coverage = {};
  for (const { pair } of STANDARD_PAIRS) {
    const episodesRaw = bt.episodes[pair];
    if (!episodesRaw) continue;
    const resolved = episodesRaw.episodes.filter((e) => !e.ongoing && (e.outcome === "CORRECT" || e.outcome === "WRONG"));
    if (!resolved.length) continue;
    const best = await fetchBestIntraday(pair);
    if (!best) { console.log(pair, "intraday fetch selhal, přeskakuji"); continue; }
    const windowStart = best.rows[0].t, windowEnd = best.rows[best.rows.length - 1].t;
    const inWindow = resolved.filter((e) => {
      const onsetT = new Date(e.onsetDate + "T21:00:00Z").getTime();
      return onsetT >= windowStart && onsetT <= windowEnd;
    });
    coverage[pair] = { range: best.range, interval: best.interval, barsTotal: best.rows.length, episodesInWindow: inWindow.length };
    if (!inWindow.length) continue;
    for (const ep of inWindow) {
      const onsetT = new Date(ep.onsetDate + "T21:00:00Z").getTime();
      const resolvedT = new Date(ep.resolvedDate + "T21:00:00Z").getTime();
      const bars = best.rows.filter((r) => r.t >= onsetT && r.t <= resolvedT);
      if (bars.length < 2) continue;
      const entry = bars[0].close;
      const dirSign = ep.type === "LONG" ? 1 : -1;
      let mae = 0, mfe = 0;
      for (const b of bars) {
        const movePct = ((b.close - entry) / entry) * 100 * dirSign;
        if (movePct < mae) mae = movePct;
        if (movePct > mfe) mfe = movePct;
      }
      const pip = pipSize(pair);
      results.push({
        pair, type: ep.type, onsetDate: ep.onsetDate, resolvedDate: ep.resolvedDate, outcome: ep.outcome,
        maePct: +mae.toFixed(3), mfePct: +mfe.toFixed(3),
        maePips: +((Math.abs(mae) / 100 * entry) / pip).toFixed(1),
        mfePips: +((mfe / 100 * entry) / pip).toFixed(1),
        finalPct: ep.pctChange,
      });
    }
    console.log(pair, "OK —", inWindow.length, "epizod v okně (" + best.range + "/" + best.interval + ")");
  }

  const winners = results.filter((r) => r.outcome === "CORRECT");
  const losers = results.filter((r) => r.outcome === "WRONG");
  const maeDist = (arr) => [5, 10, 15, 20, 30, 50].map((th) => ({
    th, pct: arr.length ? +((arr.filter((r) => r.maePips <= th).length / arr.length) * 100).toFixed(0) : null,
  }));

  const out = {
    generated: new Date().toISOString(),
    methodology: "MAE/MFE na dostupném ~60denním intradenním (Yahoo) okně, pro VYŘEŠENÉ (CORRECT/WRONG) nefiltrované RP+ER epizody z data/backtest_rper.json, jejichž onsetDate padne do okna. MAE = nejhlubší pohyb proti směru obchodu mezi onsetem a resolvedDate, MFE = nejlepší pohyb ve směru. Orientační vodítko pro SL/entry, NE náhrada denního backtestu (ten měří výsledek, tohle cestu k němu).",
    coverage,
    summary: {
      winners: { n: winners.length, avgMaePips: +((avg(winners, "maePips")) || 0).toFixed(1), medianMaePips: median(winners, "maePips"), avgMaePct: +((avg(winners, "maePct")) || 0).toFixed(3), maeDistribution: maeDist(winners) },
      losers: { n: losers.length, avgMaePips: +((avg(losers, "maePips")) || 0).toFixed(1), medianMaePips: median(losers, "maePips"), avgMaePct: +((avg(losers, "maePct")) || 0).toFixed(3), maeDistribution: maeDist(losers) },
    },
    episodes: results,
  };
  fs.writeFileSync(path.join(ROOT, "data", "backtest_rper_mae.json"), JSON.stringify(out, null, 1));
  console.log("\nCelkem epizod s MAE daty:", results.length, "(výhry", winners.length, "/ prohry", losers.length + ")");
})();

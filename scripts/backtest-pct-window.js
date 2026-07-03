// Srovnávací backtest: COT percentil přes CELOU (rostoucí) historii vs PEVNÉ okno 78 týdnů.
// Kontext: engine.js používá percentil jedině jako přepínač "extrém" (>=85 / <=15):
//   1) scoreCurrency: extrém -> váha COT 0.80 místo 0.45 (zesílení vlivu COT na skóre),
//   2) buildForecastV5: extrém -> cotAdj ±5/±7 bodů pravděpodobnosti.
// Otázka tedy zní: KTERÁ definice extrému označuje týdny, kdy je COT signál skutečně
// prediktivnější (a zaslouží si zesílení)? Měříme forward výnos obchodů ve směru COT
// diffu v týdnech označených každou variantou. Žádný look-ahead: percentil v týdnu d
// se počítá jen z týdnů <= d (stejná semantika jako getCOTPercentile: aktuální hodnota
// vs OSTATNÍ hodnoty okna).
// Spouští se ručně přes workflow_dispatch (pct-window-test.yml) — jednorázová analýza,
// nezapisuje žádná data, jen tiskne výsledky do logu.
const CFTC_TFF_DATASET = "gpe5-46if";
const COT_MARKETS = {
  EUR: "EURO FX", GBP: "BRITISH POUND", JPY: "JAPANESE YEN", AUD: "AUSTRALIAN DOLLAR",
  CAD: "CANADIAN DOLLAR", CHF: "SWISS FRANC", NZD: "NZ DOLLAR",
};
const CUR = ["EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
const CURRENCIES = [...CUR, "USD"];
const STANDARD_PAIRS = [
  ["EURUSD","EUR","USD"],["USDJPY","USD","JPY"],["GBPUSD","GBP","USD"],["AUDUSD","AUD","USD"],
  ["USDCAD","USD","CAD"],["USDCHF","USD","CHF"],["NZDUSD","NZD","USD"],["EURGBP","EUR","GBP"],
  ["EURCHF","EUR","CHF"],["EURAUD","EUR","AUD"],["EURCAD","EUR","CAD"],["EURJPY","EUR","JPY"],
  ["EURNZD","EUR","NZD"],["GBPCHF","GBP","CHF"],["GBPJPY","GBP","JPY"],["GBPAUD","GBP","AUD"],
  ["GBPCAD","GBP","CAD"],["GBPNZD","GBP","NZD"],["AUDCAD","AUD","CAD"],["AUDJPY","AUD","JPY"],
  ["AUDNZD","AUD","NZD"],["AUDCHF","AUD","CHF"],["NZDCAD","NZD","CAD"],["NZDJPY","NZD","JPY"],
  ["NZDCHF","NZD","CHF"],["CADJPY","CAD","JPY"],["CADCHF","CAD","CHF"],["CHFJPY","CHF","JPY"],
].map(([pair, base, quote]) => ({ pair, base, quote }));
const WINDOW = 78;          // testovaná délka pevného okna (aktuální COT_PCT_WINDOW v engine.js)
const DIFF_MIN = 1;         // minimální |COT diff| páru, aby šlo o reálný signál
const HORIZONS = [1, 4];    // týdny dopředu
const MIN_SAMPLES = 12;     // percentil potřebuje aspoň 12 týdnů (stejně jako engine)

function cftcNum(row, names) {
  for (const n of names) { const v = row[n]; if (v != null && v !== "") { const f = parseFloat(v); if (!isNaN(f)) return f; } }
  return null;
}
function cotNetScore(l, s) {
  l = Number(l) || 0; s = Number(s) || 0;
  const ratio = (l + s) > 0 ? (l - s) / (l + s) : 0;
  return parseFloat(Math.max(-3, Math.min(3, ratio * 6)).toFixed(1));
}
function scoreWeek(rows) {
  const out = {};
  for (const [ccy, market] of Object.entries(COT_MARKETS)) {
    const row = rows.find((r) => {
      const nm = String(r.market_and_exchange_names || r.contract_market_name || "").toUpperCase();
      return nm.includes(market) && nm.includes("CHICAGO MERCANTILE");
    });
    if (!row) continue;
    const aL = cftcNum(row, ["asset_mgr_positions_long", "asset_mgr_positions_long_all"]);
    const aS = cftcNum(row, ["asset_mgr_positions_short", "asset_mgr_positions_short_all"]);
    const lL = cftcNum(row, ["lev_money_positions_long", "lev_money_positions_long_all"]);
    const lS = cftcNum(row, ["lev_money_positions_short", "lev_money_positions_short_all"]);
    if ([aL, aS, lL, lS].some((v) => v == null)) continue;
    out[ccy] = parseFloat((cotNetScore(lL, lS) * 0.70 + cotNetScore(aL, aS) * 0.30).toFixed(1));
  }
  const vals = Object.values(out);
  if (vals.length < 5) return null;
  out.USD = parseFloat((-vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1));
  return out;
}

// Percentil hodnoty poslední položky okna vs ostatní položky okna (semantika getCOTPercentile).
function pctOf(arr) {
  if (arr.length < MIN_SAMPLES) return null;
  const cur = arr[arr.length - 1], hist = arr.slice(0, -1);
  return Math.round((hist.filter((x) => x <= cur).length / hist.length) * 100);
}
const isExt = (p) => p != null && (p >= 85 || p <= 15);

function priceOnOrAfter(s, targetMs) {
  let lo = 0, hi = s.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; const t = Date.parse(s[mid].date + "T00:00:00Z");
    if (t >= targetMs) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
  return ans < 0 ? null : s[ans].v;
}
function pairPrice(series, base, quote, targetMs) {
  const b = priceOnOrAfter(series[base] || [], targetMs);
  const q = priceOnOrAfter(series[quote] || [], targetMs);
  if (b == null || q == null || q === 0) return null;
  return q / b;
}
function agg(trades) {
  const n = trades.length;
  if (!n) return { n: 0, wr: null, pf: null, avg: null };
  const wins = trades.filter((t) => t.ret > 0).length;
  const gp = trades.filter((t) => t.ret > 0).reduce((a, b) => a + b.ret, 0);
  const gl = Math.abs(trades.filter((t) => t.ret < 0).reduce((a, b) => a + b.ret, 0));
  return { n, wr: +(wins / n * 100).toFixed(1), pf: gl > 0 ? +(gp / gl).toFixed(3) : null, avg: +(trades.reduce((a, b) => a + b.ret, 0) / n).toFixed(3) };
}
const fmt = (a) => a.n ? `WR ${a.wr}% · PF ${a.pf} · avg ${a.avg > 0 ? "+" : ""}${a.avg}% · n=${a.n}` : "n=0";

(async () => {
  // ~5 let COT historie
  const cutoff = new Date(Date.now() - 1850 * 86400000).toISOString().slice(0, 10);
  const base = "https://publicreporting.cftc.gov/resource/" + CFTC_TFF_DATASET + ".json";
  const where = encodeURIComponent("report_date_as_yyyy_mm_dd > '" + cutoff + "T00:00:00.000'");
  const r = await fetch(base + "?$where=" + where + "&$order=" + encodeURIComponent("report_date_as_yyyy_mm_dd ASC") + "&$limit=50000", { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error("CFTC HTTP " + r.status);
  const rows = await r.json();
  const byDate = {};
  for (const row of rows) { const d = String(row.report_date_as_yyyy_mm_dd || "").slice(0, 10); if (d) (byDate[d] = byDate[d] || []).push(row); }
  const dates = Object.keys(byDate).sort();
  const weeks = {};
  for (const d of dates) { const w = scoreWeek(byDate[d]); if (w) weeks[d] = w; }
  const wDates = Object.keys(weeks).sort();
  console.log(`COT: ${wDates.length} týdnů ${wDates[0]} → ${wDates.at(-1)}`);

  const fr = await fetch(`https://api.frankfurter.app/${wDates[0]}..${new Date().toISOString().slice(0, 10)}?from=USD&to=${CUR.join(",")}`, { signal: AbortSignal.timeout(60000) });
  if (!fr.ok) throw new Error("Frankfurter HTTP " + fr.status);
  const ratesByDate = (await fr.json()).rates;
  const series = { USD: [] }; CUR.forEach((c) => (series[c] = []));
  for (const d of Object.keys(ratesByDate).sort()) {
    series.USD.push({ date: d, v: 1 });
    CUR.forEach((c) => { if (ratesByDate[d][c] != null) series[c].push({ date: d, v: ratesByDate[d][c] }); });
  }
  console.log(`Kurzy: ${Object.keys(ratesByDate).length} dní`);

  // Percentily obou variant pro každý týden (bez look-ahead)
  const pctFull = {}, pctWin = {};
  CURRENCIES.forEach((c) => { pctFull[c] = {}; pctWin[c] = {}; });
  CURRENCIES.forEach((c) => {
    const hist = [];
    for (const d of wDates) {
      const v = weeks[d][c]; if (typeof v !== "number") continue;
      hist.push(v);
      pctFull[c][d] = pctOf(hist);
      pctWin[c][d] = pctOf(hist.slice(-WINDOW));
    }
  });

  // Míra neshody přepínače extrému mezi variantami (po zahřátí obou variant)
  let both = 0, disagree = 0; const disagreeByCur = {};
  for (const c of CURRENCIES) for (const d of wDates) {
    const f = pctFull[c][d], w = pctWin[c][d];
    if (f == null || w == null) continue;
    both++;
    if (isExt(f) !== isExt(w)) { disagree++; disagreeByCur[c] = (disagreeByCur[c] || 0) + 1; }
  }
  console.log(`\nNeshoda extrém-přepínače (celá vs okno ${WINDOW}t): ${disagree}/${both} = ${(disagree / both * 100).toFixed(1)}% pozorování`);
  console.log("  po měnách:", JSON.stringify(disagreeByCur));

  for (const h of HORIZONS) {
    const horizonMs = h * 7 * 86400000;
    // extF/extW: obchody, kde by daná varianta zesílila COT vliv (base NEBO quote v extrému)
    const extF = [], extW = [], onlyF = [], onlyW = [], noneBoth = [];
    for (const pr of STANDARD_PAIRS) {
      for (const d of wDates) {
        const sc = weeks[d];
        const diff = (sc[pr.base] ?? 0) - (sc[pr.quote] ?? 0);
        if (Math.abs(diff) < DIFF_MIN) continue;
        const fB = pctFull[pr.base][d], fQ = pctFull[pr.quote][d];
        const wB = pctWin[pr.base][d], wQ = pctWin[pr.quote][d];
        if ([fB, fQ, wB, wQ].some((x) => x == null)) continue; // srovnávej jen kde obě varianty existují
        const t0 = Date.parse(d + "T00:00:00Z");
        const p0 = pairPrice(series, pr.base, pr.quote, t0);
        const p1 = pairPrice(series, pr.base, pr.quote, t0 + horizonMs);
        if (p0 == null || p1 == null) continue;
        const dir = diff > 0 ? 1 : -1;
        const tr = { ret: (p1 / p0 - 1) * dir * 100 };
        const eF = isExt(fB) || isExt(fQ), eW = isExt(wB) || isExt(wQ);
        if (eF) extF.push(tr);
        if (eW) extW.push(tr);
        if (eF && !eW) onlyF.push(tr);
        if (eW && !eF) onlyW.push(tr);
        if (!eF && !eW) noneBoth.push(tr);
      }
    }
    console.log(`\n── Horizont ${h} týden/týdny (|diff| ≥ ${DIFF_MIN}) ──`);
    console.log(`  Zesíleno dle CELÉ historie : ${fmt(agg(extF))}`);
    console.log(`  Zesíleno dle OKNA ${WINDOW}t     : ${fmt(agg(extW))}`);
    console.log(`  Jen CELÁ (okno by nezesílilo): ${fmt(agg(onlyF))}`);
    console.log(`  Jen OKNO (celá by nezesílila): ${fmt(agg(onlyW))}`);
    console.log(`  Bez extrému (obě shodně)   : ${fmt(agg(noneBoth))}`);
  }
  console.log("\nHOTOVO");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

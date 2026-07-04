// Sweep délky okna COT percentilu — hledá variantu s nejlepším vlivem na skóre.
// Engine používá percentil jedině jako přepínač "extrém" (>=85/<=15), který ve
// scoreCurrency zesílí váhu COT z 0.45 na 0.80. Dobrá definice okna tedy je ta,
// při které extrém označuje týdny, kdy je COT signál skutečně prediktivnější.
// Testujeme na maximu dostupné TFF historie (od 2010), bez look-ahead, a robustnost
// kontrolujeme rozpadem na první/druhou polovinu období, ať nevybíráme okno sedící
// jen na jeden režim trhu.
// Ruční spuštění přes pct-window-test.yml, nic nezapisuje — výsledky v logu.
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
const WINDOWS = [26, 52, 78, 104, 130, 156, 208, 260, 0]; // 0 = rostoucí CELÁ historie
const WARMUP = 260;        // společný start hodnocení — všechna okna už definovaná
const DIFF_MIN = 1;
const HORIZONS = [1, 4];
const MIN_SAMPLES = 12;

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
function agg(tr) {
  const n = tr.length;
  if (!n) return { n: 0, wr: null, pf: null, avg: null };
  const wins = tr.filter((t) => t.ret > 0).length;
  const gp = tr.filter((t) => t.ret > 0).reduce((a, b) => a + b.ret, 0);
  const gl = Math.abs(tr.filter((t) => t.ret < 0).reduce((a, b) => a + b.ret, 0));
  return { n, wr: +(wins / n * 100).toFixed(1), pf: gl > 0 ? +(gp / gl).toFixed(3) : null, avg: +(tr.reduce((a, b) => a + b.ret, 0) / n).toFixed(3) };
}
const F = (a) => a.n ? `WR ${String(a.wr).padStart(4)}% PF ${String(a.pf).padStart(5)} avg ${(a.avg > 0 ? "+" : "") + a.avg}% n=${a.n}` : "n=0";

(async () => {
  const base = "https://publicreporting.cftc.gov/resource/" + CFTC_TFF_DATASET + ".json";
  const where = encodeURIComponent("report_date_as_yyyy_mm_dd > '2010-01-01T00:00:00.000'");
  const common = base + "?$where=" + where + "&$order=" + encodeURIComponent("report_date_as_yyyy_mm_dd ASC") + "&$limit=200000";
  // Dataset má JEN jednu variantu názvů pozičních sloupců (s/bez "_all") — $select s
  // neexistujícím sloupcem vrací 400. Zkoušíme varianty, poslední záchrana bez $select.
  const meta = "report_date_as_yyyy_mm_dd,market_and_exchange_names,contract_market_name";
  const posPlain = "asset_mgr_positions_long,asset_mgr_positions_short,lev_money_positions_long,lev_money_positions_short";
  const posAll = posPlain.split(",").map((c) => c + "_all").join(",");
  const attempts = [
    common + "&$select=" + encodeURIComponent(meta + "," + posPlain),
    common + "&$select=" + encodeURIComponent(meta + "," + posAll),
    common,
  ];
  let rows = null;
  for (const url of attempts) {
    const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (r.ok) { rows = await r.json(); console.log("CFTC dotaz OK (varianta " + (attempts.indexOf(url) + 1) + "/3)"); break; }
    console.log("CFTC varianta " + (attempts.indexOf(url) + 1) + " HTTP " + r.status + " — zkouším další");
  }
  if (!rows) throw new Error("CFTC: všechny varianty dotazu selhaly");
  const byDate = {};
  for (const row of rows) { const d = String(row.report_date_as_yyyy_mm_dd || "").slice(0, 10); if (d) (byDate[d] = byDate[d] || []).push(row); }
  const weeks = {};
  for (const d of Object.keys(byDate).sort()) { const w = scoreWeek(byDate[d]); if (w) weeks[d] = w; }
  const wDates = Object.keys(weeks).sort();
  console.log(`COT: ${wDates.length} týdnů ${wDates[0]} → ${wDates.at(-1)} (řádků z API: ${rows.length})`);

  const fr = await fetch(`https://api.frankfurter.app/${wDates[0]}..${new Date().toISOString().slice(0, 10)}?from=USD&to=${CUR.join(",")}`, { signal: AbortSignal.timeout(120000) });
  if (!fr.ok) throw new Error("Frankfurter HTTP " + fr.status);
  const ratesByDate = (await fr.json()).rates;
  const series = { USD: [] }; CUR.forEach((c) => (series[c] = []));
  for (const d of Object.keys(ratesByDate).sort()) {
    series.USD.push({ date: d, v: 1 });
    CUR.forEach((c) => { if (ratesByDate[d][c] != null) series[c].push({ date: d, v: ratesByDate[d][c] }); });
  }
  console.log(`Kurzy: ${Object.keys(ratesByDate).length} dní`);

  // Percentily pro každé okno (0 = expanding) — bez look-ahead
  const pct = {}; // pct[W][c][d]
  for (const W of WINDOWS) {
    pct[W] = {}; CURRENCIES.forEach((c) => (pct[W][c] = {}));
    CURRENCIES.forEach((c) => {
      const hist = [];
      for (const d of wDates) {
        const v = weeks[d][c]; if (typeof v !== "number") continue;
        hist.push(v);
        pct[W][c][d] = pctOf(W === 0 ? hist : hist.slice(-W));
      }
    });
  }

  const evalDates = wDates.slice(WARMUP);
  const midDate = evalDates[Math.floor(evalDates.length / 2)];
  console.log(`Hodnocení: ${evalDates.length} týdnů ${evalDates[0]} → ${evalDates.at(-1)} · poloviny děleny ${midDate}`);

  // Předpočítej obchody (nezávislé na okně)
  const tradesByH = {};
  for (const h of HORIZONS) {
    const horizonMs = h * 7 * 86400000;
    const list = [];
    for (const pr of STANDARD_PAIRS) {
      for (const d of evalDates) {
        const sc = weeks[d];
        const diff = (sc[pr.base] ?? 0) - (sc[pr.quote] ?? 0);
        if (Math.abs(diff) < DIFF_MIN) continue;
        const t0 = Date.parse(d + "T00:00:00Z");
        const p0 = pairPrice(series, pr.base, pr.quote, t0);
        const p1 = pairPrice(series, pr.base, pr.quote, t0 + horizonMs);
        if (p0 == null || p1 == null) continue;
        const dir = diff > 0 ? 1 : -1;
        list.push({ d, base: pr.base, quote: pr.quote, dir, ret: (p1 / p0 - 1) * dir * 100, firstHalf: d < midDate });
      }
    }
    tradesByH[h] = list;
    console.log(`Obchodů (|diff|≥${DIFF_MIN}, ${h}t): ${list.length}`);
  }

  for (const h of HORIZONS) {
    console.log(`\n════ HORIZONT ${h} TÝDEN/TÝDNY ════`);
    console.log("Okno | ZESÍLENÉ (extrém na některé noze) | zbytek | Δavg (zesíl−zbytek) | zesíl. avg 1.pol/2.pol");
    for (const W of WINDOWS) {
      const amp = [], rest = [];
      for (const t of tradesByH[h]) {
        const pB = pct[W][t.base][t.d], pQ = pct[W][t.quote][t.d];
        if (pB == null || pQ == null) continue;
        (isExt(pB) || isExt(pQ) ? amp : rest).push(t);
      }
      const a = agg(amp), b = agg(rest);
      const a1 = agg(amp.filter((t) => t.firstHalf)), a2 = agg(amp.filter((t) => !t.firstHalf));
      const dAvg = a.n && b.n ? (a.avg - b.avg).toFixed(3) : "—";
      console.log(`${String(W === 0 ? "FULL" : W).padStart(4)} | ${F(a)} | ${F(b)} | ${dAvg} | ${a1.avg}/${a2.avg}`);
    }
    // Favored-side pohled: percentil MĚNY, na kterou obchod sází — přímo interpretovatelný
    // pro rozhodnutí zesílit/ztlumit (crowded ve prospěch vs sázka na vymlácenou měnu).
    console.log("Okno | favored>=85 (crowded ve prospěch) | favored<=15 (sázka na dno) | střed");
    for (const W of WINDOWS) {
      const hi = [], lo = [], mid = [];
      for (const t of tradesByH[h]) {
        const fav = t.dir === 1 ? t.base : t.quote;
        const p = pct[W][fav][t.d]; if (p == null) continue;
        (p >= 85 ? hi : p <= 15 ? lo : mid).push(t);
      }
      console.log(`${String(W === 0 ? "FULL" : W).padStart(4)} | ${F(agg(hi))} | ${F(agg(lo))} | ${F(agg(mid))}`);
    }
  }
  console.log("\nHOTOVO");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

// COT (CFTC Traders in Financial Futures) — server-side historický cron.
// Stahuje týdenní reporty z oficiálního Socrata API (bez klíče, CORS-native,
// stejný dataset jako klientský fetchCOTViaAPI() v engine.js) a počítá stejné
// skóre. Appka pak data/cot_hist.json merguje do lokální historie
// (loadCOTHistory) na každém loadu → COT historie se doplňuje automaticky,
// bez ručního importu z classic.html.
const fs = require("fs");
const CFTC_TFF_DATASET = "gpe5-46if";
const COT_MARKETS = {
  EUR: "EURO FX", GBP: "BRITISH POUND", JPY: "JAPANESE YEN", AUD: "AUSTRALIAN DOLLAR",
  CAD: "CANADIAN DOLLAR", CHF: "SWISS FRANC", NZD: "NZ DOLLAR",
};
const COT_DEFAULT = Object.fromEntries(Object.keys(COT_MARKETS).map((c) => [c, 0]));

function cftcNum(row, names) {
  for (const n of names) { const v = row[n]; if (v != null && v !== "") { const f = parseFloat(v); if (!isNaN(f)) return f; } }
  return null;
}
function cotNet(longPos, shortPos) {
  const l = Number(longPos) || 0, s = Number(shortPos) || 0;
  return { long: l, short: s, net: l - s, ratio: (l + s) > 0 ? (l - s) / (l + s) : 0 };
}
function cotNetScore(longPos, shortPos) {
  const n = cotNet(longPos, shortPos);
  return parseFloat(Math.max(-3, Math.min(3, n.ratio * 6)).toFixed(1));
}
function cotExtremeFromRatio(r) {
  const abs = Math.abs(r);
  if (abs >= 0.5) return { level: "EXTREME", label: r > 0 ? "crowded long" : "crowded short", color: r > 0 ? "#3fb950" : "#f85149" };
  if (abs >= 0.32) return { level: "HIGH", label: r > 0 ? "silně long" : "silně short", color: r > 0 ? "#3fb950" : "#f85149" };
  return { level: "NORMAL", label: "bez extrému", color: "#8b949e" };
}

// Stejný výpočet skóre/raw jako fetchCOTViaAPI() v engine.js, jen pro libovolný
// (historický) týden řádků, ne jen pro nejnovější.
function scoreWeek(rows) {
  const out = {}, raw = {};
  for (const [ccy, market] of Object.entries(COT_MARKETS)) {
    const row = rows.find((r) => {
      const nm = String(r.market_and_exchange_names || r.contract_market_name || "").toUpperCase();
      return nm.includes(market) && nm.includes("CHICAGO MERCANTILE");
    });
    if (!row) continue;
    const assetLong = cftcNum(row, ["asset_mgr_positions_long", "asset_mgr_positions_long_all"]);
    const assetShort = cftcNum(row, ["asset_mgr_positions_short", "asset_mgr_positions_short_all"]);
    const levLong = cftcNum(row, ["lev_money_positions_long", "lev_money_positions_long_all"]);
    const levShort = cftcNum(row, ["lev_money_positions_short", "lev_money_positions_short_all"]);
    if ([assetLong, assetShort, levLong, levShort].some((v) => v == null)) continue;
    const asset = cotNet(assetLong, assetShort), lev = cotNet(levLong, levShort);
    const assetScore = cotNetScore(assetLong, assetShort), levScore = cotNetScore(levLong, levShort);
    const score = parseFloat((levScore * 0.70 + assetScore * 0.30).toFixed(1));
    const levChange = (cftcNum(row, ["change_in_lev_money_long", "change_in_lev_money_long_all"]) || 0) - (cftcNum(row, ["change_in_lev_money_short", "change_in_lev_money_short_all"]) || 0);
    const assetChange = (cftcNum(row, ["change_in_asset_mgr_long", "change_in_asset_mgr_long_all"]) || 0) - (cftcNum(row, ["change_in_asset_mgr_short", "change_in_asset_mgr_short_all"]) || 0);
    const flow = levChange * 0.70 + assetChange * 0.30;
    out[ccy] = score;
    raw[ccy] = { market, assetLong, assetShort, levLong, levShort, assetNet: asset.net, levNet: lev.net, levRatio: lev.ratio, assetRatio: asset.ratio,
      levScore, assetScore, score, levChange, assetChange, flow: Math.round(flow), extreme: cotExtremeFromRatio(lev.ratio) };
  }
  const vals = Object.values(out).filter((v) => typeof v === "number" && !isNaN(v));
  if (vals.length < 5) return null;
  out.USD = parseFloat((-vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1));
  const flows = Object.values(raw).map((r) => r.flow || 0);
  raw.USD = { market: "syntetický USD koš", note: "opačný průměr dostupných non-USD COT měn", score: out.USD, flow: flows.length ? Math.round(-flows.reduce((a, b) => a + b, 0) / flows.length) : 0, extreme: { level: "SYNTH", label: "syntetický koš", color: "#8b949e" } };
  return { scores: { ...COT_DEFAULT, ...out }, raw };
}

(async () => {
  // ~28 měsíců zpět — kryje COT_PCT_WINDOW=104 týdnů v engine.js (percentil pro
  // forecast/UI čte čistě serverový snapshot) + rezerva, bez rizika překročení $limit.
  const cutoff = new Date(Date.now() - 850 * 86400000).toISOString().slice(0, 10);
  const base = "https://publicreporting.cftc.gov/resource/" + CFTC_TFF_DATASET + ".json";
  const where = encodeURIComponent("report_date_as_yyyy_mm_dd > '" + cutoff + "T00:00:00.000'");
  const order = encodeURIComponent("report_date_as_yyyy_mm_dd ASC");
  const r = await fetch(base + "?$where=" + where + "&$order=" + order + "&$limit=50000", { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("CFTC API HTTP " + r.status);
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error("CFTC API: 0 řádků");

  const byDate = {};
  for (const row of rows) {
    const d = String(row.report_date_as_yyyy_mm_dd || "").slice(0, 10);
    if (!d) continue;
    (byDate[d] = byDate[d] || []).push(row);
  }

  const weeks = {};
  const updatedAt = new Date().toISOString();
  for (const [date, weekRows] of Object.entries(byDate)) {
    const w = scoreWeek(weekRows);
    if (w) weeks[date] = { scores: w.scores, raw: w.raw, updatedAt };
  }
  const n = Object.keys(weeks).length;
  if (n < 5) throw new Error("namapováno jen " + n + " týdnů — zdroj/schéma se možná změnilo");

  let prevWeeks = {};
  try { prevWeeks = JSON.parse(fs.readFileSync("data/cot_hist.json", "utf8")).weeks || {}; } catch (e) {}
  const same = Object.keys(weeks).length === Object.keys(prevWeeks).length &&
    Object.keys(weeks).every((k) => JSON.stringify(weeks[k].scores) === JSON.stringify((prevWeeks[k] || {}).scores));
  if (same) { console.log("COT historie beze změny, nepřepisuji."); process.exit(0); }

  const out = { updated: updatedAt, source: "CFTC oficiální API (TFF Futures-Only)", weeks };
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/cot_hist.json", JSON.stringify(out));
  console.log("OK · týdnů:", n);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

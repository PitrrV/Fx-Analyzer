// US100 (Nasdaq-100) — COT historie, samostatný pipeline nezávislý na FX
// (fetch-cot.js zůstává beze změny). Píše data/us100_cot.json, které si appka
// stahuje do VLASTNÍHO localStorage klíče (us100_cot_hist) — viz
// fetchActionUS100Cot() v engine.js. Nikdy nezapisuje do data/cot_hist.json.
//
// Nasdaq-100 je finanční future, takže je (na rozdíl od zlata) ve stejném TFF
// datasetu appka už používá pro FX COT (viz probe-gold-us100.js) — jen jiný
// market_and_exchange_names filtr. Používá "Consolidated" řádek (sčítá
// standardní + Micro E-mini kontrakt), ne jen jeden z nich.
const fs = require("fs");

const COT_DATASET = "gpe5-46if";
const COT_MARKET_NAME = "NASDAQ-100 CONSOLIDATED";
const COT_MARKET_EXCH = "CHICAGO MERCANTILE EXCHANGE";

function cftcNum(row, names) {
  for (const n of names) { const v = row[n]; if (v != null && v !== "") { const f = parseFloat(v); if (!isNaN(f)) return f; } }
  return null;
}
function cotNet(longPos, shortPos) {
  const l = Number(longPos) || 0, s = Number(shortPos) || 0;
  return { long: l, short: s, net: l - s, ratio: (l + s) > 0 ? (l - s) / (l + s) : 0 };
}
// Stejný vzorec jako appka používá pro FX měny (viz cotNetScore ve fetch-cot.js) —
// ať je škála a logika US100 skóre srovnatelná s tím, co appka už zná.
function cotNetScore(longPos, shortPos) {
  const n = cotNet(longPos, shortPos);
  return parseFloat(Math.max(-3, Math.min(3, n.ratio * 6)).toFixed(1));
}

async function fetchCOTHistory() {
  const cutoff = new Date(Date.now() - 850 * 86400000).toISOString().slice(0, 10); // ~28 měsíců, stejně jako fetch-cot.js
  const base = "https://publicreporting.cftc.gov/resource/" + COT_DATASET + ".json";
  const where = encodeURIComponent(
    "report_date_as_yyyy_mm_dd > '" + cutoff + "T00:00:00.000' AND upper(market_and_exchange_names) like '%" + COT_MARKET_NAME + "%'"
  );
  const order = encodeURIComponent("report_date_as_yyyy_mm_dd ASC");
  const r = await fetch(base + "?$where=" + where + "&$order=" + order + "&$limit=1000", { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("CFTC API HTTP " + r.status);
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error("CFTC API: 0 řádků pro " + COT_MARKET_NAME);

  const hist = {};
  for (const row of rows) {
    const nm = String(row.market_and_exchange_names || "").toUpperCase();
    if (!nm.includes(COT_MARKET_EXCH)) continue;
    const date = String(row.report_date_as_yyyy_mm_dd || "").slice(0, 10);
    if (!date) continue;
    const assetLong = cftcNum(row, ["asset_mgr_positions_long", "asset_mgr_positions_long_all"]);
    const assetShort = cftcNum(row, ["asset_mgr_positions_short", "asset_mgr_positions_short_all"]);
    const levLong = cftcNum(row, ["lev_money_positions_long", "lev_money_positions_long_all"]);
    const levShort = cftcNum(row, ["lev_money_positions_short", "lev_money_positions_short_all"]);
    const openInterest = cftcNum(row, ["open_interest_all"]);
    if ([assetLong, assetShort, levLong, levShort].some((v) => v == null)) continue;
    const asset = cotNet(assetLong, assetShort), lev = cotNet(levLong, levShort);
    const assetScore = cotNetScore(assetLong, assetShort), levScore = cotNetScore(levLong, levShort);
    const score = parseFloat((levScore * 0.70 + assetScore * 0.30).toFixed(1));
    hist[date] = {
      score, levScore, assetScore,
      levNet: lev.net, assetNet: asset.net,
      levRatio: +lev.ratio.toFixed(3), assetRatio: +asset.ratio.toFixed(3),
      levLong, levShort, assetLong, assetShort, openInterest,
    };
  }
  if (!Object.keys(hist).length) throw new Error("Žádný validní týden pro " + COT_MARKET_NAME);
  return hist;
}

(async () => {
  let cotHist;
  try {
    cotHist = await fetchCOTHistory();
    console.log("COT OK ·", Object.keys(cotHist).length, "týdnů · poslední:", Object.keys(cotHist).sort().pop());
  } catch (e) {
    // Recoverable — existující data/us100_cot.json zůstává nedotčené, další
    // (týdenní) běh to zkusí znovu. Exit 0, ať to negeneruje failure e-maily
    // za dočasný výpadek CFTC/Socrata.
    console.warn("COT fetch selhal, nezapisuju:", e.message);
    process.exit(0);
  }

  let store = { updated: "", market: "", hist: {} };
  try { store = JSON.parse(fs.readFileSync("data/us100_cot.json", "utf8")); } catch (e) {}
  if (!store.hist || typeof store.hist !== "object") store.hist = {};

  Object.assign(store.hist, cotHist);
  const dates = Object.keys(store.hist).sort().slice(-150); // stejná retence jako appka drží pro FX COT (104t okno + rezerva)
  const trimmed = {}; dates.forEach((d) => (trimmed[d] = store.hist[d]));
  store.hist = trimmed;
  store.market = COT_MARKET_NAME + " - " + COT_MARKET_EXCH;
  store.updated = new Date().toISOString();

  fs.writeFileSync("data/us100_cot.json", JSON.stringify(store));
  console.log("Zapsáno data/us100_cot.json · týdnů:", Object.keys(store.hist).length);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

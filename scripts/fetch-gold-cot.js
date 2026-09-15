// ZLATO (XAUUSD) — COT historie, samostatný pipeline nezávislý na FX
// (fetch-cot.js zůstává beze změny). Píše data/gold_cot.json, které si appka
// stahuje do VLASTNÍHO localStorage klíče (gold_cot_hist) — viz
// fetchActionGoldCot() v engine.js. Nikdy nezapisuje do data/cot_hist.json
// ani data/us100_cot.json.
//
// Na rozdíl od FX měn a US100 (oba finanční futures, TFF report) je zlato
// FYZICKÁ komodita — je v CFTC "Disaggregated Futures-Only" reportu, jiné
// kategorie (Producer/Merchant, Swap Dealers, Managed Money, Other
// Reportables), ne Leveraged Funds/Asset Managers. Ověřeno živě
// (scripts/probe-gold-us100.js, GH Actions run 2026-09-15): trh se jmenuje
// přesně "GOLD - COMMODITY EXCHANGE INC." (plný COMEX kontrakt — NE "MICRO
// GOLD" ani "GOLD -1 TROY OUNCE - COINBASE DERIVATIVES", to jsou jiné,
// menší/jiné burzy).
//
// Skóre = JEN Managed Money (obdoba "Leveraged Funds" z TFF — trend-money
// hedge fondy/CTA). Producer/Merchant (těžaři/rafinerie) se do skóre
// ZÁMĚRNĚ neblendí jako u US100 (Asset Managers) — těžaři gold strukturálně
// prodávají budoucí produkci dopředu (hedging), takže jsou téměř VŽDY čistě
// short bez ohledu na to, kam trh reálně směřuje. Blend by tak do skóre
// natrvalo zamíchal zápornou nulu, ne reálný signál. Producer/Merchant se
// i tak ukládá a appka ho může zobrazit jako kontext ("těžaři net short
// X kontraktů"), jen se nezapočítává do čísla.
const fs = require("fs");

const COT_DATASET = "72hh-3qpy"; // Disaggregated Futures-Only (komodity)
const COT_MARKET_NAME = "GOLD - COMMODITY EXCHANGE INC.";

function cftcNum(row, names) {
  for (const n of names) { const v = row[n]; if (v != null && v !== "") { const f = parseFloat(v); if (!isNaN(f)) return f; } }
  return null;
}
function cotNet(longPos, shortPos) {
  const l = Number(longPos) || 0, s = Number(shortPos) || 0;
  return { long: l, short: s, net: l - s, ratio: (l + s) > 0 ? (l - s) / (l + s) : 0 };
}
// Stejný vzorec jako appka používá pro FX měny i US100 (viz cotNetScore ve
// fetch-cot.js / fetch-us100-cot.js) — ať je škála srovnatelná s tím, co
// appka už zná.
function cotNetScore(longPos, shortPos) {
  const n = cotNet(longPos, shortPos);
  return parseFloat(Math.max(-3, Math.min(3, n.ratio * 6)).toFixed(1));
}

async function fetchCOTHistory() {
  const cutoff = new Date(Date.now() - 850 * 86400000).toISOString().slice(0, 10); // ~28 měsíců, stejně jako FX/US100
  const base = "https://publicreporting.cftc.gov/resource/" + COT_DATASET + ".json";
  const where = encodeURIComponent("report_date_as_yyyy_mm_dd > '" + cutoff + "T00:00:00.000' AND market_and_exchange_names = '" + COT_MARKET_NAME + "'");
  const order = encodeURIComponent("report_date_as_yyyy_mm_dd ASC");
  const r = await fetch(base + "?$where=" + where + "&$order=" + order + "&$limit=1000", { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("CFTC API HTTP " + r.status);
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error("CFTC API: 0 řádků pro " + COT_MARKET_NAME);

  const hist = {};
  for (const row of rows) {
    const date = String(row.report_date_as_yyyy_mm_dd || "").slice(0, 10);
    if (!date) continue;
    // POZOR na nekonzistentní CFTC schéma (ověřeno živě): prod_merc_* NEMÁ
    // "_all" příponu, m_money_*/swap_* JI MÁ — jiné pojmenování stejné
    // "current week" sady sloupců, ne chyba.
    const prodMercLong = cftcNum(row, ["prod_merc_positions_long"]);
    const prodMercShort = cftcNum(row, ["prod_merc_positions_short"]);
    const mMoneyLong = cftcNum(row, ["m_money_positions_long_all"]);
    const mMoneyShort = cftcNum(row, ["m_money_positions_short_all"]);
    const openInterest = cftcNum(row, ["open_interest_all"]);
    if ([prodMercLong, prodMercShort, mMoneyLong, mMoneyShort].some((v) => v == null)) continue;
    const prodMerc = cotNet(prodMercLong, prodMercShort), mMoney = cotNet(mMoneyLong, mMoneyShort);
    // Skóre = jen Managed Money (viz hlavička souboru, proč se Producer/Merchant neblendí).
    const score = cotNetScore(mMoneyLong, mMoneyShort);
    hist[date] = {
      score, mMoneyScore: score,
      mMoneyNet: mMoney.net, prodMercNet: prodMerc.net,
      mMoneyRatio: +mMoney.ratio.toFixed(3), prodMercRatio: +prodMerc.ratio.toFixed(3),
      mMoneyLong, mMoneyShort, prodMercLong, prodMercShort, openInterest,
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
    // Recoverable — existující data/gold_cot.json zůstává nedotčené, další
    // (týdenní) běh to zkusí znovu. Exit 0, ať to negeneruje failure e-maily
    // za dočasný výpadek CFTC/Socrata.
    console.warn("COT fetch selhal, nezapisuju:", e.message);
    process.exit(0);
  }

  let store = { updated: "", market: "", hist: {} };
  try { store = JSON.parse(fs.readFileSync("data/gold_cot.json", "utf8")); } catch (e) {}
  if (!store.hist || typeof store.hist !== "object") store.hist = {};

  Object.assign(store.hist, cotHist);
  const dates = Object.keys(store.hist).sort().slice(-150);
  const trimmed = {}; dates.forEach((d) => (trimmed[d] = store.hist[d]));
  store.hist = trimmed;
  store.market = COT_MARKET_NAME;
  store.updated = new Date().toISOString();

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/gold_cot.json", JSON.stringify(store));
  console.log("Zapsáno data/gold_cot.json · týdnů:", Object.keys(store.hist).length);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

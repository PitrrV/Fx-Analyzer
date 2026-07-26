// Retail sentiment — půlhodinový snímek na server.
//
// PŘÍSTUP 1 (primární, intradenní): FXSSI Current Ratio —
//   https://c.fxssi.com/api/current-ratio · veřejné, BEZ přihlášení, čistý JSON.
//   Ověřeno živě z GH Actions runneru (2026-07-26): 200 + application/json, žádná
//   Cloudflare blokace, žádná session vázaná na IP. Agreguje pozice z 10 brokerů
//   (MyFxBook, OANDA, Dukascopy, FXBlue, IG, XM, Insta, FiboGroup, Amarkets, FXSSI)
//   s vahami → širší základna než dřívější samotný Myfxbook, který je uvnitř taky.
//   Obnovuje se ~10 min, takže data rostou po celý den.
//
//   SMĚR HODNOTY (ověřeno, ne odhadnuto — chyba by tiše obrátila retail signál):
//   hodnota v `pairs[PAIR][broker]` i `pairs[PAIR].average` je BUY % (= long %).
//   Důkaz z jejich vlastního kódu/stylu na fxssi.com/tools/current-ratio:
//     addBroker(){ perc=100-perc; open=perc; close=100-perc; … }  → close === RAW
//     šablona:  <div class="ratio-bar-left" style="width:{{close}}%">
//     jiný jejich nástroj mapuje ty samé třídy explicitně:
//       $voter.find('.ratio-bar-left').text(data.buy+'%')
//       $voter.find('.ratio-bar-right').text(data.sell+'%')
//     CSS: .ratio-bar-left{background:#5896D6}(modrá) .ratio-bar-right{#F06A7A}(oranž.)
//     jejich dokumentace: "The blue bar indicates the percentage of Buy trades,
//     the orange bar displays the percentage of Sell trades."
//   → levý pruh = close = RAW = Buy%. Sedí i jejich kontrariánský signál
//     (open<50 ⇒ 'sell', tj. když je dav long, indikátor dává short).
//
// PŘÍSTUP 2 (fallback, týdenní): CFTC Non-reportable přes Socrata JSON API
//   (publicreporting.cftc.gov, dataset 6dca-aqww, pole nonrept_positions_*) — stejná
//   infrastruktura jako spolehlivě běžící fetch-cot.js. Per měna (ne per pár),
//   aktualizace jen týdně (páteční report) → použije se, jen když FXSSI selže.
//
// Historická poznámka: Myfxbook cesty jsou z GH Actions nepoužitelné — HTML vrací 403
// (Cloudflare), a u oficiálního REST API sice login projde, ale jakékoliv navazující
// volání stejnou session skončí "Invalid session.", protože Myfxbook váže session na IP
// a cloud runnery mění odchozí IP mezi jednotlivými spojeními.
//
// Výstup: data/retail_hist.json = { updated, source, points:[ {t, pairs:{EURUSD:{l,s}}, ccy:{USD:..}, source } ] }
const fs = require("fs");
const CUR = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://fxssi.com/tools/current-ratio",
};

// ── FXSSI Current Ratio (primární, intradenní) ──────────────────────
const FXSSI_URL = "https://c.fxssi.com/api/current-ratio";

async function fetchFxssi() {
  const r = await fetch(FXSSI_URL, { headers: UA, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error("FXSSI HTTP " + r.status);
  const j = await r.json();
  if (!j || typeof j.pairs !== "object") throw new Error("FXSSI: chybí pole `pairs`");

  const pairs = {};
  for (const [rawSym, brokers] of Object.entries(j.pairs)) {
    const sym = String(rawSym).toUpperCase().replace("/", "");
    if (!/^[A-Z]{6}$/.test(sym)) continue;
    // `average` = jejich vážený průměr přes brokery; když chybí, prostý průměr sloupců.
    let long = parseFloat(brokers && brokers.average);
    if (!Number.isFinite(long)) {
      const vals = Object.entries(brokers || {})
        .filter(([k]) => k !== "average" && k !== "oip")
        .map(([, v]) => parseFloat(v))
        .filter(Number.isFinite);
      if (!vals.length) continue;
      long = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    if (!(long >= 0 && long <= 100)) continue;
    pairs[sym] = { l: Math.round(long), s: Math.round(100 - long) };
  }
  if (Object.keys(pairs).length < 6) throw new Error("FXSSI: jen " + Object.keys(pairs).length + " párů");
  return pairs;
}

// Per-měnový průměr. Bere JEN páry, kde jsou OBĚ nohy sledovaná měna — jinak by
// XAUUSD/BTCUSD/US30 (které FXSSI taky vrací) tahaly retail sentiment USD, i když
// o měnovém páru samy o sobě nic neříkají.
function pairsToCcy(pairs) {
  const sum = {}, cnt = {};
  for (const [pair, d] of Object.entries(pairs)) {
    const b = pair.slice(0, 3), q = pair.slice(3, 6);
    if (!CUR.includes(b) || !CUR.includes(q)) continue;
    sum[b] = (sum[b] || 0) + d.l;         cnt[b] = (cnt[b] || 0) + 1;
    sum[q] = (sum[q] || 0) + (100 - d.l); cnt[q] = (cnt[q] || 0) + 1;
  }
  const ccy = {};
  for (const c of CUR) ccy[c] = cnt[c] ? Math.round(sum[c] / cnt[c]) : 50;
  return ccy;
}

// ── CFTC Non-reportable přes Socrata API (fallback) ─────────────────
const CFTC_LEGACY_DATASET = "6dca-aqww";
const COT_MARKETS = {
  EUR: "EURO FX", GBP: "BRITISH POUND", JPY: "JAPANESE YEN", AUD: "AUSTRALIAN DOLLAR",
  CAD: "CANADIAN DOLLAR", CHF: "SWISS FRANC", NZD: "NZ DOLLAR",
};
const COT_LIKE_PATS = [
  "EURO FX%", "BRITISH POUND%", "JAPANESE YEN%", "AUSTRALIAN DOLLAR%",
  "CANADIAN DOLLAR%", "SWISS FRANC%", "%NZ DOLLAR%", "%NEW ZEALAND%",
];

async function fetchCftcNonReportable() {
  const cutoff = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10);
  const where = `(${COT_LIKE_PATS.map((p) => `market_and_exchange_names like '${p}'`).join(" OR ")}) AND report_date_as_yyyy_mm_dd > '${cutoff}T00:00:00.000'`;
  const fields = "market_and_exchange_names,report_date_as_yyyy_mm_dd,nonrept_positions_long_all,nonrept_positions_short_all";
  const url = `https://publicreporting.cftc.gov/resource/${CFTC_LEGACY_DATASET}.json?$select=${encodeURIComponent(fields)}&$where=${encodeURIComponent(where)}&$order=${encodeURIComponent("report_date_as_yyyy_mm_dd DESC")}&$limit=200`;
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error("CFTC Socrata API HTTP " + r.status);
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error("CFTC Socrata API: 0 řádků");

  const out = {};
  for (const [ccy, market] of Object.entries(COT_MARKETS)) {
    const row = rows.find((x) => String(x.market_and_exchange_names || "").toUpperCase().includes(market));
    if (!row) continue;
    const nrLong = parseFloat(row.nonrept_positions_long_all), nrShort = parseFloat(row.nonrept_positions_short_all);
    if (!Number.isFinite(nrLong) || !Number.isFinite(nrShort)) continue;
    const total = nrLong + nrShort;
    out[ccy] = total > 0 ? Math.round((nrLong / total) * 100) : 50;
  }
  const vals = Object.values(out);
  if (vals.length < 4) throw new Error("CFTC Socrata API: namapováno jen " + vals.length + " měn");
  out.USD = Math.round(100 - vals.reduce((a, b) => a + b, 0) / vals.length);
  return out;
}

(async () => {
  let ccy = null, pairs = {}, source = "";

  try {
    pairs = await fetchFxssi();
    ccy = pairsToCcy(pairs);
    source = "fxssi-current-ratio";
    console.log("FXSSI OK:", Object.keys(pairs).length, "párů ·", JSON.stringify(ccy));
  } catch (e) { console.log("FXSSI selhal:", e.message); }

  if (!ccy) {
    try {
      ccy = await fetchCftcNonReportable();
      source = "cftc-nonreport";
      console.log("CFTC Non-reportable OK (fallback):", JSON.stringify(ccy));
    } catch (e) { console.log("CFTC Non-reportable selhal:", e.message); }
  }

  if (!ccy) {
    // Recoverable stav (výpadek obou zdrojů) — existující data/retail_hist.json
    // zůstává nedotčené a další běh za 30 min to zkusí znovu. Exit 0 (ne 1), ať
    // tohle negeneruje opakované CI failure notifikace; skutečná chyba (FATAL) má 1.
    console.warn("Žádný retail zdroj nedostupný (FXSSI i CFTC selhaly) — nepřepisuju, zkusím příští běh.");
    process.exit(0);
  }

  const point = { t: new Date().toISOString(), pairs, ccy, source };

  let store = { updated: "", points: [] };
  try { store = JSON.parse(fs.readFileSync("data/retail_hist.json", "utf8")); } catch (e) {}
  if (!Array.isArray(store.points)) store.points = [];
  store.points.push(point);
  store.points = store.points.slice(-1100); // ~45 dní bodů
  store.updated = point.t;
  store.source = source;

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/retail_hist.json", JSON.stringify(store));
  console.log("Zapsáno data/retail_hist.json · bodů:", store.points.length, "· zdroj:", source, "· ccy:", JSON.stringify(ccy));
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

// Retail sentiment — hodinový/půlhodinový snímek na server.
// PŘÍSTUP 1: CFTC Non-reportable positions přes oficiální Socrata JSON API
// (publicreporting.cftc.gov) — STEJNÁ doména a STEJNÝ vzor dotazu jako fetch-cot.js
// (CFTC TFF cron) a fetch-research-data.js, oba prokazatelně fungují z GitHub Actions
// (běží spolehlivě každý týden). Dřívější verze tohohle skriptu scrapovala
// www.cftc.gov/dea/futures/financial_lf.htm (stejný zdroj jako klientský
// fetchRetailSentiment() v engine.js) — ta stránka ale z cloud IP GitHub Actions
// runneru vrací 403 (funguje jen z běžné prohlížečové sítě), takže nikdy neuspěla.
// Socrata API běží na jiné infrastruktuře a blokaci nemá. Malí spekulanti (legacy
// dataset 6dca-aqww, "nonrept_positions_*") = reálný retail proxy, per měna (ne per
// pár). Aktualizuje se týdně (páteční CFTC report), ne intradenně.
// PŘÍSTUP 2 (fallback): Myfxbook Community Outlook přes „čtecí" proxy — per pár,
// intradenní, ale v posledních dnech blokovaný na všech proxy (Cloudflare zpřísnění
// na straně Myfxbook). Ponecháno jako druhotný zdroj pro jemnější obohacení, když
// je dostupný — CFTC teď gate na výstup nedrží.
// Výstup: data/retail_hist.json = { updated, points:[ {t, pairs:{EURUSD:{l,s}}, ccy:{USD:..}, source } ] }
const fs = require("fs");
const CUR = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" };

// ── CFTC Non-reportable přes Socrata API (primární) ─────────────────
const CFTC_LEGACY_DATASET = "6dca-aqww";
const COT_MARKETS = {
  EUR: "EURO FX", GBP: "BRITISH POUND", JPY: "JAPANESE YEN", AUD: "AUSTRALIAN DOLLAR",
  CAD: "CANADIAN DOLLAR", CHF: "SWISS FRANC", NZD: "NZ DOLLAR",
};
// LIKE vzory pro $where — širší než COT_MARKETS (NZD měnil název v čase), stejné
// jako COT_LIKE ve fetch-research-data.js.
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
    const row = rows.find((row) => String(row.market_and_exchange_names || "").toUpperCase().includes(market));
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

// ── Myfxbook (sekundární, intradenní obohacení, když je dostupný) ──────
const MYFX = "https://www.myfxbook.com/community/outlook";
const MYFX_PROXIES = [
  "https://r.jina.ai/" + MYFX,
  "https://api.allorigins.win/raw?url=" + encodeURIComponent(MYFX),
  "https://corsproxy.io/?url=" + encodeURIComponent(MYFX),
  "https://thingproxy.freeboard.io/fetch/" + MYFX,
];

function parseMyfxPairs(html) {
  const out = {};
  const pats = [
    /"symbol"\s*:\s*"([A-Z]{6})"[^}]*?"longPercentage"\s*:\s*([\d.]+)[^}]*?"shortPercentage"\s*:\s*([\d.]+)/g,
    /"symbol"\s*:\s*"([A-Z]{6})"[^}]*?"shortPercentage"\s*:\s*([\d.]+)[^}]*?"longPercentage"\s*:\s*([\d.]+)/g,
  ];
  for (const [i, p] of pats.entries()) {
    for (const m of html.matchAll(p)) {
      const sym = m[1];
      const l = parseFloat(i === 1 ? m[3] : m[2]);
      const s = parseFloat(i === 1 ? m[2] : m[3]);
      if (isFinite(l) && isFinite(s) && l + s > 90 && l + s < 110) out[sym] = { l: Math.round(l), s: Math.round(s) };
    }
    if (Object.keys(out).length >= 4) return out;
  }
  const nd = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nd) {
    try {
      const str = JSON.stringify(JSON.parse(nd[1]));
      for (const m of str.matchAll(/"symbol"\s*:\s*"([A-Z]{6})"[^}]*?"longPercentage"\s*:\s*([\d.]+)/g)) {
        const l = parseFloat(m[2]); out[m[1]] = { l: Math.round(l), s: Math.round(100 - l) };
      }
    } catch (e) {}
  }
  if (Object.keys(out).length < 4) {
    for (const m of html.matchAll(/([A-Z]{6})[^%]{0,80}?(\d{2,3}(?:\.\d+)?)\s*%[^%]{0,80}?(\d{2,3}(?:\.\d+)?)\s*%/g)) {
      const l = parseFloat(m[2]), s = parseFloat(m[3]);
      if (l + s > 95 && l + s < 105) out[m[1]] = { l: Math.round(l), s: Math.round(s) };
    }
  }
  return out;
}
function pairsToCcy(pairs) {
  const sum = {}, cnt = {};
  for (const [pair, d] of Object.entries(pairs)) {
    const b = pair.slice(0, 3), q = pair.slice(3, 6);
    if (CUR.includes(b)) { sum[b] = (sum[b] || 0) + d.l; cnt[b] = (cnt[b] || 0) + 1; }
    if (CUR.includes(q)) { sum[q] = (sum[q] || 0) + (100 - d.l); cnt[q] = (cnt[q] || 0) + 1; }
  }
  const ccy = {};
  for (const c of CUR) ccy[c] = cnt[c] ? Math.round(sum[c] / cnt[c]) : 50;
  return ccy;
}
async function fetchMyfxbook() {
  for (const u of MYFX_PROXIES) {
    try {
      const r = await fetch(u, { headers: UA });
      const html = await r.text();
      console.log(`proxy ${u.slice(0, 40)}… status=${r.status} len=${html.length}`);
      if (!r.ok || html.length < 800) continue;
      const pairs = parseMyfxPairs(html);
      console.log("  parsed pairs:", Object.keys(pairs).length);
      if (Object.keys(pairs).length >= 4) return pairs;
    } catch (e) { console.log("  ERR", e.message); }
  }
  return null;
}

(async () => {
  let ccy = null, pairs = {}, source = "";

  try {
    ccy = await fetchCftcNonReportable();
    source = "cftc-nonreport";
    console.log("CFTC Non-reportable OK:", JSON.stringify(ccy));
  } catch (e) { console.log("CFTC Non-reportable selhal:", e.message); }

  // Myfxbook: pokud dostupný, dá jemnější per-pár rozpad. Pokud CFTC selhal, je to
  // jediná šance na výsledek vůbec; pokud CFTC uspěl, Myfxbook jen doplní `pairs`
  // (ccy z CFTC se nepřepisuje — je to spolehlivější primární zdroj).
  const myfx = await fetchMyfxbook();
  if (myfx) {
    pairs = myfx;
    if (!ccy) { ccy = pairsToCcy(myfx); source = "myfxbook-outlook"; }
    else source += "+myfxbook";
  }

  if (!ccy) {
    // CFTC Socrata API by měl být spolehlivý (stejná infrastruktura jako fungující
    // fetch-cot.js cron), ale pro jistotu zůstává i tenhle bezpečný fallback — kdyby
    // Socrata dočasně nešlo a Myfxbook zrovna taky ne, nic se nepřepíše a další běh
    // za 30 min to zkusí znovu. Exit 0 (ne 1), ať tenhle recoverable stav negeneruje
    // CI failure notifikace — skutečná chyba (např. FATAL níž) pořád exituje s 1.
    console.warn("Žádný retail zdroj nedostupný (CFTC i Myfxbook selhaly) — nepřepisuju, zkusím příští běh.");
    process.exit(0);
  }

  const point = { t: new Date().toISOString(), pairs, ccy, source };

  let store = { updated: "", points: [] };
  try { store = JSON.parse(fs.readFileSync("data/retail_hist.json", "utf8")); } catch (e) {}
  if (!Array.isArray(store.points)) store.points = [];
  store.points.push(point);
  // drž ~45 dní bodů
  store.points = store.points.slice(-1100);
  store.updated = point.t;
  store.source = source;

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/retail_hist.json", JSON.stringify(store));
  console.log("Zapsáno data/retail_hist.json · bodů:", store.points.length, "· zdroj:", source, "· ccy:", JSON.stringify(ccy));
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

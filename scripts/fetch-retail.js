// Retail sentiment — půlhodinový snímek na server.
// PŘÍSTUP 1 (primární, intradenní): Myfxbook OFICIÁLNÍ REST API (login.json +
// get-community-outlook.json, viz myfxbook.com/api) — NENÍ totéž jako dřívější HTML
// scraping community/outlook stránky (ten je za Cloudflare a blokovaný). Oficiální API
// je jiná cesta na serveru myfxbook.com, potřebuje účet (MYFXBOOK_EMAIL/MYFXBOOK_PASSWORD
// jako GH secrets). Volný limit 100 requestů/24h platí jen na get-community-outlook.json
// (login/logout nejsou tahle stejná limitovaná brána) — cron po 30 min = 48 volání
// outlooku/den, bezpečně pod limitem. Session je vázaná na IP, takže se přihlašuje
// nanovo každý běh (runner má pokaždé jinou IP) — nedá se cachovat mezi běhy.
// PŘÍSTUP 2 (fallback/cross-check, týdenní): CFTC Non-reportable positions přes oficiální
// Socrata JSON API (publicreporting.cftc.gov) — STEJNÁ doména a STEJNÝ vzor dotazu jako
// fetch-cot.js (CFTC TFF cron) a fetch-research-data.js, oba prokazatelně fungují z GitHub
// Actions. Malí spekulanti (legacy dataset 6dca-aqww, "nonrept_positions_*") = per měna,
// ne per pár, aktualizuje se týdně (páteční report). Použije se jen když Myfxbook API
// selže (výpadek, vyčerpaný limit, chybějící/neplatné přihlašovací údaje).
// Výstup: data/retail_hist.json = { updated, points:[ {t, pairs:{EURUSD:{l,s}}, ccy:{USD:..}, source } ] }
const fs = require("fs");
const CUR = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" };

// ── Myfxbook oficiální API (primární, intradenní) ───────────────────
async function myfxbookLogin() {
  const email = process.env.MYFXBOOK_EMAIL, password = process.env.MYFXBOOK_PASSWORD;
  if (!email || !password) throw new Error("MYFXBOOK_EMAIL/MYFXBOOK_PASSWORD nejsou nastavené (GH secrets)");
  const url = `https://www.myfxbook.com/api/login.json?email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`;
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("Myfxbook login HTTP " + r.status);
  const j = await r.json();
  console.log("  DEBUG login response: error=" + j.error + " message=" + JSON.stringify(j.message) + " session_len=" + (j.session ? j.session.length : 0) + " session_prefix=" + (j.session ? j.session.slice(0, 6) : "-"));
  if (j.error || !j.session) throw new Error("Myfxbook login: " + (j.message || "chybí session"));
  // Kontrolní volání na jiný endpoint stejnou session — odliší, jestli je session
  // obecně neplatná (login sám o sobě chybný), nebo je problém specifický jen pro
  // get-community-outlook.json.
  try {
    const cr = await fetch(`https://www.myfxbook.com/api/get-my-accounts.json?session=${encodeURIComponent(j.session)}`, { headers: UA, signal: AbortSignal.timeout(15000) });
    const cj = await cr.json();
    console.log("  DEBUG get-my-accounts (kontrola stejné session): error=" + cj.error + " message=" + JSON.stringify(cj.message));
  } catch (e) { console.log("  DEBUG get-my-accounts kontrola selhala:", e.message); }
  return j.session;
}
async function myfxbookLogout(session) {
  try { await fetch(`https://www.myfxbook.com/api/logout.json?session=${encodeURIComponent(session)}`, { headers: UA, signal: AbortSignal.timeout(10000) }); } catch (e) {}
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Známý (zdokumentovaný na myfxbook.com fóru) zlozvyk API: čerstvá session z
// login.json je občas hned napoprvé odmítnuta jako "Invalid session." — pomáhá
// krátká prodleva a zopakování dotazu, ne chyba na naší straně.
async function fetchOutlookWithSession(session) {
  const url = `https://www.myfxbook.com/api/get-community-outlook.json?session=${encodeURIComponent(session)}`;
  const attempts = [0, 1500, 3000];
  let lastErr = null;
  for (const delay of attempts) {
    if (delay) await sleep(delay);
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (!r.ok) { lastErr = new Error("Myfxbook outlook HTTP " + r.status); continue; }
      const j = await r.json();
      if (j.error) { lastErr = new Error("Myfxbook outlook: " + (j.message || "chyba")); console.log(`  pokus (delay=${delay}ms): ${lastErr.message}`); continue; }
      return j;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Myfxbook outlook: neznámá chyba");
}

async function fetchMyfxbookOfficial() {
  const session = await myfxbookLogin();
  try {
    const j = await fetchOutlookWithSession(session);
    const symbols = Array.isArray(j.symbols) ? j.symbols : [];
    const pairs = {};
    for (const s of symbols) {
      const sym = String(s.name || "").toUpperCase().replace("/", "");
      const l = parseFloat(s.longPercentage), sh = parseFloat(s.shortPercentage);
      if (/^[A-Z]{6}$/.test(sym) && Number.isFinite(l) && Number.isFinite(sh)) pairs[sym] = { l: Math.round(l), s: Math.round(sh) };
    }
    if (Object.keys(pairs).length < 4) throw new Error("Myfxbook outlook: jen " + Object.keys(pairs).length + " párů");
    return pairs;
  } finally {
    myfxbookLogout(session);
  }
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

// ── CFTC Non-reportable přes Socrata API (fallback/cross-check) ─────
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

(async () => {
  let ccy = null, pairs = {}, source = "";

  try {
    pairs = await fetchMyfxbookOfficial();
    ccy = pairsToCcy(pairs);
    source = "myfxbook-api";
    console.log("Myfxbook API OK:", Object.keys(pairs).length, "párů,", JSON.stringify(ccy));
  } catch (e) { console.log("Myfxbook API selhal:", e.message); }

  // CFTC: použije se jen když Myfxbook API selhal (výpadek/limit/špatné údaje) —
  // per-měnový fallback, i když jen týdenní, je lepší než nic.
  if (!ccy) {
    try {
      ccy = await fetchCftcNonReportable();
      source = "cftc-nonreport";
      console.log("CFTC Non-reportable OK (fallback):", JSON.stringify(ccy));
    } catch (e) { console.log("CFTC Non-reportable selhal:", e.message); }
  }

  if (!ccy) {
    // Oba zdroje mají za sebou fungující historii (Myfxbook API je oficiální, CFTC
    // Socrata je stejná infrastruktura jako spolehlivý fetch-cot.js cron), ale pro
    // jistotu zůstává bezpečný fallback — kdyby oba dočasně selhaly (výpadek, vyčerpaný
    // Myfxbook limit), nic se nepřepíše a další běh za 45 min to zkusí znovu. Exit 0
    // (ne 1), ať tenhle recoverable stav negeneruje CI failure notifikace — skutečná
    // chyba (např. FATAL níž) pořád exituje s 1.
    console.warn("Žádný retail zdroj nedostupný (Myfxbook API i CFTC selhaly) — nepřepisuju, zkusím příští běh.");
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

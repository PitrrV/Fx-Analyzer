// Retail sentiment — půlhodinový snímek na server.
//
// PŘÍSTUP 0 (PRIMÁRNÍ, intradenní, plné pokrytí): Myfxbook oficiální REST API —
//   login.json + get-community-outlook.json · 187 symbolů, z toho ~140 měnových
//   párů → pokrývá VŠECH 28 z STANDARD_PAIRS včetně křížů (GBPNZD, NZDJPY, EURCAD…),
//   které FXSSI vůbec nesleduje.
//
//   POZOR NA SESSION — tady byla dlouho chyba: token z login.json se posílá do URL
//   SYROVÝ, BEZ encodeURIComponent(). Obsahuje znaky, které by kódování změnilo na
//   %2B/%2F, jenže Myfxbook parametr nedekóduje a přečte jiný řetězec → vrátí
//   "Invalid session." Ověřeno živě (run 30191729319): syrová session error=false
//   se 187 symboly, kódovaná "Invalid session." na tomtéž běhu. Nešlo tedy o vazbu
//   session na IP, Cloudflare ani reputaci datacenter IP — jen o překódovaný token.
//
//   SMĚR: API vrací pojmenovaná pole longPercentage/shortPercentage → směr je
//   z názvu jednoznačný, nehádá se z pořadí (to byla příčina dřívějšího
//   30denního obrácení dat, viz scripts/fix-retail-history-inversion.js).
//   Navíc se křížově kontroluje proti FXSSI: při záporné korelaci se zápis odmítne.
//
//   Limit volné úrovně je 100 požadavků/24 h na get-community-outlook.json;
//   cron po 30 min = 48/den, s rezervou.
//
// PŘÍSTUP 1 (záloha + křížová kontrola směru): FXSSI Current Ratio —
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
// Historická poznámka: HTML stránka myfxbook.com/community/outlook je z GH Actions
// blokovaná Cloudflare (403) — proto se používá výhradně oficiální REST API.
//
// Výstup: data/retail_hist.json = { updated, source, points:[ {t, pairs:{EURUSD:{l,s}}, ccy:{USD:..}, source } ] }
const fs = require("fs");
const CUR = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://fxssi.com/tools/current-ratio",
};

// ── Myfxbook oficiální API (primární, plné pokrytí) ─────────────────
const MYFX = "https://www.myfxbook.com/api";

async function myfxGet(path) {
  const r = await fetch(MYFX + path, { headers: UA, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error("Myfxbook HTTP " + r.status);
  const j = await r.json();
  if (j.error) throw new Error("Myfxbook: " + (j.message || "chyba"));
  return j;
}

async function fetchMyfxbook() {
  const email = process.env.MYFXBOOK_EMAIL, password = process.env.MYFXBOOK_PASSWORD;
  if (!email || !password) throw new Error("MYFXBOOK_EMAIL/PASSWORD nejsou nastavené");
  const lg = await myfxGet(`/login.json?email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`);
  if (!lg.session) throw new Error("Myfxbook login: chybí session");
  const session = lg.session;
  try {
    // ⚠ session SYROVÁ, bez encodeURIComponent — viz komentář v hlavičce souboru.
    const j = await myfxGet(`/get-community-outlook.json?session=${session}`);
    const pairs = {};
    for (const s of (j.symbols || [])) {
      const sym = String(s.name || "").toUpperCase().replace("/", "");
      if (!/^[A-Z]{6}$/.test(sym)) continue;
      const l = parseFloat(s.longPercentage), sh = parseFloat(s.shortPercentage);
      if (!Number.isFinite(l) || !Number.isFinite(sh)) continue;
      if (Math.abs(l + sh - 100) > 2) continue;          // nekonzistentní řádek
      pairs[sym] = { l: Math.round(l), s: Math.round(100 - l) };
    }
    if (Object.keys(pairs).length < 20) throw new Error("Myfxbook: jen " + Object.keys(pairs).length + " párů");
    return pairs;
  } finally {
    try { await myfxGet(`/logout.json?session=${session}`); } catch (e) {}
  }
}

// Křížová kontrola SMĚRU proti nezávislému zdroji. Obrácená konvence u jednoho ze
// zdrojů by se projevila silnou ZÁPORNOU korelací na společných párech.
function smerSedi(a, b) {
  const spol = Object.keys(a).filter((p) => b[p]);
  if (spol.length < 5) return { ok: true, n: spol.length, r: NaN };
  const xs = spol.map((p) => a[p].l), ys = spol.map((p) => b[p].l);
  const n = xs.length, mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const sx = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0));
  const sy = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));
  const r = sx && sy ? cov / (sx * sy) : NaN;
  return { ok: !(Number.isFinite(r) && r < -0.3), n, r };
}

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

  // 1) Myfxbook — plné pokrytí (~140 měnových párů, všech 28 z STANDARD_PAIRS)
  let myfx = null;
  try {
    myfx = await fetchMyfxbook();
    console.log("Myfxbook OK:", Object.keys(myfx).length, "párů");
  } catch (e) { console.log("Myfxbook selhal:", e.message); }

  // 2) FXSSI — záloha a zároveň nezávislá KONTROLA SMĚRU
  let fxssi = null;
  try {
    fxssi = await fetchFxssi();
    console.log("FXSSI OK:", Object.keys(fxssi).length, "párů");
  } catch (e) { console.log("FXSSI selhal:", e.message); }

  if (myfx && fxssi) {
    const k = smerSedi(myfx, fxssi);
    console.log(`Kontrola směru Myfxbook×FXSSI: n=${k.n} r=${Number.isFinite(k.r) ? k.r.toFixed(3) : "n/a"}`);
    if (!k.ok) {
      console.error("VALIDACE SELHALA: Myfxbook a FXSSI si odporují ve směru long/short — nezapisuju.");
      process.exit(1);
    }
  }

  if (myfx) {
    // Myfxbook je základ; FXSSI doplní jen páry, které Myfxbook nemá.
    pairs = { ...(fxssi || {}), ...myfx };
    ccy = pairsToCcy(pairs);
    source = fxssi ? "myfxbook-api+fxssi" : "myfxbook-api";
    console.log("Zdroj:", source, "· párů celkem:", Object.keys(pairs).length, "·", JSON.stringify(ccy));
  } else if (fxssi) {
    pairs = fxssi;
    ccy = pairsToCcy(pairs);
    source = "fxssi-current-ratio";
    console.log("Zdroj: fxssi-current-ratio ·", JSON.stringify(ccy));
  }

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
    console.warn("Žádný retail zdroj nedostupný (Myfxbook, FXSSI i CFTC selhaly) — nepřepisuju, zkusím příští běh.");
    process.exit(0);
  }

  // ── VALIDAČNÍ BRÁNA PŘED ZÁPISEM ──────────────────────────────────
  // Vznikla po incidentu, kdy poziční parser prohodil long/short a data byla
  // 30 dní tiše obrácená. Cíl: radši nic nezapsat než zapsat obrácená data.
  const problems = [];

  // (a) strukturální invariant
  for (const [p, d] of Object.entries(pairs)) {
    if (!Number.isFinite(d.l) || !Number.isFinite(d.s)) problems.push(`${p}: nečíselné l/s`);
    else if (Math.abs(d.l + d.s - 100) > 1) problems.push(`${p}: l+s=${d.l + d.s} (má být 100)`);
    else if (d.l < 0 || d.l > 100) problems.push(`${p}: l=${d.l} mimo 0–100`);
  }
  for (const c of CUR) {
    const v = ccy[c];
    if (!Number.isFinite(v) || v < 0 || v > 100) problems.push(`ccy ${c}=${v} mimo 0–100`);
  }

  // (b) ANTI-INVERZE: porovnej s posledním uloženým bodem téhož zdroje. Retail
  // pozicování je setrvačné — mezi dvěma běhy (30 min) se nemůže hromadně
  // překlopit na svůj zrcadlový obraz. Když by korelace vyšla silně ZÁPORNÁ,
  // je to podpis prohozených long/short, ne pohyb trhu.
  let prevStore = null;
  try { prevStore = JSON.parse(fs.readFileSync("data/retail_hist.json", "utf8")); } catch (e) {}
  const prev = prevStore && Array.isArray(prevStore.points)
    ? [...prevStore.points].reverse().find((p) => p.source === source && p.pairs && Object.keys(p.pairs).length)
    : null;
  if (prev) {
    const xs = [], ys = [];
    for (const [p, d] of Object.entries(pairs)) {
      const q = prev.pairs[p];
      if (q && Number.isFinite(q.l)) { xs.push(d.l); ys.push(q.l); }
    }
    if (xs.length >= 6) {
      const n = xs.length;
      const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
      const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
      const sx = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0));
      const sy = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));
      const rho = sx && sy ? cov / (sx * sy) : NaN;
      console.log(`Anti-inverze: korelace s předchozím bodem (n=${n}) r=${Number.isFinite(rho) ? rho.toFixed(3) : "n/a"}`);
      if (Number.isFinite(rho) && rho < -0.5) {
        problems.push(`korelace s předchozím bodem r=${rho.toFixed(3)} — vypadá to na PROHOZENÉ long/short`);
      }
    }
  }

  if (problems.length) {
    console.error("VALIDACE SELHALA — nezapisuju, aby se do historie nedostala vadná data:");
    for (const p of problems) console.error("  · " + p);
    process.exit(1);
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

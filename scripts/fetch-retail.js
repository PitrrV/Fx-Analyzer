// Retail sentiment — půlhodinový snímek na server.
//
// PŘÍSTUP 0 (PRIMÁRNÍ, intradenní, plné pokrytí): Myfxbook oficiální REST API —
//   login.json + get-community-outlook.json · 187 symbolů, z toho ~140 měnových
//   párů → pokrývá VŠECH 28 z STANDARD_PAIRS včetně křížů (GBPNZD, NZDJPY, EURCAD…).
//
//   POZOR NA SESSION — tady byla dlouho chyba: token z login.json se posílá do URL
//   SYROVÝ, BEZ encodeURIComponent(). Obsahuje znaky, které by kódování změnilo na
//   %2B/%2F, jenže Myfxbook parametr nedekóduje a přečte jiný řetězec → vrátí
//   "Invalid session." Ověřeno živě (run 30191729319): syrová session error=false
//   se 187 symboly, kódovaná "Invalid session." na tomtéž běhu. Nešlo tedy o vazbu
//   session na IP, Cloudflare ani reputaci datacenter IP — jen o překódovaný token.
//   I tak appka od 6.9.2026 zažívá opakované, nevysvětlené "Invalid session."
//   výpadky (probe-myfxbook-*.js dokumentuje rozsáhlý průzkum, který IP rotaci,
//   hlavičky, cookies i proxy vyvrátil jako příčinu) — nevyřešeno, appka na to
//   reaguje cirkuit breakerem níž, ne dalším zdrojem.
//
//   SMĚR: API vrací pojmenovaná pole longPercentage/shortPercentage → směr je
//   z názvu jednoznačný, nehádá se z pořadí (to byla příčina dřívějšího
//   30denního obrácení dat, viz scripts/fix-retail-history-inversion.js).
//
//   Limit volné úrovně je 100 požadavků/24 h na get-community-outlook.json;
//   cron po 30 min = 48/den, s rezervou.
//
// PŘÍSTUP 1 (fallback, týdenní): CFTC Non-reportable přes Socrata JSON API
//   (publicreporting.cftc.gov, dataset 6dca-aqww, pole nonrept_positions_*) — stejná
//   infrastruktura jako spolehlivě běžící fetch-cot.js. Per měna (ne per pár),
//   aktualizace jen týdně (páteční report) → použije se, jen když Myfxbook selže.
//
// FXSSI Current Ratio byl dřív PŘÍSTUP 1 (intradenní záloha + křížová kontrola
// směru proti Myfxbooku) — na výslovnou žádost uživatele odstraněn 8.9.2026.
// Důvod: jiné pokrytí brokerů i metodika než Myfxbook (viz historická data
// v retail_hist.json, sloupec "source") způsobovalo při každém přepnutí zdroje
// skok v grafu o 9-22 procentních bodů na měnu, nesouvisející s pohybem trhu
// (zdokumentováno v FX Analyzer auditu 8.9.2026, §9 a §10b) — appka teď při
// výpadku Myfxbooku raději nechá poslední známou hodnotu beze změny (a při
// delším výpadku spadne až na týdenní CFTC), než aby míchala dvě neslučitelné
// škály do jedné řady. Staré FXSSI body v historii se NEMAŽOU (viz git historie
// commitu, který tohle zavedl, pro plný kontext).
//
// Historická poznámka: HTML stránka myfxbook.com/community/outlook je z GH Actions
// blokovaná Cloudflare (403) — proto se používá výhradně oficiální REST API.
//
// Výstup: data/retail_hist.json = { updated, source, points:[ {t, pairs:{EURUSD:{l,s}}, ccy:{USD:..}, source } ] }
const fs = require("fs");
const CUR = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
// Společná hlavička byla dřív JEDNA (UA) sdílená pro Myfxbook, FXSSI i CFTC — a
// nesla Referer patřící FXSSI ("fxssi.com/tools/current-ratio") i do volání na
// myfxbook.com. Nalezeno při vyšetřování výpadku 6.9.2026 (Myfxbook login.json
// uspěl, ale get-community-outlook.json vracel "Invalid session." u KAŽDÉHO
// běhu 19+ hodin v kuse — to je typický podpis serveru, co request kvůli
// referer/origin mismatchi tiše přiřadí jinam, ne skutečně vypršelé session).
// Každý zdroj má teď vlastní, k sobě patřící Referer.
const UA_BASE = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
};
const UA_MYFX = { ...UA_BASE, "Referer": "https://www.myfxbook.com/community/outlook" };
const UA_OTHER = { ...UA_BASE };

// ── Myfxbook oficiální API (primární, plné pokrytí) ─────────────────
const MYFX = "https://www.myfxbook.com/api";

async function myfxGet(path) {
  const r = await fetch(MYFX + path, { headers: UA_MYFX, signal: AbortSignal.timeout(25000) });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); }
  catch (e) { throw new Error("Myfxbook HTTP " + r.status + " — nečitelná odpověď (prvních 200 znaků): " + text.slice(0, 200)); }
  if (!r.ok) throw new Error("Myfxbook HTTP " + r.status + " — " + JSON.stringify(j).slice(0, 300));
  if (j.error) throw new Error("Myfxbook: " + (j.message || "chyba") + " (celá odpověď: " + JSON.stringify(j).slice(0, 300) + ")");
  return j;
}

async function fetchMyfxbook() {
  const email = process.env.MYFXBOOK_EMAIL, password = process.env.MYFXBOOK_PASSWORD;
  if (!email || !password) throw new Error("MYFXBOOK_EMAIL/PASSWORD nejsou nastavené");
  const lg = await myfxGet(`/login.json?email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`);
  if (!lg.session) throw new Error("Myfxbook login: chybí session (odpověď: " + JSON.stringify(lg).slice(0, 300) + ")");
  const session = lg.session;
  console.log("Myfxbook login OK — session délka " + session.length + ", začíná „" + session.slice(0, 4) + "…");
  try {
    let j;
    try {
      // Historicky fungovala syrová (nekódovaná) session v URL (viz komentář
      // v hlavičce souboru). Než appku znovu spolehnout na jedinou variantu
      // natvrdo — Myfxbook se od minule mohl zachovat jinak — při "Invalid
      // session" zkusí ještě URL-kódovanou variantu, než se vzdá.
      j = await myfxGet(`/get-community-outlook.json?session=${session}`);
    } catch (e) {
      if (!/invalid session/i.test(e.message)) throw e;
      console.log("Syrová session odmítnuta (" + e.message + ") — zkouším URL-kódovanou…");
      j = await myfxGet(`/get-community-outlook.json?session=${encodeURIComponent(session)}`);
    }
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

// Per-měnový průměr. Bere JEN páry, kde jsou OBĚ nohy sledovaná měna — jinak by
// XAUUSD/BTCUSD apod. (Myfxbook je mezi ~187 symboly taky vrací) tahaly retail
// sentiment USD, i když o měnovém páru samy o sobě nic neříkají.
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
  const r = await fetch(url, { headers: UA_OTHER, signal: AbortSignal.timeout(25000) });
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

  // Store se čte JEDNOU hned na začátku (dřív se čítal zvlášť — tady pro
  // cooldown rozhodnutí níž, znovu u anti-inverze a znovu při zápisu) — jeden
  // objekt, co appka postupně doplňuje a na konci uloží celý najednou.
  let store = { updated: "", points: [] };
  try { store = JSON.parse(fs.readFileSync("data/retail_hist.json", "utf8")); } catch (e) {}
  if (!Array.isArray(store.points)) store.points = [];
  const myfxState = store.myfxbook && typeof store.myfxbook === "object" ? store.myfxbook : { failStreak: 0, lastTry: 0 };

  // 1) Myfxbook — plné pokrytí (~140 měnových párů, všech 28 z STANDARD_PAIRS).
  // CIRCUIT BREAKER: po MYFX_FAIL_THRESHOLD selháních za sebou appka Myfxbook
  // na MYFX_COOLDOWN_MS přestane zkoušet (rovnou na CFTC, viz níž — FXSSI mezi-
  // krok byl odstraněn, viz komentář v hlavičce souboru). Appka má za sebou
  // rozsáhlý dřívější průzkum (scripts/probe-myfxbook-*.js) — IP rotace,
  // cookies, POST místo GET, hlavičky prohlížeče i 4 veřejné proxy byly
  // vyzkoušené a vyvrácené (session padá i po JEDNOM keep-alive TCP spojení,
  // tedy ne kvůli rotaci IP). Nevyvrácená zůstala jen jedna hypotéza z toho
  // průzkumu (probe-myfxbook-session.js, H-E): vyčerpaný denní limit, hlášený
  // STEJNOU hláškou "Invalid session." jako cokoli jiného. Pokud je to pravda,
  // dalších 48×/den neúspěšných pokusů (retail.yml běží po 30 min) situaci jen
  // zhoršuje, ne zlepšuje — cooldown tomu zabrání, a jakmile Myfxbook jednou
  // znovu projde, počítadlo se vynuluje a appka se vrátí k běžné frekvenci.
  const MYFX_FAIL_THRESHOLD = 3;
  const MYFX_COOLDOWN_MS = 3 * 3600 * 1000; // 3 hodiny
  const cooldownLeft = MYFX_COOLDOWN_MS - (Date.now() - (myfxState.lastTry || 0));
  const skipMyfx = (myfxState.failStreak || 0) >= MYFX_FAIL_THRESHOLD && cooldownLeft > 0;

  let myfx = null;
  if (skipMyfx) {
    console.log(`Myfxbook přeskočeno — ${myfxState.failStreak}× za sebou selhal, cooldown ještě ${Math.round(cooldownLeft / 60000)} min.`);
  } else {
    try {
      myfx = await fetchMyfxbook();
      console.log("Myfxbook OK:", Object.keys(myfx).length, "párů");
      myfxState.failStreak = 0;
    } catch (e) {
      myfxState.failStreak = (myfxState.failStreak || 0) + 1;
      console.log(`Myfxbook selhal (${myfxState.failStreak}× za sebou):`, e.message);
    }
    myfxState.lastTry = Date.now();
  }

  if (myfx) {
    pairs = myfx;
    ccy = pairsToCcy(pairs);
    source = "myfxbook-api";
    console.log("Zdroj:", source, "· párů celkem:", Object.keys(pairs).length, "·", JSON.stringify(ccy));
  }

  // 2) CFTC Non-reportable — poslední záchranná síť, jen když Myfxbook selže
  // (nebo je v cooldownu). Záměrně BEZ FXSSI mezikroku (odstraněn 8.9.2026 na
  // žádost uživatele — jiná metodika/pokrytí brokerů způsobovalo skoky v grafu
  // při každém přepnutí zdroje, viz hlavička souboru). CFTC se aktualizuje jen
  // týdně, takže i jako fallback nezpůsobuje častý sawtooth efekt.
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
    console.warn("Žádný retail zdroj nedostupný (Myfxbook i CFTC selhaly) — nepřepisuju, zkusím příští běh.");
    process.exit(0);
  }

  // GH Actions "::warning::" anotace — dřívější výpadek (7.–8.9.2026, Myfxbook
  // "Wrong email/password") běžel 3 dny neviditelně, protože job vždycky skončil
  // "success" (fallback je legitimní, exit 0 je správně) a nikde se nezobrazilo,
  // ŽE se použil fallback. Tohle nemění exit kód (zelený běh zůstává zelený),
  // jen přidá varovný trojúhelník do seznamu běhů, když primární zdroj neseděl.
  if (source !== "myfxbook-api") {
    console.log(`::warning::Retail běží na záloze (${source}), ne na Myfxbooku — Myfxbook selhal ${myfxState.failStreak || 0}× za sebou.`);
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
  // je to podpis prohozených long/short, ne pohyb trhu. (store už načtený
  // nahoře — žádné druhé čtení souboru.)
  const prev = [...store.points].reverse().find((p) => p.source === source && p.pairs && Object.keys(p.pairs).length);
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

  store.points.push(point);
  store.points = store.points.slice(-1100); // ~45 dní bodů
  store.updated = point.t;
  store.source = source;
  store.myfxbook = myfxState;

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/retail_hist.json", JSON.stringify(store));
  console.log("Zapsáno data/retail_hist.json · bodů:", store.points.length, "· zdroj:", source, "· ccy:", JSON.stringify(ccy));
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

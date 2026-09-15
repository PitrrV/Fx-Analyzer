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
//   výpadky (probe-myfxbook-*.js dokumentuje rozsáhlý průzkum, který IP rotaci
//   MEZI voláními v jednom běhu vyvrátil jako příčinu — keep-alive test). To
//   ale nevyvrací, že by celý sdílený GitHub Actions/Azure IP rozsah mohl mít
//   u Myfxbooku špatnou reputaci jako celek — přesně tohle potvrzeně platilo
//   u ForexFactory/Cloudflare (viz scripts/fetch-calendar.js). Od 10.9.2026 se
//   proto nejdřív zkouší Supabase relay (fetchMyfxbookViaRelay, jiná IP), a až
//   při jeho selhání přímá cesta níž — cirkuit breaker vidí jen výsledek obojího.
//
//   SMĚR: API vrací pojmenovaná pole longPercentage/shortPercentage → směr je
//   z názvu jednoznačný, nehádá se z pořadí (to byla příčina dřívějšího
//   30denního obrácení dat, viz scripts/fix-retail-history-inversion.js).
//
//   Limit volné úrovně je 100 požadavků/24 h na get-community-outlook.json;
//   cron po 30 min = 48/den, s rezervou.
//
// PŘÍSTUP 1 (NOUZOVÁ ZÁLOHA, jen když Myfxbook selže): FXSSI Current Ratio —
// veřejné API bez přihlašování, tedy imunní vůči celé třídě problémů, co
// postihují Myfxbook (heslo/session/účet). Odstraněno 8.9.2026 na žádost
// uživatele, protože jiné pokrytí brokerů/metodika způsobovalo skok v grafu
// o 9-22 p.b. na měnu při každém přepnutí zdroje (audit 8.9.2026, §9/§10b).
// Znovu zavedeno 13.9.2026 — bezpečně tentokrát, protože engine.js má od
// PR #218 filtr isMyfxbookRetailPoint(), co do grafů (index.html/m.html)
// pouští JEN source "myfxbook-api"/"myfxbook-api+fxssi" — FXSSI body se
// source "fxssi-current-ratio" se v grafu prostě nezobrazí (mezera, ne
// skok), ale skóre appky aspoň nesedí dny na 100% zastaralých datech, když
// Myfxbook zrovna nejede (viz incident 11.-13.9.2026: 53+ h/106+ běhů bez
// dat, protože cirkulární jistič níž nikdy fakticky nezapnul — teď opraveno).
//
// CFTC Non-reportable (týdenní futures pozicování) fallbackem NENÍ a
// nebude — jiná třída aktiva, jiná frekvence, obracelo to znaménko
// kontrariánského signálu (JPY 72% long CFTC vs 19% Myfxbook v témže
// okamžiku 8.9.2026). Odstraněno 9.9.2026, zůstává odstraněné.
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
const UA_FXSSI = { ...UA_BASE, "Referer": "https://fxssi.com/tools/current-ratio" };

// ── Myfxbook oficiální API (primární, plné pokrytí) ─────────────────
const MYFX = "https://www.myfxbook.com/api";

// Supabase relay (stejný projekt/anon klíč jako ff-calendar-relay, viz
// scripts/fetch-calendar.js) — test hypotézy, že Myfxbook má u GitHub Actions/
// Azure IP rozsahu podobně špatnou reputaci jako potvrzeně měl ForexFactory/
// Cloudflare. Relay dělá CELÝ login→outlook→logout dance server-side (Supabase
// project secrets, heslo z tohohle skriptu nikam neputuje) a vrací syrovou
// get-community-outlook.json odpověď. Bez záruky úspěchu — proto vždy s pádem
// na přímou cestu (fetchMyfxbook níž) při jakémkoli selhání relay.
const MYFXBOOK_RELAY_URL = "https://wdcvxfbhauwvwzbatkfh.supabase.co/functions/v1/myfxbook-relay";
const MYFXBOOK_RELAY_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndkY3Z4ZmJoYXV3dnd6YmF0a2ZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1NjU2NjEsImV4cCI6MjA5NzE0MTY2MX0.7ofHhBK6OxTug6l3MgnLJFNECZOmaKB_Z35v9v80I2o";

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

// Sdíleno oběma cestami (relay i přímá) — jediné místo, co parsuje symbols[]
// z get-community-outlook.json, ať parsování nedrifiuje mezi variantami.
function parseOutlookSymbols(j) {
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
}

async function fetchMyfxbookViaRelay() {
  const r = await fetch(MYFXBOOK_RELAY_URL, { headers: { Authorization: `Bearer ${MYFXBOOK_RELAY_KEY}` }, signal: AbortSignal.timeout(25000) });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); }
  catch (e) { throw new Error("Myfxbook relay HTTP " + r.status + " — nečitelná odpověď: " + text.slice(0, 200)); }
  if (!r.ok || j.error) throw new Error("Myfxbook relay: " + (j.error || ("HTTP " + r.status)));
  return parseOutlookSymbols(j);
}

async function fetchMyfxbook() {
  // 10.9.2026: GH Actions log hlásí "Wrong email/password." přímo z Myfxbook
  // login endpointu, i když uživatel potvrzuje, že se stejným heslem běžně
  // přihlašuje v prohlížeči — plná historie fetch-retail.js (PR #210/#211/#212)
  // ukazuje, že logika čtení/kódování těchto proměnných se od zavedení
  // nezměnila, takže jde buď o skutečně jiný obsah GH Secret (typo/staré heslo),
  // nebo o neviditelný whitespace (typicky trailing \n) při vkládání do GH
  // Secrets — .trim() to potichu opraví, kdyby šlo o druhý případ, a
  // bezpečné (nemaskovatelné) délky níž potvrdí/vyvrátí hypotézu v logu.
  const rawEmail = process.env.MYFXBOOK_EMAIL || "", rawPassword = process.env.MYFXBOOK_PASSWORD || "";
  const email = rawEmail.trim(), password = rawPassword.trim();
  if (!email || !password) throw new Error("MYFXBOOK_EMAIL/PASSWORD nejsou nastavené");
  if (email.length !== rawEmail.length || password.length !== rawPassword.length) {
    console.log(`MYFXBOOK_EMAIL/PASSWORD: nalezen obalující whitespace (email ${rawEmail.length}→${email.length} znaků, heslo ${rawPassword.length}→${password.length} znaků) — ořezáno.`);
  } else {
    console.log(`MYFXBOOK_EMAIL/PASSWORD: bez obalujícího whitespace (email ${email.length} znaků, heslo ${password.length} znaků).`);
  }
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
    return parseOutlookSymbols(j);
  } finally {
    try { await myfxGet(`/logout.json?session=${session}`); } catch (e) {}
  }
}

// Relay první (test IP-reputační hypotézy), přímá cesta jako fallback při
// jakémkoli selhání relay — stejný vzor jako fetchFFWeek() v
// scripts/fetch-calendar.js. Circuit breaker níž vidí jen výsledek TÉHLE
// funkce, ne dílčí selhání relay.
async function fetchMyfxbookAny() {
  try {
    const pairs = await fetchMyfxbookViaRelay();
    console.log("Myfxbook (přes Supabase relay) OK:", Object.keys(pairs).length, "párů");
    return pairs;
  } catch (e) {
    console.log("Myfxbook relay selhal:", e.message, "— zkouším přímo…");
    return await fetchMyfxbook();
  }
}

// ── FXSSI Current Ratio (nouzová záloha, jen když Myfxbook selže) ───
// Beze změny logiky oproti verzi před odstraněním 8.9.2026 (git historie,
// commit b10c56be~1) — jen znovu zapojené, viz komentář v hlavičce souboru.
const FXSSI_URL = "https://c.fxssi.com/api/current-ratio";

async function fetchFxssi() {
  const r = await fetch(FXSSI_URL, { headers: UA_FXSSI, signal: AbortSignal.timeout(25000) });
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

(async () => {
  let ccy = null, pairs = {}, source = "";

  // Store se čte JEDNOU hned na začátku (dřív se čítal zvlášť — tady pro
  // cooldown rozhodnutí níž, znovu u anti-inverze a znovu při zápisu) — jeden
  // objekt, co appka postupně doplňuje a na konci uloží celý najednou.
  let store = { updated: "", points: [] };
  try { store = JSON.parse(fs.readFileSync("data/retail_hist.json", "utf8")); } catch (e) {}
  if (!Array.isArray(store.points)) store.points = [];
  const myfxState = store.myfxbook && typeof store.myfxbook === "object" ? store.myfxbook : { failStreak: 0, lastTry: 0 };

  // 1) Myfxbook — PRIMÁRNÍ zdroj (~140 měnových párů, všech 28 z STANDARD_PAIRS).
  // CIRCUIT BREAKER: po MYFX_FAIL_THRESHOLD selháních za sebou appka Myfxbook
  // na MYFX_COOLDOWN_MS přestane zkoušet a jede na FXSSI zálohu níž. Appka má
  // za sebou rozsáhlý dřívější průzkum (scripts/probe-myfxbook-*.js) — IP
  // rotace, cookies, POST místo GET, hlavičky prohlížeče i 4 veřejné proxy
  // byly vyzkoušené a vyvrácené (session padá i po JEDNOM keep-alive TCP
  // spojení, tedy ne kvůli rotaci IP). Jedna z nevyvrácených hypotéz
  // (probe-myfxbook-session.js, H-E): vyčerpaný denní limit/anti-abuse
  // ochrana, hlášená STEJNOU hláškou jako cokoli jiného ("Invalid session."
  // dřív, "Wrong email/password." u incidentu 11.-13.9.2026) — nedá se to od
  // skutečně špatných údajů rozeznat jen podle textu chyby. Dalších 48×/den
  // neúspěšných pokusů (retail.yml běží po 30 min) situaci jen zhoršuje, ne
  // zlepšuje.
  //
  // OPRAVENO 13.9.2026: tenhle stav (failStreak/lastTry) se dřív ukládal na
  // disk JEN na úspěšné cestě (store.myfxbook = myfxState těsně před finálním
  // zápisem, viz níž) — když Myfxbook selhal, skript skončil dřív (viz starý
  // blok "if (!ccy)") a aktualizované počítadlo se NIKDY neuložilo. Cirkulární
  // jistič tak fakticky nikdy nezapnul: incident 11.-13.9.2026 appka zkoušela
  // přihlásit se stejným neúspěšným pokusem 53+ hodin, ~106× po sobě, každých
  // 30 minut, bez jakéhokoli zpomalení — přesně ten vzorec (pravidelný
  // automatizovaný login pokus stovky× po sobě), co bezpečnostní systémy
  // typicky vyhodnotí jako útok. Teď se store.myfxbook ukládá HNED po každém
  // pokusu (úspěch i neúspěch), nezávisle na zbytku běhu.
  const MYFX_FAIL_THRESHOLD = 3;
  const MYFX_COOLDOWN_MS = 3 * 3600 * 1000; // 3 hodiny
  const cooldownLeft = MYFX_COOLDOWN_MS - (Date.now() - (myfxState.lastTry || 0));
  const skipMyfx = (myfxState.failStreak || 0) >= MYFX_FAIL_THRESHOLD && cooldownLeft > 0;

  let myfx = null;
  if (skipMyfx) {
    console.log(`Myfxbook přeskočeno — ${myfxState.failStreak}× za sebou selhal, cooldown ještě ${Math.round(cooldownLeft / 60000)} min.`);
  } else {
    try {
      myfx = await fetchMyfxbookAny();
      console.log("Myfxbook OK:", Object.keys(myfx).length, "párů");
      myfxState.failStreak = 0;
    } catch (e) {
      myfxState.failStreak = (myfxState.failStreak || 0) + 1;
      console.log(`Myfxbook selhal (${myfxState.failStreak}× za sebou):`, e.message);
    }
    myfxState.lastTry = Date.now();
  }

  // Persistovat cirkulární jistič HNED, nezávisle na tom, jak dopadne zbytek
  // běhu (FXSSI záloha níž, validace) — viz OPRAVENO výš. store.points/
  // updated/source se tady ještě nemění (na to dojde jen na úspěšné cestě
  // dole), takže tenhle zápis nic z historie neztratí ani nepřepíše.
  store.myfxbook = myfxState;
  try {
    fs.mkdirSync("data", { recursive: true });
    fs.writeFileSync("data/retail_hist.json", JSON.stringify(store));
  } catch (e) { console.error("Nepodařilo se persistovat myfxbook cirkulární jistič:", e.message); }

  if (myfx) {
    pairs = myfx;
    ccy = pairsToCcy(pairs);
    source = "myfxbook-api";
    console.log("Zdroj:", source, "· párů celkem:", Object.keys(pairs).length, "·", JSON.stringify(ccy));
  }

  // 2) FXSSI — NOUZOVÁ záloha, jen když Myfxbook selhal/je v cooldownu (viz
  // komentář v hlavičce souboru pro plné odůvodnění a proč je bezpečné ho mít
  // zpátky). Veřejné API bez přihlašování — imunní vůči Myfxbook problémům.
  let fxssi = null;
  if (!myfx) {
    try {
      fxssi = await fetchFxssi();
      console.log("FXSSI OK (nouzová záloha):", Object.keys(fxssi).length, "párů");
    } catch (e) {
      console.log("FXSSI selhal:", e.message);
    }
  }
  if (!ccy && fxssi) {
    pairs = fxssi;
    ccy = pairsToCcy(pairs);
    source = "fxssi-current-ratio";
    console.log("Zdroj:", source, "· párů celkem:", Object.keys(pairs).length, "·", JSON.stringify(ccy));
  }

  if (!ccy) {
    // Recoverable stav (Myfxbook i FXSSI selhaly) — NEZAPISUJE se nic.
    // data/retail_hist.json (kromě myfxbook stavu výš) zůstává nedotčené,
    // poslední dobrá hodnota v grafu stojí dál, další běh to zkusí znovu.
    // Exit 0 (ne 1), ať tohle negeneruje opakované CI failure notifikace;
    // skutečná chyba (FATAL) má 1.
    //
    // GH Actions "::warning::" anotace — dřívější výpadek (7.–8.9.2026, Myfxbook
    // "Wrong email/password") běžel 3 dny neviditelně, protože job vždycky
    // skončil "success" a nikde se nezobrazilo, že se nic nezapsalo. Tohle
    // nemění exit kód (zelený běh zůstává zelený), jen přidá varovný
    // trojúhelník do seznamu běhů. Chybu z Myfxbooku samotného už loguje
    // řádek "Myfxbook selhal (N× za sebou): …" o pár řádků výš.
    console.warn("Žádný retail zdroj nedostupný (Myfxbook i FXSSI selhaly) — nepřepisuju, zkusím příští běh.");
    console.log(`::warning::Myfxbook nedostupný (${myfxState.failStreak || 0}× za sebou), FXSSI záloha taky selhala — nezapisuji nový bod, v grafu zůstane poslední známá hodnota.`);
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

  // ── ZLATO (XAUUSD) — vedlejší produkt téhož fetche, ne nový zdroj ──────
  // parseOutlookSymbols()/fetchFxssi() NEfiltrují na 28 FX párů — vrací
  // KAŽDÝ symbol tvaru 6 velkých písmen, co Myfxbook/FXSSI mají, a XAUUSD
  // mezi nimi reálně je (ověřeno živě, appka ho tak sbírá potichu už měsíce,
  // jen `pairsToCcy()` výš ho zahazuje, protože XAU není v CUR). Samostatný
  // soubor (data/gold_retail.json), vlastní historie — try/catch, ať
  // případný problém tady nikdy nezkazí zelený běh FX retailu výš.
  try {
    const g = pairs.XAUUSD;
    if (g && Number.isFinite(g.l)) {
      let goldStore = { points: [] };
      try { goldStore = JSON.parse(fs.readFileSync("data/gold_retail.json", "utf8")); } catch (e) {}
      if (!Array.isArray(goldStore.points)) goldStore.points = [];
      goldStore.points.push({ t: point.t, l: g.l, s: g.s, source });
      goldStore.points = goldStore.points.slice(-1100);
      goldStore.updated = point.t;
      fs.writeFileSync("data/gold_retail.json", JSON.stringify(goldStore));
      console.log("Zapsáno data/gold_retail.json · bodů:", goldStore.points.length, "· XAUUSD long", g.l + "%");
    } else {
      console.log("XAUUSD nebylo v tomhle běhu ve zdroji (" + source + ") — gold_retail.json nedotčen.");
    }
  } catch (e) {
    console.warn("Zápis data/gold_retail.json selhal (FX retail výš je v pořádku):", e.message);
  }
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

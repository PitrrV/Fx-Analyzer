// Ekonomický kalendář — GitHub Action scrapuje web ForexFactory (server na něj
// dosáhne bez Cloudflare blocku). FF vkládá data jako:
//   window.calendarComponentStates[1] = { days: [ {date,dateline,events:[...]} ] }
// Vnější `days:` není v uvozovkách (není to JSON), ale pole `days` (jeho hodnota)
// už validní JSON je → vytáhneme ho a projdeme události. Má actual+forecast+
// previous + plné pokrytí + budoucí týdny. Zapíše data/calendar.json.
const fs = require("fs");
const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Accept: "text/html,application/xhtml+xml",
};
const MON = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const weekParam = (d) => MON[d.getUTCMonth()] + d.getUTCDate() + "." + d.getUTCFullYear();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ForexFactory/Cloudflare blokuje GitHub Actions/Azure IP rozsah nepřetržitě od 9.9.2026
// ~13:46 UTC (HTTP 403, potvrzeno živě i pro tenhle cron). Supabase Edge Function egress
// blokovaný NENÍ (ověřeno 2026-09-10 opakovaným testem) — přes ni běží malý HTTP relay
// (ff-calendar-relay, stejný Supabase projekt jako Fundament app, viz sync.js v tomhle
// repu). ANON klíč je veřejný/publishable (stejný, co už appka posílá z prohlížeče v
// sync.js) — bezpečně hardcodovatelný. Failover na přímý fetch pro případ, že relay
// zrovna nefunguje nebo skript běží mimo GitHub Actions (tam blok není).
const FF_RELAY_BASE = "https://wdcvxfbhauwvwzbatkfh.supabase.co/functions/v1/ff-calendar-relay";
const FF_RELAY_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndkY3Z4ZmJoYXV3dnd6YmF0a2ZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1NjU2NjEsImV4cCI6MjA5NzE0MTY2MX0.7ofHhBK6OxTug6l3MgnLJFNECZOmaKB_Z35v9v80I2o";
async function fetchFFWeek(wp) {
  try {
    const r = await fetch(`${FF_RELAY_BASE}?week=${wp}`, { headers: { Authorization: `Bearer ${FF_RELAY_KEY}` } });
    if (r.status === 200) return r;
    console.log(`FF relay ${wp}: status=${r.status} — zkouším přímý fetch...`);
  } catch (e) {
    console.log(`FF relay ${wp}: ERR ${e.message} — zkouším přímý fetch...`);
  }
  return fetch("https://www.forexfactory.com/calendar?week=" + wp, { headers: UA });
}

// Vytáhne všechna pole `days: [...]` (validní JSON pole) napříč HTML.
function extractDays(html) {
  const out = [];
  let i = 0;
  while ((i = html.indexOf("days:", i)) !== -1) {
    const br = html.indexOf("[", i);
    if (br === -1) break;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let k = br; k < html.length; k++) {
      const c = html[k];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
      else if (c === '"') inStr = true;
      else if (c === "[") depth++;
      else if (c === "]") { depth--; if (depth === 0) { end = k; break; } }
    }
    if (end !== -1) { try { const a = JSON.parse(html.slice(br, end + 1)); if (Array.isArray(a)) out.push(...a); } catch (e) {} i = end + 1; }
    else i += 5;
  }
  return out;
}
function impactOf(e) {
  const s = ((e.impactClass || "") + " " + (e.impactName || e.impactTitle || e.impact || "")).toLowerCase();
  if (/red|high/.test(s)) return "High";
  if (/ora|med/.test(s)) return "Medium";
  if (/yel|low/.test(s)) return "Low";
  return "";
}
const val = (x) => (x != null && String(x).trim() !== "" && String(x).trim() !== "&nbsp;" ? String(x).trim() : "");
function norm(e) {
  const dl = e.dateline || e._dd;
  const iso = dl ? new Date((typeof dl === "number" ? dl : parseInt(dl, 10)) * 1000).toISOString() : "";
  return {
    title: (e.name || "").replace(/<[^>]+>/g, "").trim(),
    country: (e.currency || e.country || "").toUpperCase(),
    date: iso,
    impact: impactOf(e),
    actual: val(e.actual),
    forecast: val(e.forecast),
    previous: val(e.previous),
  };
}

(async () => {
  const now = new Date();
  let rawEvents = [], okWeeks = 0;
  // Širší zpětné okno: rozhodnutí CB o sazbách (á ~6 týdnů) zůstanou v kalendáři
  // dostatečně dlouho, aby je auto-update stihl zachytit a uložit do v5_cb_rates.
  for (const off of [-42, -35, -28, -21, -14, -7, 0, 7, 14]) {
    const wp = weekParam(new Date(now.getTime() + off * 86400000));
    try {
      const r = await fetchFFWeek(wp);
      const html = await r.text();
      const days = extractDays(html);
      let n = 0;
      for (const d of days) for (const e of (d.events || [])) if (e && e.name) { e._dd = d.dateline; rawEvents.push(e); n++; }
      if (n > 0) okWeeks++;
      console.log(`FF ${wp}: status=${r.status} days=${days.length} events=${n}`);
    } catch (e) { console.log(`FF ${wp}: ERR ${e.message}`); }
    await sleep(1500);
  }
  if (rawEvents[0]) console.log("VZOREK událost:", JSON.stringify(rawEvents.find(e=>e.actual&&e.actual!=="")||rawEvents[0]).slice(0, 500));

  const map = new Map();
  for (const e of rawEvents) {
    const n = norm(e);
    if (!n.title || !n.date) continue;
    const k = n.title + "|" + n.country + "|" + n.date;
    const p = map.get(k);
    if (!p || (!p.actual && n.actual)) map.set(k, n);
  }
  // Pevné okno podle UTC dne (−41 až +21 dní): okraje stahovaných týdnů se mezi běhy
  // posouvaly o den (jednou události z 8. 9., podruhé z 10. 11.) → 878/879 událostí
  // a commit dvakrát za hodinu. Okno se mění jen o půlnoci UTC.
  const day0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const winFrom = day0 - 41 * 86400000, winTo = day0 + 21 * 86400000;
  const events = [...map.values()].filter((e) => { const t = new Date(e.date).getTime(); return t >= winFrom && t < winTo; }).sort((a, b) => new Date(a.date) - new Date(b.date));
  // Scrape občas vrátí událost bez actual, kterou předchozí běh už měl (počet
  // actual mezi běhy "blikal" 407→402→405→402) — převzít dřív známé hodnoty.
  let prevCal = null;
  try { prevCal = JSON.parse(fs.readFileSync("data/calendar.json", "utf8")); } catch (e) {}
  if (prevCal && Array.isArray(prevCal.events)) {
    const pk = new Map(prevCal.events.map((e) => [e.title + "|" + e.country + "|" + e.date, e]));
    for (const e of events) {
      const p = pk.get(e.title + "|" + e.country + "|" + e.date);
      if (!p) continue;
      for (const f of ["actual", "forecast", "previous"]) if (!e[f] && p[f]) e[f] = p[f];
    }
  }
  const withActual = events.filter((e) => e.actual).length;
  console.log("=== VÝSLEDEK ===  událostí:", events.length, "· s actual:", withActual);
  console.log("ukázka s actual:", JSON.stringify(events.find((e) => e.actual) || {}));

  if (events.length < 20) { console.error("Příliš málo událostí — nepřepisuju."); process.exit(1); }
  // Pojistka proti neúplnému stažení (dřív jen "aspoň 20", běžně ~886): nezapisovat,
  // když počet klesne pod 70 % předchozího nebo chybí některý z příštích 2 týdnů.
  let prevCount = 0;
  try { prevCount = (JSON.parse(fs.readFileSync("data/calendar.json", "utf8")).events || []).length; } catch (e) {}
  // Úplnost po KALENDÁŘNÍCH týdnech ForexFactory (neděle–sobota, čas New Yorku):
  // dřív plovoucí okno 7–14 dní zasahovalo do přespříštího týdne, takže výpadek
  // příštího týdne prošel (simulace zapsala 764 událostí) a prohlížeče by pak
  // budoucí události toho týdne smazaly jako "fantomy".
  const nyWeek = (t) => { const ny = new Date(new Date(t).toLocaleString("en-US", { timeZone: "America/New_York" })); ny.setHours(0, 0, 0, 0); ny.setDate(ny.getDate() - ny.getDay()); return ny.toISOString().slice(0, 10); };
  const perWeek = {}; for (const e of events) { const k = nyWeek(e.date); perWeek[k] = (perWeek[k] || 0) + 1; }
  // Stejné týdny, jaké se stahují (weekParam bere UTC datum) — poledne UTC daného dne.
  const atNoon = (off) => { const d = new Date(now.getTime() + off * 86400000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12); };
  const wks = [0, 7, 14].map((off) => nyWeek(atNoon(off))), w0 = wks[0];
  const past = Object.keys(perWeek).filter((k) => k < w0).sort().slice(1).map((k) => perWeek[k]).sort((a, b) => a - b); // bez nejstaršího (neúplného) týdne
  const typical = past.length ? past[Math.floor(past.length / 2)] : 80;
  const thin = wks.filter((k) => (perWeek[k] || 0) < Math.max(20, typical * 0.5));
  console.log("Týdny FF (ne–so NY):", wks.map((k) => k + "=" + (perWeek[k] || 0)).join(", "), "· běžně ~" + typical);
  if (thin.length) { console.error("Neúplný týden " + thin.join(", ") + " (< polovina běžného počtu) — nepřepisuju."); process.exit(1); }
  if (prevCount && events.length < prevCount * 0.7) { console.error(`Neúplné stažení: ${events.length} vs předchozích ${prevCount} — nepřepisuju.`); process.exit(1); }
  fs.mkdirSync("data", { recursive: true });
  // Zapsat jen při skutečné změně událostí — dřív se každých 15 min commitovalo
  // jen kvůli poli "updated" (audit 4.7: ~5 400 commitů týdně).
  // Za "beze změny" se počítá i případ, kdy jediný rozdíl je budoucí událost bez actual,
  // jejíž datum ForexFactory mezi stránkami přeskakuje (JPY Final Manufacturing PMI
  // 2. vs 5. 11. → commit dvakrát za hodinu). Skutečné přeplánování se zapíše s
  // nejbližší jinou změnou.
  const flipOnly = (() => {
    if (!prevCal || !Array.isArray(prevCal.events)) return false;
    const key = (e) => JSON.stringify(e), A = new Set(prevCal.events.map(key)), B = new Set(events.map(key));
    const onlyNew = events.filter((e) => !A.has(key(e))), onlyOld = prevCal.events.filter((e) => !B.has(key(e)));
    if (!onlyNew.length || onlyNew.length !== onlyOld.length) return false;
    return onlyNew.every((n) => !n.actual && Date.parse(n.date) > now.getTime() && onlyOld.some((o) => o.title === n.title && o.country === n.country && !o.actual && Math.abs(Date.parse(o.date) - Date.parse(n.date)) <= 7 * 86400000));
  })();
  if (flipOnly) console.log("calendar.json: jen přeskakující datum budoucí události, nepřepisuji.");
  if (prevCal && (flipOnly || JSON.stringify(prevCal.events) === JSON.stringify(events))) {
    console.log("calendar.json: události beze změny, nepřepisuji.");
  } else {
    fs.writeFileSync("data/calendar.json", JSON.stringify({ updated: new Date().toISOString(), source: "forexfactory-web", count: events.length, withActual: events.filter((e) => e.actual).length, events }));
    console.log("Zapsáno data/calendar.json");
  }

  // ── Akumulovaná historie (data/calendar_hist.json) ──────────────────────
  // data/calendar.json je jen ROLLING okno (~8 týdnů, tenhle cron ho každý běh
  // přepíše) — server-side skripty, co z něj počítaly skóre (bias-alerts.js,
  // snapshot-engine.js, smart-alerts.js), tak měly k dispozici jen zlomek
  // FUND_HIST_WINDOW_WEEKS (80 týdnů/~18 měsíců), zatímco appka v prohlížeči
  // si stejná data průběžně slučuje do vlastní dlouhodobé historie
  // (mergeFFHistory v engine.js, FF_STORE_MONTHS=36) — odsud reálný nález:
  // appka v prohlížeči a Telegram alert ukazovaly různé skóre pro stejný pár
  // ve stejnou chvíli. Tenhle blok dělá server-side to samé co mergeFFHistory
  // — slučuje čerstvá data do dlouhodobé historie místo přepisu, stejný klíč
  // (title|country|den) jako scripts/backfill-calendar.js, ať se soubory
  // nerozejdou. Historie tu už byla jednorázově naplněná od 2024-03
  // (calendar-backfill.yml) — tenhle blok ji jen udržuje průběžně čerstvou.
  const HIST_MONTHS = 22, HIST_CAP = 20000;
  const evKey = (e) => e.title + "|" + e.country + "|" + String(e.date).slice(0, 10);
  let hist = { source: "forexfactory-web backfill (historické týdny)", events: [] };
  try { const prev = JSON.parse(fs.readFileSync("data/calendar_hist.json", "utf8")); if (prev && Array.isArray(prev.events)) hist = prev; } catch (e) {}
  const histMap = new Map();
  for (const e of hist.events) histMap.set(evKey(e), e);
  for (const e of events) {
    const k = evKey(e), prev = histMap.get(k);
    if (!prev || (!prev.actual && e.actual) || (!prev.forecast && e.forecast) || (!prev.previous && e.previous)) histMap.set(k, e);
  }
  // Přeplánované události: budoucí/nedávný záznam bez actual, který čerstvé okno
  // (všech 9 týdnů staženo) už neobsahuje, je fantom (NZ CPI 19.10. → 21.10.).
  const freshKeys = new Set(events.map(evKey));
  const fMin = Math.min(...events.map((e) => new Date(e.date).getTime())), fMax = Math.max(...events.map((e) => new Date(e.date).getTime()));
  let phantoms = 0;
  if (okWeeks === 9) for (const [k, e] of histMap) {
    const t = new Date(e.date).getTime();
    if (!e.actual && t >= fMin && t <= fMax && !freshKeys.has(k)) { histMap.delete(k); phantoms++; }
  }
  // Starší fantomy mimo čerstvé okno: proběhlá událost bez actual, ke které existuje
  // stejná událost s actual do ±3 dnů (French Trade Balance 7. 9. vs 8. 9.). ±3 dny
  // < týden, ať se nesmažou týdenní události (Unemployment Claims).
  const withAct = new Map();
  for (const e of histMap.values()) if (e.actual) { const k = e.title + "|" + e.country; (withAct.get(k) || withAct.set(k, []).get(k)).push(Date.parse(e.date)); }
  let oldPh = 0;
  for (const [k, e] of histMap) {
    const t = Date.parse(e.date), sib = withAct.get(e.title + "|" + e.country);
    if (!e.actual && t < Date.now() && sib && sib.some((x) => x !== t && Math.abs(x - t) <= 3 * 86400000)) { histMap.delete(k); oldPh++; }
  }
  console.log("Fantomové (přeplánované) události odstraněny:", phantoms, okWeeks === 9 ? "" : "(přeskočeno — nestaženy všechny týdny)", "· starší dvojice:", oldPh);
  let histEvents = [...histMap.values()];
  const cutoff = Date.now() - HIST_MONTHS * 30 * 86400000;
  histEvents = histEvents.filter((e) => { const t = new Date(e.date).getTime(); return isNaN(t) || t >= cutoff; });
  histEvents.sort((a, b) => new Date(a.date) - new Date(b.date));
  if (histEvents.length > HIST_CAP) histEvents = histEvents.slice(histEvents.length - HIST_CAP);
  if (JSON.stringify(hist.events) === JSON.stringify(histEvents)) { console.log("calendar_hist.json: beze změny, nepřepisuji."); return; }
  hist.events = histEvents;
  hist.updated = new Date().toISOString();
  hist.eventsTotal = histEvents.length;
  fs.writeFileSync("data/calendar_hist.json", JSON.stringify(hist));
  console.log("Zapsáno data/calendar_hist.json (" + histEvents.length + " událostí, akumulovaná historie).");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

// Jednorázový BACKFILL historických FF týdnů do data/calendar_hist.json.
// ODDĚLENÝ soubor — živého data/calendar.json ani enginu se nedotýká.
//
// Zdroj: stejné týdenní stránky forexfactory.com a IDENTICKÝ parser jako živý
// cron (scripts/fetch-calendar.js) → žádná normalizace názvů mezi zdroji,
// impact/actual/forecast/previous + unix dateline (čisté UTC).
//
// Šetrnost k FF: rozestup REQUEST_GAP_MS mezi stránkami + strop MAX_WEEKS
// týdnů na jeden běh. Skript je RESUMABLE (weeksDone v output souboru) —
// další dispatch pokračuje, kde minulý skončil; hotové týdny se nestahují znovu.
//
// POZOR na kvalitu: historické stránky nesou FINÁLNÍ (revidované) actualy,
// ne první otisk — proto se před použitím v backtestu MUSÍ projít validace
// proti live snapshotům (scripts/validate-calendar-hist.js).
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data", "calendar_hist.json");
const FROM = "2024-03-04";                 // pondělí před prvním COT týdnem (2024-03-19)
const REQUEST_GAP_MS = 2500;               // rozestup mezi stránkami
const MAX_WEEKS = parseInt(process.env.MAX_WEEKS || "70", 10); // strop na jeden běh

const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Accept: "text/html,application/xhtml+xml",
};
const MON = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const weekParam = (d) => MON[d.getUTCMonth()] + d.getUTCDate() + "." + d.getUTCFullYear();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── parser 1:1 z scripts/fetch-calendar.js ──────────────────────────────
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
  // resumable stav
  let out = { source: "forexfactory-web backfill (historické týdny)", from: FROM, weeksDone: {}, events: [] };
  try { const prev = JSON.parse(fs.readFileSync(OUT, "utf8")); if (prev && prev.weeksDone) out = prev; } catch (e) {}
  const seen = new Map(); // dedup title|country|den
  const evKey = (e) => e.title + "|" + e.country + "|" + String(e.date).slice(0, 10);
  for (const e of out.events) seen.set(evKey(e), e);

  // seznam pondělků FROM → dnes
  const mondays = [];
  for (let t = Date.parse(FROM + "T00:00:00Z"); t <= Date.now(); t += 7 * 86400000) mondays.push(new Date(t));
  const todo = mondays.filter((d) => !out.weeksDone[weekParam(d)]);
  console.log(`Týdnů celkem ${mondays.length} · hotovo ${mondays.length - todo.length} · v tomto běhu max ${Math.min(MAX_WEEKS, todo.length)}`);

  let done = 0, fails = 0;
  for (const d of todo.slice(0, MAX_WEEKS)) {
    const wp = weekParam(d);
    try {
      const r = await fetch("https://www.forexfactory.com/calendar?week=" + wp, { headers: UA, signal: AbortSignal.timeout(25000) });
      const html = await r.text();
      const days = extractDays(html);
      let n = 0;
      for (const day of days) for (const e of (day.events || [])) if (e && e.name) {
        e._dd = e.dateline || day.dateline;
        const ne = norm(e);
        if (!ne.title || !ne.date) continue;
        const k = evKey(ne); const prev = seen.get(k);
        if (!prev || (!prev.actual && ne.actual)) seen.set(k, ne);
        n++;
      }
      if (r.status === 200 && days.length) { out.weeksDone[wp] = n; done++; console.log(`FF ${wp}: events=${n}`); }
      else { fails++; console.log(`FF ${wp}: status=${r.status} days=${days.length} — nezapisuji jako hotový`); }
    } catch (e) { fails++; console.log(`FF ${wp}: ERR ${e.message}`); }
    await sleep(REQUEST_GAP_MS);
    if (fails >= 5) { console.log("Příliš mnoho selhání po sobě — končím běh, zbytek doženou další dispatche."); break; }
  }

  out.events = [...seen.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
  out.updated = new Date().toISOString();
  out.eventsTotal = out.events.length;
  out.weeksTotal = Object.keys(out.weeksDone).length;
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`OK · tento běh: ${done} týdnů (${fails} selhání) · celkem ${out.weeksTotal}/${mondays.length} týdnů · ${out.eventsTotal} eventů`);
  if (out.weeksTotal < mondays.length) console.log(`ZBÝVÁ ${mondays.length - out.weeksTotal} týdnů — spusť workflow znovu.`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

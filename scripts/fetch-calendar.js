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
  let rawEvents = [];
  for (const off of [-7, 0, 7, 14]) {
    const wp = weekParam(new Date(now.getTime() + off * 86400000));
    try {
      const r = await fetch("https://www.forexfactory.com/calendar?week=" + wp, { headers: UA });
      const html = await r.text();
      const days = extractDays(html);
      let n = 0;
      for (const d of days) for (const e of (d.events || [])) if (e && e.name) { e._dd = d.dateline; rawEvents.push(e); n++; }
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
  const events = [...map.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
  const withActual = events.filter((e) => e.actual).length;
  console.log("=== VÝSLEDEK ===  událostí:", events.length, "· s actual:", withActual);
  console.log("ukázka s actual:", JSON.stringify(events.find((e) => e.actual) || {}));

  if (events.length < 20) { console.error("Příliš málo událostí — nepřepisuju."); process.exit(1); }
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/calendar.json", JSON.stringify({ updated: new Date().toISOString(), source: "forexfactory-web", count: events.length, withActual, events }));
  console.log("Zapsáno data/calendar.json");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

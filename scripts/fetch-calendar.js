// Ekonomický kalendář — běží v GitHub Action (server, ne prohlížeč).
// Scrapuje web ForexFactory (server na něj dosáhne bez Cloudflare blocku),
// vytáhne vložený JSON `calendarComponentStates` → má actual + forecast +
// previous + plné pokrytí + budoucí týdny. Zapíše data/calendar.json,
// které appka načte ze své domény (rychle, spolehlivě, bez proxy).
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

// Z HTML vytáhne všechny JSON bloky `calendarComponentStates[N] = {...}` (balancuje závorky, ignoruje stringy).
function extractStates(html) {
  const out = [];
  const marker = "calendarComponentStates[";
  let i = 0;
  while ((i = html.indexOf(marker, i)) !== -1) {
    const eq = html.indexOf("=", i);
    const start = html.indexOf("{", eq);
    if (start === -1) { i += marker.length; continue; }
    let depth = 0, inStr = false, strCh = "", esc = false, end = -1;
    for (let k = start; k < html.length; k++) {
      const c = html[k];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === strCh) inStr = false;
      } else if (c === '"' || c === "'") { inStr = true; strCh = c; }
      else if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = k; break; } }
    }
    if (end !== -1) { try { out.push(JSON.parse(html.slice(start, end + 1))); } catch (e) {} }
    i = end !== -1 ? end + 1 : i + marker.length;
  }
  return out;
}

function impactOf(e) {
  const s = ((e.impactClass || "") + " " + (e.impactName || e.impactTitle || "")).toLowerCase();
  if (/red|high/.test(s)) return "High";
  if (/ora|med/.test(s)) return "Medium";
  if (/yel|low/.test(s)) return "Low";
  return "";
}
function normEvent(e) {
  const dl = e.dateline != null ? (typeof e.dateline === "number" ? e.dateline : parseInt(e.dateline, 10)) : null;
  const iso = dl ? new Date(dl * 1000).toISOString() : "";
  const val = (x) => (x != null && String(x).trim() !== "" && String(x).trim() !== "&nbsp;" ? String(x).trim() : "");
  return {
    title: e.name || e.title || "",
    country: (e.currency || e.country || "").toUpperCase(),
    date: iso,
    impact: impactOf(e),
    actual: val(e.actual),
    forecast: val(e.forecast),
    previous: val(e.previous),
  };
}
function collectEvents(states) {
  const out = [];
  for (const st of states) {
    const days = st.days || [];
    for (const d of days) {
      const evs = d.events || d.eventsList || [];
      for (const e of evs) if (e && (e.name || e.title)) out.push(e);
    }
  }
  return out;
}

(async () => {
  const now = new Date();
  const offsets = [-7, 0, 7, 14]; // minulý týden (actual) + 14 dní dopředu
  let raw = [];
  for (const off of offsets) {
    const wp = weekParam(new Date(now.getTime() + off * 86400000));
    const url = "https://www.forexfactory.com/calendar?week=" + wp;
    try {
      const r = await fetch(url, { headers: UA });
      const html = await r.text();
      const states = extractStates(html);
      const evs = collectEvents(states);
      console.log(`FF ${wp}: status=${r.status} len=${html.length} bloků=${states.length} událostí=${evs.length}`);
      raw = raw.concat(evs);
    } catch (e) {
      console.log(`FF ${wp}: ERR ${e.message}`);
    }
    await sleep(1500);
  }

  // normalizace + dedupe podle title|country|date (preferuj s actual)
  const map = new Map();
  for (const e of raw) {
    const n = normEvent(e);
    if (!n.title || !n.date) continue;
    const k = n.title + "|" + n.country + "|" + n.date;
    const p = map.get(k);
    if (!p || (!p.actual && n.actual)) map.set(k, n);
  }
  const events = [...map.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
  const withActual = events.filter((e) => e.actual).length;

  console.log("=== VÝSLEDEK ===");
  console.log("Událostí:", events.length, "· s actual:", withActual);
  console.log("Vzorek s actual:", JSON.stringify(events.find((e) => e.actual) || {}));
  console.log("Vzorek budoucí :", JSON.stringify(events.find((e) => !e.actual && new Date(e.date) > now) || {}));

  if (events.length < 20) { console.error("Příliš málo událostí — scrape nejspíš selhal, nepřepisuju."); process.exit(1); }

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/calendar.json", JSON.stringify({
    updated: new Date().toISOString(), source: "forexfactory-web", count: events.length, withActual, events,
  }));
  console.log("Zapsáno data/calendar.json");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

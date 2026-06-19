// Ekonomický kalendář — běží v GitHub Action (na serveru, ne v prohlížeči).
// Stáhne feed spolehlivě (správné hlavičky, bez CORS/proxy), uloží data/calendar.json.
// Diagnostika v logu ukáže, jestli zdroj posílá i `actual`.
const fs = require("fs");

const FEEDS = ["lastweek", "thisweek", "nextweek"].map(
  (w) => `https://nfs.faireconomy.media/ff_calendar_${w}.json`
);
const UA = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  Accept: "application/json,text/plain,*/*",
};

async function getJSON(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

(async () => {
  let all = [];
  for (const url of FEEDS) {
    try {
      const arr = await getJSON(url);
      console.log("OK  ", url, Array.isArray(arr) ? arr.length + " událostí" : "(není pole)");
      if (Array.isArray(arr)) all = all.concat(arr);
    } catch (e) {
      console.log("FAIL", url, e.message);
    }
  }

  // dedupe podle title|country|date, preferuj záznam s actual
  const map = new Map();
  for (const e of all) {
    const k = (e.title || "") + "|" + (e.country || "") + "|" + (e.date || "");
    const p = map.get(k);
    const hasA = e.actual != null && String(e.actual).trim() !== "";
    const pHasA = p && p.actual != null && String(p.actual).trim() !== "";
    if (!p || (!pHasA && hasA)) map.set(k, e);
  }
  const events = [...map.values()];
  const withActual = events.filter(
    (e) => e.actual != null && String(e.actual).trim() !== ""
  ).length;

  console.log("=== DIAGNOSTIKA ===");
  console.log("Událostí celkem:", events.length, "· s actual:", withActual);
  console.log("Pole vzorku   :", Object.keys(events[0] || {}).join(", "));
  console.log("Vzorek budoucí:", JSON.stringify(events.find((e) => !(e.actual && String(e.actual).trim())) || {}));
  console.log("Vzorek actual :", JSON.stringify(events.find((e) => e.actual && String(e.actual).trim()) || {}));

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(
    "data/calendar.json",
    JSON.stringify({
      updated: new Date().toISOString(),
      source: "faireconomy",
      count: events.length,
      withActual,
      events,
    })
  );
  console.log("Zapsáno data/calendar.json");
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});

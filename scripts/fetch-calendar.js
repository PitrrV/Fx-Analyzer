// Ekonomický kalendář — běží v GitHub Action (server, ne prohlížeč).
// DIAGNOSTIKA ZDROJŮ: zjistí, který zdroj má actual + budoucí týdny a je
// ze serveru dosažitelný (Cloudflare). Podle výsledku pak postavíme primární zdroj.
const fs = require("fs");
const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

async function tryFetch(label, url, headers) {
  try {
    const r = await fetch(url, { headers: { ...UA, ...(headers || {}) } });
    const body = await r.text();
    return { label, url, status: r.status, len: body.length, body };
  } catch (e) {
    return { label, url, status: "ERR", err: e.message, body: "" };
  }
}

(async () => {
  // ── 1) faireconomy thisweek (základ, forecast/previous) ──
  let events = [];
  const fe = await tryFetch("faireconomy", "https://nfs.faireconomy.media/ff_calendar_thisweek.json");
  console.log("faireconomy:", fe.status, fe.len + "B");
  try { events = JSON.parse(fe.body); } catch (e) {}

  // ── 2) ForexFactory web HTML (má actual + budoucí týdny; test Cloudflare) ──
  for (const wk of ["this", "next"]) {
    const url = "https://www.forexfactory.com/calendar?week=" + wk;
    const ff = await tryFetch("FF-" + wk, url);
    const hasJSON = /calendarComponentStates/.test(ff.body || "");
    const hasRows = /calendar__row|calendar__cell/.test(ff.body || "");
    const cf = /cf-browser-verification|Just a moment|cloudflare|Attention Required/i.test(ff.body || "");
    console.log(`FF web (${wk}): status=${ff.status} len=${ff.len||0} embeddedJSON=${hasJSON} rows=${hasRows} cloudflareBlock=${cf}`);
  }

  // ── 3) Trading Economics guest API (má actual; test) ──
  const te = await tryFetch("TE-guest", "https://api.tradingeconomics.com/calendar?c=guest:guest&f=json&d1=2026-06-19&d2=2026-07-03");
  let teCount = 0, teActual = 0;
  try { const a = JSON.parse(te.body); if (Array.isArray(a)) { teCount = a.length; teActual = a.filter(x => x.Actual != null && String(x.Actual).trim() !== "").length; console.log("TE sample:", JSON.stringify(a[0] || {}).slice(0, 300)); } }
  catch (e) {}
  console.log(`TradingEconomics guest: status=${te.status} len=${te.len||0} events=${teCount} withActual=${teActual}`);

  // zatím ukládáme aspoň faireconomy thisweek, ať appka má fallback data
  const withActual = (Array.isArray(events) ? events : []).filter(e => e.actual != null && String(e.actual).trim() !== "").length;
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/calendar.json", JSON.stringify({
    updated: new Date().toISOString(), source: "faireconomy-thisweek",
    count: Array.isArray(events) ? events.length : 0, withActual, events: Array.isArray(events) ? events : [],
  }));
  console.log("Zapsáno data/calendar.json (zatím faireconomy thisweek)");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

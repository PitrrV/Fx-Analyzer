// DIAGNOSTIKA struktury — vypíše, jak FF vkládá kalendářová data, ať napíšu parser přesně.
const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Accept: "text/html,application/xhtml+xml",
};
(async () => {
  const r = await fetch("https://www.forexfactory.com/calendar?week=jun19.2026", { headers: UA });
  const html = await r.text();
  console.log("status", r.status, "len", html.length);
  for (const m of ["calendarComponentStates", "window.calendar", '"events"', "calendar__row", '"actual"', '"dateline"']) {
    const i = html.indexOf(m);
    console.log(`\n--- "${m}" @${i} ---`);
    if (i >= 0) console.log(JSON.stringify(html.slice(i, i + 220)));
  }
  // require('fs') jen aby krok prošel
  require("fs").mkdirSync("data", { recursive: true });
  // nepřepisujeme calendar.json (diagnostika)
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

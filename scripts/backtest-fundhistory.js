// Fund-history kalibrace — jaká DÉLKA nahromaděné kalendářní historie (v týdnech)
// dává nejpřesnější/nejprofitabilnější fundamentální skóre měny?
//
// Motivace: dvě zařízení s různě dlouhou lokální historií (v5_ff_hist) ukazují
// pro stejný pár jiný bias (EURCAD BUY vs SELL). Tenhle skript walk-forwardem
// projde každý obchodní den, spočítá fundamentální skóre měny PŘESNĚ podle
// engine.js (getWeight × relevance × surprise × recency, normalizace ±10), ale
// pokaždé jen z eventů v okně posledních N týdnů — a změří, jak dobře znaménko
// skóre predikuje pohyb měny v dalších 1/3/5 dnech.
//
// Metodika kurzů shodná se scripts/backtest-impact.js a backtest-cot.js
// (Frankfurter/ECB denní kurzy, USD-koš návratnost měny).
//
// Strop dat: git historie data/calendar.json zatím sahá jen ~7-8 týdnů zpět.
// Delší okna (13/26/52/65 týdnů) jsou v gridu schválně už teď — dokud na ně
// není dost historie, jejich effWeeks ukáže, kolik týdnů reálně pokryly
// (= splynou s maximem dostupné historie). Jak crony přirozeně přidávají
// commity, stačí workflow spustit znovu a delší okna se začnou lišit —
// skript se nemusí přepisovat.
//
// Nic v enginu tímhle skriptem NEMĚNÍME — měřicí nástroj, výstup
// (data/calibration_fundhistory.json) appka zatím nečte.
const fs = require("fs");
const { execSync } = require("child_process");

// ── zkopírováno 1:1 z engine.js, ať skórování je identické s enginem ──
const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
const CUR = ["EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"]; // bez USD, pro Frankfurter dotaz
const CURRENCY_COUNTRIES = { USD: ["US"], EUR: ["EU", "DE", "FR", "IT", "ES"], GBP: ["GB"], JPY: ["JP"], AUD: ["AU"], CAD: ["CA"], CHF: ["CH"], NZD: ["NZ"] };
const INDIRECT_COUNTRIES = { AUD: ["CN"], NZD: ["CN"], CAD: ["US"], CHF: ["EU", "DE", "FR", "IT", "ES", "US"] };
const FF_CCY_COUNTRY = { USD: "US", EUR: "EU", GBP: "GB", JPY: "JP", AUD: "AU", CAD: "CA", CHF: "CH", NZD: "NZ", CNY: "CN" };
const EVENT_RULES = [
  { cat: "Interest Rates", keys: ["interest rate", "rate decision", "rate statement", "funds rate", "policy rate", "bank rate", "deposit facility rate", "refinancing rate", "cash rate", "overnight rate", "main refinancing"], w: 3.0, dir: 1 },
  { cat: "Inflation", keys: ["cpi", "consumer price index", "inflation rate", "core inflation", "hicp", "pce", "personal consumption", "ppi", "producer price"], w: 2.5, dir: 1 },
  { cat: "Labor -Unemployment", keys: ["unemployment rate", "unemployment claims", "unemployment change", "jobless claims", "initial claims", "continuing claims", "claimant count"], w: 2.0, dir: -1 },
  { cat: "Labor +Jobs", keys: ["non-farm", "nonfarm", "payroll", "employment change", "employment", "adp", "average hourly earnings", "wage", "earnings"], w: 2.0, dir: 1 },
  { cat: "GDP", keys: ["gdp", "gross domestic product"], w: 2.2, dir: 1 },
  { cat: "PMI", keys: ["manufacturing pmi", "services pmi", "service pmi", "composite pmi", "pmi", "purchasing managers", "ism manufacturing", "ism services"], w: 1.8, dir: "pmi" },
  { cat: "Retail Sales", keys: ["retail sales"], w: 1.7, dir: 1 },
  { cat: "External Balance", keys: ["trade balance", "current account"], w: 1.0, dir: 1 },
  { cat: "Confidence", keys: ["consumer confidence", "business confidence", "sentiment", "zew", "ifo"], w: 1.0, dir: 1 },
];
function getEventMeta(name = "") { const n = name.toLowerCase(); for (const r of EVENT_RULES) if (r.keys.some((k) => n.includes(k))) return r; return null; }
function eventDirection(ev) {
  const meta = getEventMeta(ev.event); if (!meta) return 0;
  const a = parseFloat(ev.actual), e = parseFloat(ev.estimate), prev = parseFloat(ev.prev || ev.previous);
  if (isNaN(a) || isNaN(e)) return 0;
  let dir = 0;
  if (meta.dir === "pmi") {
    dir = a > e ? 1 : a < e ? -1 : 0;
    if (a >= 50 && e < 50) dir = 1;
    if (a < 50 && e >= 50) dir = -1;
    if (dir === 0 && !isNaN(prev)) dir = a > prev ? 1 : a < prev ? -1 : 0;
    return dir;
  }
  dir = a > e ? 1 : a < e ? -1 : 0;
  if (meta.dir === -1) dir *= -1;
  return dir;
}
function surpriseStrength(ev) {
  const a = parseFloat(ev.actual), e = parseFloat(ev.estimate);
  if (isNaN(a) || isNaN(e)) return 1;
  const denom = Math.max(Math.abs(e), 1);
  const pct = Math.min(0.6, Math.abs(a - e) / denom * 8);
  return 1 + pct;
}
function eventRelevance(currency, ev) {
  const country = (ev.country || "").toUpperCase();
  if ((CURRENCY_COUNTRIES[currency] || []).some((c) => country.includes(c))) return { type: "direct", factor: 1 };
  if ((INDIRECT_COUNTRIES[currency] || []).some((c) => country.includes(c))) return { type: "indirect", factor: 0.45 };
  return null;
}
// recency() z engine.js, ale relativně k datu vyhodnocení (backtest nesmí použít Date.now())
function recencyAt(evMs, asOfMs) {
  const d = (asOfMs - evMs) / 86400000;
  return d <= 90 ? 1.8 : d <= 180 ? 1.4 : d <= 365 ? 1.0 : 0.7;
}
function mapCalendarEvent(e) {
  const ccy = String(e.country || e.currency || "").toUpperCase();
  return {
    event: e.title || e.event || "", country: FF_CCY_COUNTRY[ccy] || ccy, time: e.date || e.time || "",
    actual: e.actual != null && e.actual !== "" ? String(e.actual).trim() : "",
    estimate: e.forecast != null && e.forecast !== "" ? String(e.forecast).trim() : "",
    prev: e.previous != null && e.previous !== "" ? String(e.previous).trim() : "",
  };
}
// ── konec kopie z engine.js ──

const HISTORY_DAYS = 600; // strop git walku — poroste-li repo léta, pořád pokryje 65týdenní okno + rozjezd
function reconstructCalendarHistory() {
  const since = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString().slice(0, 10);
  const shas = execSync(`git log --since="${since}" --format=%H -- data/calendar.json`, { maxBuffer: 10 * 1024 * 1024 })
    .toString().trim().split("\n").filter(Boolean);
  console.log(`Git historie data/calendar.json od ${since}: ${shas.length} commitů.`);
  const map = new Map();
  let ok = 0;
  for (const sha of shas) {
    try {
      const raw = execSync(`git show ${sha}:data/calendar.json`, { maxBuffer: 50 * 1024 * 1024 }).toString();
      const j = JSON.parse(raw);
      for (const e of j.events || []) {
        if (!e.title || !e.date) continue;
        const k = e.title + "|" + e.country + "|" + e.date;
        const prev = map.get(k);
        if (!prev || (!prev.actual && e.actual)) map.set(k, e);
      }
      ok++;
    } catch (err) { /* commit bez souboru / poškozený JSON — přeskoč */ }
  }
  console.log(`Načteno ${ok}/${shas.length} snapshotů, ${map.size} unikátních eventů.`);
  return [...map.values()];
}

async function fetchHistoricalRates(startDate, endDate) {
  const url = `https://api.frankfurter.app/${startDate}..${endDate}?from=USD&to=${CUR.join(",")}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("Frankfurter HTTP " + r.status);
  const j = await r.json();
  if (!j || !j.rates) throw new Error("Frankfurter: prázdná odpověď");
  return j.rates;
}
function buildSeries(ratesByDate) {
  const series = {}; CUR.forEach((c) => (series[c] = []));
  for (const d of Object.keys(ratesByDate).sort()) {
    const row = ratesByDate[d];
    CUR.forEach((c) => { if (row[c] != null) series[c].push({ date: d, v: row[c] }); });
  }
  return series;
}
function valueOnOrAfter(s, targetMs) {
  let lo = 0, hi = s.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; const t = Date.parse(s[mid].date + "T00:00:00Z"); if (t >= targetMs) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
  return ans < 0 ? null : s[ans].v;
}
// Návratnost MĚNY mezi dvěma okamžiky na bázi USD-koše (kladně = měna posílila).
function ccyReturnPct(series, ccy, t0, t1) {
  if (ccy === "USD") {
    const rets = CUR.map((c) => { const v0 = valueOnOrAfter(series[c] || [], t0), v1 = valueOnOrAfter(series[c] || [], t1); return v0 && v1 ? (v1 / v0 - 1) * 100 : null; }).filter((x) => x != null);
    return rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null;
  }
  const v0 = valueOnOrAfter(series[ccy] || [], t0), v1 = valueOnOrAfter(series[ccy] || [], t1);
  if (v0 == null || v1 == null) return null;
  return -((v1 / v0 - 1) * 100); // rate = ccy za 1 USD; pokles rate = ccy silnější
}
function aggregate(trades) {
  const n = trades.length; if (!n) return { n: 0, wr: null, pf: null, avg: null };
  const wins = trades.filter((t) => t.ret > 0).length;
  const gp = trades.filter((t) => t.ret > 0).reduce((a, b) => a + b.ret, 0);
  const gl = Math.abs(trades.filter((t) => t.ret < 0).reduce((a, b) => a + b.ret, 0));
  return { n, wr: +(wins / n * 100).toFixed(1), pf: gl > 0 ? +(gp / gl).toFixed(3) : gp > 0 ? Infinity : null, avg: +(trades.reduce((a, b) => a + b.ret, 0) / n).toFixed(4) };
}

// Fundamentální skóre měny k danému dni, jen z eventů posledních `windowMs`.
// Přesná replika fundScoreRaw z engine.js/scoreCurrency (bez yield/policy —
// ty z kalendáře nejdou a na délce historie nezávisí).
function fundScoreAt(currency, events, asOfMs, windowMs) {
  let score = 0, weight = 0, count = 0;
  for (const ev of events) {
    if (ev.t > asOfMs || ev.t < asOfMs - windowMs) continue;
    const rel = eventRelevance(currency, ev); if (!rel) continue;
    const meta = getEventMeta(ev.event); if (!meta) continue;
    const a = parseFloat(ev.actual), e2 = parseFloat(ev.estimate);
    if (isNaN(a) || isNaN(e2)) continue;
    const dir = eventDirection(ev); if (!dir) continue;
    const w = meta.w * rel.factor * surpriseStrength(ev), r = recencyAt(ev.t, asOfMs);
    score += dir * w * r; weight += w * r; count++;
  }
  return { score: weight > 0 ? Math.max(-10, Math.min(10, (score / weight) * 10)) : 0, count };
}

const WINDOWS_WEEKS = [1, 2, 3, 4, 6, 8, 13, 26, 52, 65]; // 65 ≈ FF_CONF_MONTHS (15 měsíců)
const HORIZONS = [1, 3, 5]; // kalendářní dny (denní close-to-close)
const WK = 7 * 86400000;

(async () => {
  const rawEvents = reconstructCalendarHistory();
  const events = rawEvents.map(mapCalendarEvent)
    .map((e) => ({ ...e, t: Date.parse(e.time) }))
    .filter((e) => !isNaN(e.t) && e.actual !== "" && e.estimate !== "");
  if (events.length < 50) throw new Error("Málo eventů s actual+forecast: " + events.length);
  events.sort((a, b) => a.t - b.t);
  const firstEvMs = events[0].t, nowMs = Date.now();
  const maxAvailableWeeks = +((nowMs - firstEvMs) / WK).toFixed(1);
  console.log(`Eventy s actual+forecast: ${events.length}, od ${events[0].time} → dostupná historie ~${maxAvailableWeeks} týdnů.`);

  const dateFrom = new Date(firstEvMs).toISOString().slice(0, 10);
  const dateTo = new Date().toISOString().slice(0, 10);
  console.log(`Stahuji kurzy ${dateFrom} → ${dateTo}…`);
  const ratesByDate = await fetchHistoricalRates(dateFrom, dateTo);
  const series = buildSeries(ratesByDate);
  const tradingDays = Object.keys(ratesByDate).sort();
  console.log("Kurzy:", tradingDays.length, "obchodních dní.");

  // Vyhodnocovací dny: každý obchodní den od (první event + 1 týden), aby i
  // nejkratší okno mělo co skórovat. Vyhodnocení k 23:59 UTC dne — všechny
  // eventy toho dne už jsou venku, obchod se otevírá dalším dostupným kurzem.
  const evalDays = tradingDays
    .map((d) => Date.parse(d + "T23:59:00Z"))
    .filter((t) => t >= firstEvMs + WK && t <= nowMs);
  console.log("Vyhodnocovacích dní:", evalDays.length);

  const grid = [];
  for (const W of WINDOWS_WEEKS) {
    const windowMs = W * WK;
    for (const H of HORIZONS) {
      const all = [], strong = [], spread = [];
      let effSum = 0, effN = 0;
      for (const asOf of evalDays) {
        const scores = {};
        for (const cur of CURRENCIES) scores[cur] = fundScoreAt(cur, events, asOf, windowMs);
        effSum += Math.min(W, (asOf - firstEvMs) / WK); effN++;
        // signál po měně: znaménko fund skóre → směr, výnos měny × směr
        for (const cur of CURRENCIES) {
          const s = scores[cur].score;
          if (Math.abs(s) < 0.5) continue; // šum kolem nuly neobchodujeme
          const ret = ccyReturnPct(series, cur, asOf, asOf + H * 86400000);
          if (ret == null) continue;
          const signed = ret * Math.sign(s);
          all.push({ ret: signed });
          if (Math.abs(s) >= 3) strong.push({ ret: signed });
        }
        // spread: long nejsilnější / short nejslabší měna (≈ obchod páru dle žebříčku)
        const ranked = CURRENCIES.filter((c) => scores[c].count > 0).sort((a, b) => scores[b].score - scores[a].score);
        if (ranked.length >= 2 && scores[ranked[0]].score > scores[ranked[ranked.length - 1]].score) {
          const top = ranked[0], bot = ranked[ranked.length - 1];
          const rT = ccyReturnPct(series, top, asOf, asOf + H * 86400000);
          const rB = ccyReturnPct(series, bot, asOf, asOf + H * 86400000);
          if (rT != null && rB != null) spread.push({ ret: rT - rB });
        }
      }
      const fix = (a) => ({ n: a.n, wr: a.wr, pf: a.pf === Infinity ? null : a.pf, avg: a.avg });
      grid.push({
        windowWeeks: W, horizon: H, effWeeksAvg: effN ? +(effSum / effN).toFixed(1) : null,
        all: fix(aggregate(all)), strong: fix(aggregate(strong)), spread: fix(aggregate(spread)),
      });
    }
    const g = grid[grid.length - 1];
    console.log(`Okno ${W}t (eff ~${g.effWeeksAvg}t) · h5: all n=${g.all.n} wr=${g.all.wr} pf=${g.all.pf} · spread n=${g.spread.n} wr=${g.spread.wr} pf=${g.spread.pf}`);
  }

  const summary = `Fund-history kalibrace ${dateFrom} → ${dateTo}: ${events.length} eventů, ` +
    `${evalDays.length} vyhodnocovacích dní, dostupná historie ~${maxAvailableWeeks} týdnů — ` +
    `okna delší než to zatím splývají s maximem (viz effWeeksAvg). ` +
    `all = každá měna s |fund|≥0.5; strong = |fund|≥3; spread = long nejsilnější / short nejslabší měna.`;
  console.log(summary);

  const out = {
    updated: new Date().toISOString(),
    source: "Frankfurter (ECB) denní kurzy × git historie data/calendar.json (ForexFactory)",
    dateFrom, dateTo, eventsUsed: events.length, evalDays: evalDays.length, maxAvailableWeeks,
    windowsWeeks: WINDOWS_WEEKS, horizons: HORIZONS, grid, summary,
  };

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync("data/calibration_fundhistory.json", "utf8")); } catch (e) {}
  const same = prev && JSON.stringify(prev.grid) === JSON.stringify(out.grid);
  if (same) { console.log("Kalibrace beze změny, nepřepisuji."); process.exit(0); }

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/calibration_fundhistory.json", JSON.stringify(out));
  console.log("OK · zapsáno data/calibration_fundhistory.json");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

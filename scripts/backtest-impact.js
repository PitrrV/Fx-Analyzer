// Impact-tier kalibrace — má FF impact tag (High/Medium/Low) reálnou predikční
// hodnotu navíc k tomu, co engine dnes počítá jen z kategorie (EVENT_RULES váha)?
// Stejná metodika jako scripts/backtest-cot.js (Frankfurter denní kurzy, stejná
// _pxFrom konvence), jen na úrovni jednotlivých eventů místo týdenních COT skóre.
//
// data/calendar.json je rolling okno (cron ho při každém běhu přepíše), takže
// širší historii rekonstruujeme z git historie commitů tohoto souboru — stejný
// merge jako v scripts/fetch-calendar.js (dedup dle title|country|date, novější
// "actual" vyhrává nad prázdným).
//
// Nic v enginu tímhle skriptem NEMĚNÍME — je to měřicí nástroj, výstup
// (data/calibration_impact.json) appka zatím nečte, žádná UI vazba.
const fs = require("fs");
const { execSync } = require("child_process");

// ── zkopírováno 1:1 z engine.js, ať klasifikace eventu je identická s enginem ──
const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
const CUR = ["EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"]; // bez USD, pro Frankfurter dotaz
const CURRENCY_COUNTRIES = { USD: ["US"], EUR: ["EU", "DE", "FR", "IT", "ES"], GBP: ["GB"], JPY: ["JP"], AUD: ["AU"], CAD: ["CA"], CHF: ["CH"], NZD: ["NZ"] };
const INDIRECT_COUNTRIES = { AUD: ["CN"], NZD: ["CN"], CAD: ["US"], CHF: ["EU", "DE", "FR", "IT", "ES", "US"] };
const FF_CCY_COUNTRY = { USD: "US", EUR: "EU", GBP: "GB", JPY: "JP", AUD: "AU", CAD: "CA", CHF: "CH", NZD: "NZ", CNY: "CN" };
const EVENT_RULES = [
  { cat: "Interest Rates", keys: ["interest rate", "rate decision", "rate statement", "funds rate", "policy rate", "bank rate", "deposit facility rate", "refinancing rate", "cash rate", "overnight rate", "main refinancing"], dir: 1 },
  { cat: "Inflation", keys: ["cpi", "consumer price index", "inflation rate", "core inflation", "hicp", "pce", "personal consumption", "ppi", "producer price"], dir: 1 },
  { cat: "Labor -Unemployment", keys: ["unemployment rate", "unemployment claims", "unemployment change", "jobless claims", "initial claims", "continuing claims", "claimant count"], dir: -1 },
  { cat: "Labor +Jobs", keys: ["non-farm", "nonfarm", "payroll", "employment change", "employment", "adp", "average hourly earnings", "wage", "earnings"], dir: 1 },
  { cat: "GDP", keys: ["gdp", "gross domestic product"], dir: 1 },
  { cat: "PMI", keys: ["manufacturing pmi", "services pmi", "service pmi", "composite pmi", "pmi", "purchasing managers", "ism manufacturing", "ism services"], dir: "pmi" },
  { cat: "Retail Sales", keys: ["retail sales"], dir: 1 },
  { cat: "External Balance", keys: ["trade balance", "current account"], dir: 1 },
  { cat: "Confidence", keys: ["consumer confidence", "business confidence", "sentiment", "zew", "ifo"], dir: 1 },
];
function getEventMeta(name = "") { const n = name.toLowerCase(); for (const r of EVENT_RULES) if (r.keys.some((k) => n.includes(k))) return r; return null; }
function eventDirection(ev) {
  const meta = getEventMeta(ev.event); if (!meta) return 0;
  const a = parseFloat(ev.actual), e = parseFloat(ev.estimate);
  if (isNaN(a) || isNaN(e)) return 0;
  if (meta.dir === "pmi") { let dir = a > e ? 1 : a < e ? -1 : 0; if (a >= 50 && e < 50) dir = 1; if (a < 50 && e >= 50) dir = -1; return dir; }
  let dir = a > e ? 1 : a < e ? -1 : 0; if (meta.dir === -1) dir *= -1; return dir;
}
function eventRelevance(currency, ev) {
  const country = (ev.country || "").toUpperCase();
  if ((CURRENCY_COUNTRIES[currency] || []).some((c) => country.includes(c))) return { type: "direct" };
  if ((INDIRECT_COUNTRIES[currency] || []).some((c) => country.includes(c))) return { type: "indirect" };
  return null;
}
function mapCalendarEvent(e) {
  const ccy = String(e.country || e.currency || "").toUpperCase();
  return {
    event: e.title || e.event || "", country: FF_CCY_COUNTRY[ccy] || ccy, time: e.date || e.time || "",
    impact: String(e.impact || "").toLowerCase(),
    actual: e.actual != null && e.actual !== "" ? String(e.actual).trim() : "",
    estimate: e.forecast != null && e.forecast !== "" ? String(e.forecast).trim() : "",
  };
}
// ── konec kopie z engine.js ──

// Bezpečný strop, ať skript časem (roky hodinových commitů) nezpomaluje donekonečna.
const HISTORY_DAYS = 150;
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
    } catch (err) { /* commit bez souboru na téhle cestě / poškozený JSON — přeskoč */ }
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
    return rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null; // + = USD koš silnější
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

const HORIZONS = [1, 3, 5]; // kalendářní dny po releasu (denní close-to-close, žádná intraday data)

(async () => {
  const rawEvents = reconstructCalendarHistory();
  const mapped = rawEvents.map(mapCalendarEvent);

  const scored = [];
  for (const ev of mapped) {
    const t = Date.parse(ev.time); if (isNaN(t) || t > Date.now()) continue; // jen minulé (musí mít čas na reakci)
    for (const cur of CURRENCIES) {
      const rel = eventRelevance(cur, ev); if (!rel || rel.type !== "direct") continue;
      const meta = getEventMeta(ev.event); if (!meta) continue;
      const dir = eventDirection(ev); if (!dir) continue;
      const impact = ["high", "medium", "low"].includes(ev.impact) ? ev.impact : "unknown";
      scored.push({ cur, event: ev.event, cat: meta.cat, impact, time: ev.time, dir, t });
    }
  }
  console.log("Eventů, které engine reálně skóruje (direct, dir!=0):", scored.length);
  if (scored.length < 30) throw new Error("Málo eventů pro smysluplný backtest: " + scored.length);

  const byImpactCount = {}; scored.forEach((s) => (byImpactCount[s.impact] = (byImpactCount[s.impact] || 0) + 1));
  const byCatCount = {}; scored.forEach((s) => (byCatCount[s.cat] = (byCatCount[s.cat] || 0) + 1));
  console.log("Rozpad impact:", byImpactCount, "· kategorie:", byCatCount);

  const dates = scored.map((s) => new Date(s.t).toISOString().slice(0, 10)).sort();
  const dateFrom = dates[0], dateTo = new Date().toISOString().slice(0, 10);
  console.log(`Stahuji kurzy ${dateFrom} → ${dateTo}…`);
  const ratesByDate = await fetchHistoricalRates(dateFrom, dateTo);
  const series = buildSeries(ratesByDate);
  console.log("Kurzy:", Object.keys(ratesByDate).length, "obchodních dní.");

  const grid = [];
  for (const H of HORIZONS) {
    const byImpact = { high: [], medium: [], low: [], unknown: [] };
    for (const s of scored) {
      const ret = ccyReturnPct(series, s.cur, s.t, s.t + H * 86400000);
      if (ret == null) continue;
      byImpact[s.impact].push({ ret: ret * s.dir });
    }
    for (const k of ["high", "medium", "low", "unknown"]) {
      const a = aggregate(byImpact[k]);
      grid.push({ horizon: H, impact: k, n: a.n, wr: a.wr, pf: a.pf === Infinity ? null : a.pf, avg: a.avg });
    }
  }

  // Kontrolní srovnání v RÁMCI JEDNÉ kategorie (PMI má nejvíc Low i High záznamů),
  // ať případný rozdíl není jen artefakt "Low = jiná kategorie eventů než High".
  const pmiCompare = {};
  for (const H of HORIZONS) {
    const buckets = { high: [], low: [] };
    for (const s of scored) {
      if (s.cat !== "PMI" || (s.impact !== "high" && s.impact !== "low")) continue;
      const ret = ccyReturnPct(series, s.cur, s.t, s.t + H * 86400000); if (ret == null) continue;
      buckets[s.impact].push({ ret: ret * s.dir });
    }
    pmiCompare[`h${H}`] = { high: aggregate(buckets.high), low: aggregate(buckets.low) };
  }

  const summary = `Impact kalibrace ${dateFrom} → ${dateTo}: ${scored.length} skórovaných eventů ` +
    `(High ${byImpactCount.high || 0} / Medium ${byImpactCount.medium || 0} / Low ${byImpactCount.low || 0} / bez tagu ${byImpactCount.unknown || 0}).`;
  console.log(summary);

  const out = {
    updated: new Date().toISOString(),
    source: "Frankfurter (ECB) denní kurzy × git historie data/calendar.json (ForexFactory)",
    dateFrom, dateTo, eventsScored: scored.length, byImpactCount, byCatCount,
    grid, pmiCompare, summary,
  };

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync("data/calibration_impact.json", "utf8")); } catch (e) {}
  const same = prev && JSON.stringify(prev.grid) === JSON.stringify(out.grid) && JSON.stringify(prev.pmiCompare) === JSON.stringify(out.pmiCompare);
  if (same) { console.log("Kalibrace beze změny, nepřepisuji."); process.exit(0); }

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/calibration_impact.json", JSON.stringify(out));
  console.log("OK · zapsáno data/calibration_impact.json");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

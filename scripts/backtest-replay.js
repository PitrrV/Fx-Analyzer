// HISTORICAL REPLAY celého enginu — v2 (hluboké okno z FF backfillu).
//
// Pro každý den X spočítá, co by SKUTEČNÝ engine.js ukázal ten den — výhradně
// z dat známých k X (žádný look-ahead). Skóruje NAČTENÝ engine.js (localStorage
// stub + Date shim), žádná kopie vzorců.
//
// Zdroje podle éry:
//  - kalendář: base = data/calendar_hist.json (FF backfill, eventy s date ≤ X;
//    inference "actual znám v čase eventu" — nese REVIZNÍ bias, viz validace
//    data/calendar_hist_validation.json); overlay = union živých git snapshotů
//    data/calendar.json commitnutých ≤ X (zlatý standard od 2026-06-19, kde
//    existuje, přepisuje backfill first-print hodnotami)
//  - COT: týdny z data/cot_hist.json s report_date W, kde X ≥ W+4 dny (páteční
//    publikace)
//  - retail: poslední bod data/retail_hist.json ≤ X; PŘED 2026-06-22 neexistuje
//    → sentiment neutrální 50 (sent_score=0) — PŘIZNANÁ díra, váha 0.11
//  - ropa: git snapshot data/oil.json ≤ X; před 2026-06-29 FRED DCOILWTICO
//    (denní WTI, vzorky ~4/8/13 týdnů zpět)
//  - risk_adj: auto z AUDJPY/NZDJPY momenta (Frankfurter kurzy ≤ X)
//  - CB sazby/CPI/policy: autoUpdateFromCalendar nad eventy ≤ X — z 2026-era
//    defaultů konverguje k dobovým hodnotám, jak přicházejí rate/CPI eventy →
//    prvních WARMUP_WEEKS týdnů okna se ze skórování ZAHAZUJE
//  - Date shim: engine vidí "teď" = X → recency, capEventsWindow i sezónnost
//    jsou point-in-time správně
// Vstup do obchodu: skóre dne X → cena až denní fix X+1. Split na chronologické
// poloviny post-warmup okna.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const CUR = ["EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
const HORIZONS = [1, 3, 5, 10];
const BANDS = [[0, 2, "slabý <2"], [2, 3, "sweetspot 2–3"], [3, 99, "silný 3+"]];
const WARMUP_WEEKS = 12; // konvergence CB sazeb/policy z defaultů na dobové hodnoty

function fileCommits(file) {
  return sh(`git log --format='%H %cI' -- ${file}`).trim().split("\n").filter(Boolean)
    .map((l) => { const [h, iso] = l.split(" "); return { h, ts: Date.parse(iso) }; });
}
function snapshotAt(commits, file, tsLimit) {
  const c = commits.find((x) => x.ts <= tsLimit);
  if (!c) return null;
  try { return JSON.parse(sh(`git show ${c.h}:${file}`)); } catch (e) { return null; }
}

// ── engine loader s Date shimem (point-in-time recency/sezónnost/okno) ──
const engineSrc = fs.readFileSync(path.join(ROOT, "engine.js"), "utf8");
const exportsList = [
  "CURRENCIES", "STANDARD_PAIRS", "FUND_HIST_WINDOW_WEEKS",
  "mapFFEvent", "capEventsWindow", "scoreCurrency",
  "getLatestCOTScores", "loadCOT", "loadSentiment",
  "autoUpdateFromCalendar", "applyAutoRiskSentiment",
].join(",");
const factory = new Function("window", "localStorage", "__prices", "Date",
  engineSrc + "\n;if(__prices){_PRICES=__prices;}\nreturn {" + exportsList + "};");
function makeStore(seed) {
  const store = { ...seed };
  return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
}
function makeReplayDate(nowMs) {
  const RealDate = Date;
  class ReplayDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); }
    static now() { return nowMs; }
  }
  ReplayDate.parse = RealDate.parse; ReplayDate.UTC = RealDate.UTC;
  return ReplayDate;
}

(async () => {
  // ── data známá dnes ──────────────────────────────────────────────────
  const cotAll = JSON.parse(fs.readFileSync(path.join(ROOT, "data/cot_hist.json"), "utf8")).weeks;
  const retailAll = JSON.parse(fs.readFileSync(path.join(ROOT, "data/retail_hist.json"), "utf8")).points;
  const histCal = JSON.parse(fs.readFileSync(path.join(ROOT, "data/calendar_hist.json"), "utf8"));
  const calCommits = fileCommits("data/calendar.json");
  const oilCommits = fileCommits("data/oil.json");
  const firstSnapshotTs = calCommits[calCommits.length - 1].ts;

  // okno: od začátku backfillu + warmup … včerejšek
  const histFromMs = Date.parse((histCal.from || "2024-03-04") + "T00:00:00Z");
  const startMs = histFromMs + WARMUP_WEEKS * 7 * 86400000;
  const endMs = Date.now() - 86400000;
  console.log("Backfill od", histCal.from, "| warmup", WARMUP_WEEKS, "týdnů | skórování od",
    new Date(startMs).toISOString().slice(0, 10), "→", new Date(endMs).toISOString().slice(0, 10));

  // ── FRED WTI (denní) pro ropu před érou oil.json snapshotů ───────────
  let fred = []; // [{d, v}] vzestupně
  try {
    const r = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILWTICO", { signal: AbortSignal.timeout(30000) });
    if (r.ok) {
      fred = (await r.text()).trim().split("\n").slice(1).map((l) => { const [d, v] = l.split(","); return { d, v: parseFloat(v) }; }).filter((x) => isFinite(x.v));
      console.log("FRED WTI:", fred.length, "denních hodnot,", fred[0].d, "→", fred.at(-1).d);
    }
  } catch (e) { console.log("FRED nedostupný — ropa před 2026-06-29 bude 0:", e.message); }
  const fredAt = (iso) => { for (let i = fred.length - 1; i >= 0; i--) if (fred[i].d <= iso) return fred[i].v; return null; };
  const oilFromFred = (dayIso) => {
    const c = fredAt(dayIso); if (c == null) return null;
    const back = (days) => fredAt(new Date(Date.parse(dayIso) - days * 86400000).toISOString().slice(0, 10));
    const w4 = back(28), w8 = back(56), w13 = back(91);
    if (w4 == null || w13 == null) return null;
    return { current: c, w4ago: w4, w8ago: w8 == null ? w4 : w8, w13ago: w13, date: dayIso };
  };

  // ── Frankfurter kurzy: celé okno + horizonty ─────────────────────────
  const pxFrom = new Date(histFromMs - 7 * 86400000).toISOString().slice(0, 10);
  const pxTo = new Date().toISOString().slice(0, 10);
  const r = await fetch(`https://api.frankfurter.app/${pxFrom}..${pxTo}?from=USD&to=${CUR.join(",")}`, { signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error("Frankfurter HTTP " + r.status);
  const ratesByDate = (await r.json()).rates;
  const pxDays = Object.keys(ratesByDate).sort();
  const pxHist = pxDays.map((d) => ({ d, rates: { USD: 1, ...ratesByDate[d] } }));
  const pairPrice = (p, i) => { const rr = pxHist[i].rates; const b = rr[p.base], q = rr[p.quote]; return (b && q) ? q / b : null; };
  const pxIdxOnOrAfter = (iso) => pxDays.findIndex((d) => d >= iso);
  console.log("Frankfurter:", pxDays.length, "obchodních dní");

  // ── příprava kalendáře: backfill (base) + inkrementální snapshot overlay ──
  const evKey = (e) => (e.title || "") + "|" + (e.country || "") + "|" + String(e.date || "").slice(0, 10);
  const histSorted = [...histCal.events].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const calAsc = [...calCommits].reverse();
  const overlay = new Map(); // z live snapshotů (zlatý standard) — přepisuje backfill
  let histPtr = 0, calPtr = 0;
  const baseMap = new Map();

  const days = [];
  for (let t = startMs; t <= endMs; t += 86400000) {
    const dayIso = new Date(t).toISOString().slice(0, 10);
    const dayEnd = t + 86400000 - 1;
    // base: backfill eventy s date ≤ konec dne X
    while (histPtr < histSorted.length && Date.parse(histSorted[histPtr].date) <= dayEnd) {
      const e = histSorted[histPtr]; const k = evKey(e); const prev = baseMap.get(k);
      if (!prev || (!prev.actual && e.actual)) baseMap.set(k, e);
      histPtr++;
    }
    // overlay: live snapshoty commitnuté ≤ konec dne X
    while (calPtr < calAsc.length && calAsc[calPtr].ts <= dayEnd) {
      let snap = null; try { snap = JSON.parse(sh(`git show ${calAsc[calPtr].h}:data/calendar.json`)); } catch (e) {}
      if (snap && Array.isArray(snap.events)) for (const e of snap.events) {
        const k = evKey(e); const prev = overlay.get(k);
        if (!prev || (!prev.actual && e.actual)) overlay.set(k, e);
      }
      calPtr++;
    }
    const mergedMap = new Map(baseMap);
    for (const [k, e] of overlay) mergedMap.set(k, e); // live vyhrává (first-print)
    const rawEvents = [...mergedMap.values()];
    // COT známé k X (publikace pátek = report+4d bezpečně)
    const cotKnown = {};
    for (const [w, v] of Object.entries(cotAll)) if (Date.parse(w + "T00:00:00Z") + 4 * 86400000 <= dayEnd) cotKnown[w] = { ...v, src: "server" };
    if (!Object.keys(cotKnown).length) continue;
    const srvPct = {}; Object.entries(cotKnown).forEach(([w, v]) => { if (v.scores) srvPct[w] = v.scores; });
    // retail k X (před 2026-06-22 nic → neutral)
    const rPts = retailAll.filter((p) => Date.parse(p.t) <= dayEnd);
    const sentData = rPts.length ? rPts[rPts.length - 1].ccy : null;
    // ropa k X
    let oilObj = snapshotAt(oilCommits, "data/oil.json", dayEnd);
    if (!oilObj || !oilObj.current) oilObj = oilFromFred(dayIso);
    // ceny ≤ X pro risk_adj
    const pxUpto = pxHist.filter((p) => p.d <= dayIso);
    const prices = pxUpto.length ? { updated: dayIso, rates: pxUpto[pxUpto.length - 1].rates, hist: pxUpto.slice(-10) } : null;
    // engine se stavem světa k X + Date shim
    const seed = { cot_hist: JSON.stringify(cotKnown), cot_pct_server: JSON.stringify(srvPct) };
    if (oilObj) seed["oil_wti_v1"] = JSON.stringify({ data: oilObj, ts: dayEnd });
    const E = factory({}, makeStore(seed), prices, makeReplayDate(dayEnd));
    const events = rawEvents.map(E.mapFFEvent);
    try { E.autoUpdateFromCalendar(events); } catch (e) {}
    try { E.applyAutoRiskSentiment(); } catch (e) {}
    const calScoring = E.capEventsWindow(events, E.FUND_HIST_WINDOW_WEEKS);
    const cotScores = E.getLatestCOTScores() || E.loadCOT();
    const sent = sentData || E.loadSentiment();
    const sc = {}, comp = {};
    for (const c of E.CURRENCIES) {
      const s = E.scoreCurrency(calScoring, c, cotScores, sent);
      sc[c] = s.score;
      comp[c] = Object.fromEntries((s.components || []).map((x) => [x.key, x.value])); // pro atribuci po komponentách
    }
    days.push({ d: dayIso, sc, comp, sentLive: !!sentData, oilSrc: oilObj ? (oilObj.date === dayIso ? "fred" : "snap") : "none" });
    if (days.length % 60 === 0) console.log("…", dayIso, "(", days.length, "dní )");
  }
  console.log("Rekonstruováno dní:", days.length);
  if (days.length < 40) throw new Error("Podezřele krátké okno — zkontroluj vstupy.");

  // ── vyhodnocení ──────────────────────────────────────────────────────
  const PAIRS = factory({}, makeStore({}), null, Date).STANDARD_PAIRS;
  const trades = [];
  for (const day of days) {
    const entryIdx = pxIdxOnOrAfter(new Date(Date.parse(day.d) + 86400000).toISOString().slice(0, 10));
    if (entryIdx < 0) continue;
    for (const p of PAIRS) {
      const diff = (day.sc[p.base] || 0) - (day.sc[p.quote] || 0);
      const p0 = pairPrice(p, entryIdx); if (p0 == null) continue;
      for (const H of HORIZONS) {
        if (entryIdx + H >= pxHist.length) continue;
        const p1 = pairPrice(p, entryIdx + H); if (p1 == null) continue;
        trades.push({ d: day.d, diff: +diff.toFixed(2), h: H, ret: (p1 / p0 - 1) * (diff > 0 ? 1 : -1) * 100 });
      }
    }
  }
  const agg = (list) => { const n = list.length; if (!n) return { n: 0 };
    const w = list.filter((t) => t.ret > 0).length, gp = list.filter((t) => t.ret > 0).reduce((a, b) => a + b.ret, 0), gl = Math.abs(list.filter((t) => t.ret < 0).reduce((a, b) => a + b.ret, 0));
    return { n, wr: +(w / n * 100).toFixed(1), pf: gl > 0 ? +(gp / gl).toFixed(3) : null, avg: +(list.reduce((a, b) => a + b.ret, 0) / n).toFixed(4) }; };
  const midDay = days[Math.floor(days.length / 2)].d;
  const grid = [];
  for (const [lo, hi, label] of BANDS) for (const H of HORIZONS) {
    const sel = trades.filter((t) => Math.abs(t.diff) >= lo && Math.abs(t.diff) < hi && t.h === H);
    const h1 = agg(sel.filter((t) => t.d < midDay)), h2 = agg(sel.filter((t) => t.d >= midDay));
    grid.push({ band: label, horizon: H, ...agg(sel), half1: h1, half2: h2,
      robust: h1.n >= 30 && h2.n >= 30 && h1.pf != null && h2.pf != null && h1.pf > 1 && h2.pf > 1 });
  }

  const sentLiveFrom = (days.find((d) => d.sentLive) || {}).d || null;
  const out = {
    updated: new Date().toISOString(),
    version: 2,
    source: "historical replay skutečného engine.js — FF backfill (base) + live git snapshoty (overlay) + Frankfurter + FRED WTI",
    window: { backfillFrom: histCal.from, warmupWeeks: WARMUP_WEEKS, from: days[0].d, to: days.at(-1).d, daysReconstructed: days.length, splitAt: midDay },
    entryRule: "skóre dne X (data ≤ X, Date shim = X) → vstup denní fix X+1 — bez look-ahead",
    limitations: [
      "kalendář před 2026-06-19 z FF backfillu: FINÁLNÍ (revidované) actualy, ne první otisk — míru revizí viz data/calendar_hist_validation.json",
      "retail sentiment existuje až od " + (sentLiveFrom || "2026-06-22") + " — před tím neutral 50 (sent_score=0, váha 0.11)",
      "ropa před 2026-06-29 z FRED DCOILWTICO (jiný zdroj než live stooq — drobné odchylky)",
      "CB sazby/CPI/policy konvergují z defaultů přes autoUpdateFromCalendar — warmup " + WARMUP_WEEKS + " týdnů zahozen",
      "28 párů sdílí 8 měn → obchody silně korelované, efektivní n je výrazně menší než uvedené n",
    ],
    grid,
    flags: { sentLiveFrom, days: days.length },
    // per-den skóre + KOMPONENTY (atribuce) a použitá cenová řada (Frankfurter) —
    // umožňuje navazující analýzy (atribuce, technické filtry) offline nad tímto
    // souborem, se stejnou point-in-time disciplínou, bez opakování replaye.
    dailyScores: days.map((d) => ({ d: d.d, sc: d.sc, comp: d.comp })),
    prices: { days: pxDays, rates: pxHist.map((p) => p.rates) },
  };
  fs.writeFileSync(path.join(ROOT, "data/calibration_replay.json"), JSON.stringify(out));
  console.log("Grid (full | h1 | h2):");
  for (const g of grid) console.log(` ${g.band} h${g.horizon}d: n=${g.n} WR=${g.wr}% PF=${g.pf} | h1 PF=${g.half1.pf} | h2 PF=${g.half2.pf} ${g.robust ? "✅ROBUST" : ""}`);
  console.log("OK · zapsáno data/calibration_replay.json");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

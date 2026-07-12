// HISTORICAL REPLAY celého enginu — point-in-time rekonstrukce skóre.
//
// Pro každý den X v minulosti spočítá, co by SKUTEČNÝ engine.js ukázal, kdyby
// běžel ten den — výhradně z dat známých k X (žádný look-ahead):
//  - kalendář: UNION git snapshotů data/calendar.json commitnutých ≤ X
//    (přesně napodobuje mergeFFHistory akumulaci v appce)
//  - COT: týdny z data/cot_hist.json s report_date W, kde X ≥ W+4 dny
//    (report k úterku vychází v pátek — sobota = bezpečně známé)
//  - retail: poslední bod data/retail_hist.json s časem ≤ X
//  - ropa: git snapshot data/oil.json ≤ X (před 2026-06-29 neexistuje → oil=0)
//  - risk_adj: auto-detekce z AUDJPY/NZDJPY momenta (Frankfurter kurzy ≤ X)
//  - CB sazby/CPI/policy: autoUpdateFromCalendar nad eventy ≤ X
// Skóruje se NAČTENÝM skutečným engine.js (localStorage stub) — žádná kopie
// vzorců, výsledky = přesně živý engine k danému dni.
//
// PŘIZNANÁ OMEZENÍ (viz data/calibration_replay.json .limitations):
//  - hloubka: kalendářní snapshoty existují až od 2026-06-19 → okno ~3 týdny;
//    poroste samo, jak crony přidávají historii (spouštět opakovaně)
//  - výchozí CENTRAL_BANK_RATES/REAL_CPI v engine.js jsou hodnoty ověřené
//    2026-06 — pro toto okno správná éra; pro delší okna by byla potřeba
//    externí historie sazeb
//  - recency() a sezónnost běží vůči skutečnému "dnes" — v ≤90denním okně
//    je recency konstantní (1.8) a sezónnost váží 0.02 → dopad zanedbatelný
//  - malé n: 3 týdny je PILOT pipeline, ne validace edge — čísla jsou
//    orientační, ne důkaz
// Vstup do obchodu: skóre dne X (snapshot ~21:30 UTC) → cena až fix X+1
// (~16:00 SEČ) — stejná disciplína jako D2, bez look-ahead.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const CUR = ["EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
const HORIZONS = [1, 3, 5, 10];              // obchodní dny
const BANDS = [[0, 2, "slabý <2"], [2, 3, "sweetspot 2–3"], [3, 99, "silný 3+"]];

// ── git plumbing: commity souboru (nejnovější → nejstarší) ─────────────
function fileCommits(file) {
  return sh(`git log --format='%H %cI' -- ${file}`).trim().split("\n").filter(Boolean)
    .map((l) => { const [h, iso] = l.split(" "); return { h, ts: Date.parse(iso) }; });
}
function snapshotAt(commits, file, tsLimit) {
  const c = commits.find((x) => x.ts <= tsLimit); // log je od nejnovějšího
  if (!c) return null;
  try { return JSON.parse(sh(`git show ${c.h}:${file}`)); } catch (e) { return null; }
}

// ── engine loader (stejný princip jako snapshot-engine.js) ─────────────
const engineSrc = fs.readFileSync(path.join(ROOT, "engine.js"), "utf8");
const exportsList = [
  "CURRENCIES", "STANDARD_PAIRS", "FUND_HIST_WINDOW_WEEKS",
  "mapFFEvent", "capEventsWindow", "scoreCurrency",
  "getLatestCOTScores", "loadCOT", "loadSentiment",
  "autoUpdateFromCalendar", "applyAutoRiskSentiment",
].join(",");
const factory = new Function("window", "localStorage", "__prices",
  engineSrc + "\n;if(__prices){_PRICES=__prices;}\nreturn {" + exportsList + "};");
function makeStore(seed) {
  const store = { ...seed };
  return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
}

(async () => {
  // ── data známá dnes ──────────────────────────────────────────────────
  const cotAll = JSON.parse(fs.readFileSync(path.join(ROOT, "data/cot_hist.json"), "utf8")).weeks;
  const retailAll = JSON.parse(fs.readFileSync(path.join(ROOT, "data/retail_hist.json"), "utf8")).points;
  const calCommits = fileCommits("data/calendar.json");
  const oilCommits = fileCommits("data/oil.json");
  const firstCal = calCommits[calCommits.length - 1].ts;
  const firstRetail = Date.parse(retailAll[0].t);
  const startMs = Math.max(firstCal, firstRetail);
  const endMs = Date.now() - 86400000; // včerejšek (dnešek nemá forward return vůbec)
  console.log("Replay okno:", new Date(startMs).toISOString().slice(0, 10), "→", new Date(endMs).toISOString().slice(0, 10));

  // ── Frankfurter kurzy: celé okno + horizonty dopředu ─────────────────
  const pxFrom = new Date(startMs - 7 * 86400000).toISOString().slice(0, 10);
  const pxTo = new Date().toISOString().slice(0, 10);
  const r = await fetch(`https://api.frankfurter.app/${pxFrom}..${pxTo}?from=USD&to=${CUR.join(",")}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("Frankfurter HTTP " + r.status);
  const ratesByDate = (await r.json()).rates;
  const pxDays = Object.keys(ratesByDate).sort();
  const pxHist = pxDays.map((d) => ({ d, rates: { USD: 1, ...ratesByDate[d] } }));
  const pairPrice = (p, dayIdx) => { const rr = pxHist[dayIdx].rates; const b = rr[p.base], q = rr[p.quote]; return (b && q) ? q / b : null; };
  const pxIdxOnOrAfter = (iso) => pxDays.findIndex((d) => d >= iso);

  // ── replay den po dni ────────────────────────────────────────────────
  // union kalendáře budujeme inkrementálně od nejstaršího snapshotu
  const calAsc = [...calCommits].reverse();
  const seenEvents = new Map(); // klíč den+země+název → event (prefer s actual)
  const evKey = (e) => (e.title || "") + "|" + (e.country || "") + "|" + String(e.date || "").slice(0, 10);
  let calPtr = 0;
  const days = [];
  for (let t = startMs; t <= endMs; t += 86400000) {
    const dayIso = new Date(t).toISOString().slice(0, 10);
    const dayEnd = t + 86400000 - 1;
    // 1) kalendář: přimíchej všechny snapshoty commitnuté do konce dne
    while (calPtr < calAsc.length && calAsc[calPtr].ts <= dayEnd) {
      let snap = null; try { snap = JSON.parse(sh(`git show ${calAsc[calPtr].h}:data/calendar.json`)); } catch (e) {}
      if (snap && Array.isArray(snap.events)) for (const e of snap.events) {
        const k = evKey(e); const prev = seenEvents.get(k);
        if (!prev || (!prev.actual && e.actual)) seenEvents.set(k, e);
      }
      calPtr++;
    }
    if (!seenEvents.size) continue;
    const rawEvents = [...seenEvents.values()];
    // 2) COT známý k X: report W publikován v pátek → známý od W+4 (sobota)
    const cotKnown = {};
    for (const [w, v] of Object.entries(cotAll)) if (Date.parse(w + "T00:00:00Z") + 4 * 86400000 <= dayEnd) cotKnown[w] = { ...v, src: "server" };
    if (!Object.keys(cotKnown).length) continue;
    const srvPct = {}; Object.entries(cotKnown).forEach(([w, v]) => { if (v.scores) srvPct[w] = v.scores; });
    // 3) retail k X
    const rPts = retailAll.filter((p) => Date.parse(p.t) <= dayEnd);
    const sentData = rPts.length ? rPts[rPts.length - 1].ccy : null;
    // 4) ropa k X (git snapshot; před prvním commitem prostě není)
    const oilSnap = snapshotAt(oilCommits, "data/oil.json", dayEnd);
    // 5) ceny do X pro risk_adj momentum
    const pxUpto = pxHist.filter((p) => p.d <= dayIso);
    const prices = pxUpto.length ? { updated: dayIso, rates: pxUpto[pxUpto.length - 1].rates, hist: pxUpto.slice(-10) } : null;
    // 6) čerstvý engine se stavem světa k X
    const seed = { cot_hist: JSON.stringify(cotKnown), cot_pct_server: JSON.stringify(srvPct) };
    if (oilSnap) seed["oil_wti_v1"] = JSON.stringify({ data: oilSnap, ts: dayEnd });
    const E = factory({}, makeStore(seed), prices);
    const events = rawEvents.map(E.mapFFEvent).filter((e) => Date.parse(String(e.time)) <= dayEnd || !e.actual); // actual jen z minulosti X (budoucí řádky bez actual smí zůstat jako upcoming — skóre je stejně ignoruje)
    try { E.autoUpdateFromCalendar(events); } catch (e) {}
    try { E.applyAutoRiskSentiment(); } catch (e) {}
    const calScoring = E.capEventsWindow(events, E.FUND_HIST_WINDOW_WEEKS);
    const cotScores = E.getLatestCOTScores() || E.loadCOT();
    const sent = sentData || E.loadSentiment();
    const sc = {};
    for (const c of E.CURRENCIES) sc[c] = E.scoreCurrency(calScoring, c, cotScores, sent).score;
    days.push({ d: dayIso, sc });
  }
  console.log("Rekonstruováno dní:", days.length);
  if (days.length < 5) throw new Error("Příliš krátké okno na jakýkoli výstup.");

  // ── vyhodnocení: diff dne X → vstup fix X+1 → výnos za H obchodních dní ──
  const PAIRS = factory({}, makeStore({}), null).STANDARD_PAIRS;
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
        trades.push({ d: day.d, pair: p.pair, diff: +diff.toFixed(2), h: H, ret: (p1 / p0 - 1) * (diff > 0 ? 1 : -1) * 100 });
      }
    }
  }
  const agg = (list) => { const n = list.length; if (!n) return { n: 0 };
    const w = list.filter((t) => t.ret > 0).length, gp = list.filter((t) => t.ret > 0).reduce((a, b) => a + b.ret, 0), gl = Math.abs(list.filter((t) => t.ret < 0).reduce((a, b) => a + b.ret, 0));
    return { n, wr: +(w / n * 100).toFixed(1), pf: gl > 0 ? +(gp / gl).toFixed(3) : null, avg: +(list.reduce((a, b) => a + b.ret, 0) / n).toFixed(4) }; };
  const grid = [];
  for (const [lo, hi, label] of BANDS) for (const H of HORIZONS)
    grid.push({ band: label, horizon: H, ...agg(trades.filter((t) => Math.abs(t.diff) >= lo && Math.abs(t.diff) < hi && t.h === H)) });

  const out = {
    updated: new Date().toISOString(),
    source: "historical replay skutečného engine.js — point-in-time git snapshoty + Frankfurter",
    window: { from: days[0].d, to: days[days.length - 1].d, daysReconstructed: days.length },
    entryRule: "skóre dne X (data ≤ X) → vstup denní fix X+1 — bez look-ahead",
    limitations: [
      "okno ~" + Math.round(days.length / 7 * 10) / 10 + " týdnů (kalendářní snapshoty od 2026-06-19) — PILOT, ne validace edge",
      "CB sazby/CPI: engine defaulty éry 2026-06 + autoUpdate z eventů okna",
      "ropa: před 2026-06-29 chybí (oil_adj=0)",
      "recency konstantní (okno <90 dní), sezónnost běží vůči dnešku (váha 0.02 → zanedbatelné)",
      "28 párů sdílí 8 měn → obchody NEJSOU nezávislé, efektivní n je mnohem menší",
    ],
    grid,
    dailyScores: days,
  };
  fs.writeFileSync(path.join(ROOT, "data/calibration_replay.json"), JSON.stringify(out));
  console.log("Grid:"); for (const g of grid) console.log(` ${g.band} h${g.horizon}d: n=${g.n} WR=${g.wr}% PF=${g.pf} avg=${g.avg}%`);
  console.log("OK · zapsáno data/calibration_replay.json");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

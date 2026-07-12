// VALIDACE backfillu (data/calendar_hist.json) proti ZLATÉMU STANDARDU —
// union všech živých git snapshotů data/calendar.json (existují od 2026-06-19).
// Podmínka před jakýmkoli použitím backfillu v backtestu: změřit, kde a jak moc
// se historické stránky liší od živě sbíraných dat (revize actualů, posuny
// tentative časů, chybějící/přebývající eventy).
// Výstup: data/calendar_hist_validation.json + čitelný souhrn do konzole.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const hist = JSON.parse(fs.readFileSync(path.join(ROOT, "data/calendar_hist.json"), "utf8"));

// ── union živých snapshotů (prefer záznam s actual — stejně jako appka) ──
const commits = sh("git log --format=%H -- data/calendar.json").trim().split("\n").filter(Boolean);
console.log("Živých snapshotů calendar.json:", commits.length);
const live = new Map();
const key = (e) => (e.title || "") + "|" + (e.country || "") + "|" + String(e.date).slice(0, 10);
for (const h of commits) {
  let snap = null;
  try { snap = JSON.parse(sh(`git show ${h}:data/calendar.json`)); } catch (e) { continue; }
  if (!snap || !Array.isArray(snap.events)) continue;
  for (const e of snap.events) {
    const k = key(e); const prev = live.get(k);
    if (!prev || (!prev.actual && e.actual)) live.set(k, e);
  }
}

// překryv: dny, pro které existují OBĚ strany (live pokrývá eventy zpětně od ~2026-05-08 v nejstarším snapshotu)
const liveDays = [...live.values()].map((e) => String(e.date).slice(0, 10));
const from = liveDays.sort()[0], to = liveDays.sort().at(-1);
console.log("Překryvné okno (dle live):", from, "→", to);
const bf = new Map();
for (const e of hist.events) { const d = String(e.date).slice(0, 10); if (d >= from && d <= to) bf.set(key(e), e); }
const lv = new Map();
for (const [k, e] of live) { const d = String(e.date).slice(0, 10); if (d >= from && d <= to) lv.set(k, e); }

// ── srovnání ────────────────────────────────────────────────────────────
const both = [], liveOnly = [], bfOnly = [];
for (const k of lv.keys()) (bf.has(k) ? both : liveOnly).push(k);
for (const k of bf.keys()) if (!lv.has(k)) bfOnly.push(k);

const diff = { actual: [], forecast: [], previous: [], impact: [], timeShift: [] };
const norm = (v) => String(v == null ? "" : v).trim();
for (const k of both) {
  const a = lv.get(k), b = bf.get(k);
  for (const f of ["actual", "forecast", "previous", "impact"]) {
    const va = norm(a[f]), vb = norm(b[f]);
    if (va && vb && va !== vb) diff[f].push({ key: k, live: va, backfill: vb });
  }
  const ta = Date.parse(a.date), tb = Date.parse(b.date);
  if (isFinite(ta) && isFinite(tb) && Math.abs(ta - tb) > 60000)
    diff.timeShift.push({ key: k, live: a.date, backfill: b.date, minutes: Math.round((tb - ta) / 60000) });
}
// scoring-relevantní podmnožina: eventy, které engine skutečně skóruje (mají actual+forecast na obou stranách)
const scoreable = both.filter((k) => norm(lv.get(k).actual) && norm(lv.get(k).forecast) && norm(bf.get(k).actual) && norm(bf.get(k).forecast));
const scoreableActualDiff = diff.actual.filter((d) => scoreable.includes(d.key));

const report = {
  updated: new Date().toISOString(),
  window: { from, to },
  counts: {
    liveEvents: lv.size, backfillEvents: bf.size, matched: both.length,
    liveOnly: liveOnly.length, backfillOnly: bfOnly.length,
    scoreableMatched: scoreable.length,
  },
  mismatches: {
    actual: diff.actual.length, forecast: diff.forecast.length,
    previous: diff.previous.length, impact: diff.impact.length,
    timeShiftOver1min: diff.timeShift.length,
    actualOnScoreable: scoreableActualDiff.length,
  },
  rates: {
    matchedPct: +(both.length / Math.max(1, lv.size) * 100).toFixed(1),
    actualRevisionPct: +(diff.actual.length / Math.max(1, both.length) * 100).toFixed(2),
    actualRevisionOnScoreablePct: +(scoreableActualDiff.length / Math.max(1, scoreable.length) * 100).toFixed(2),
  },
  samples: {
    actual: diff.actual.slice(0, 25),
    forecast: diff.forecast.slice(0, 10),
    timeShift: diff.timeShift.slice(0, 15),
    liveOnly: liveOnly.slice(0, 15),
    backfillOnly: bfOnly.slice(0, 15),
  },
};
fs.writeFileSync(path.join(ROOT, "data/calendar_hist_validation.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ counts: report.counts, mismatches: report.mismatches, rates: report.rates }, null, 1));
console.log("OK · zapsáno data/calendar_hist_validation.json");

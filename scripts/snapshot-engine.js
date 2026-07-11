// Denní snapshot KOMPLETNÍHO skóre enginu (všechny komponenty + ceny párů)
// do data/engine_hist.json — infrastruktura pro budoucí backtest CELÉHO enginu
// (ne jen COT-diff složky jako scripts/backtest-cot.js). Žádná změna enginu:
// načte skutečný engine.js s localStorage stubem, nasype do něj stejná serverová
// data, která by viděl prohlížeč (data/*.json), a zavolá scoreCurrency().
//
// Použití dat: až se nasbírá ~26 týdnů, jde poprvé orientačně změřit, jestli
// diff celkového skóre má kladnou expektaci a která komponenta nese edge;
// po ~52 týdnech split-half validace a případný přepočet pásem SLABÝ/SWEETSPOT/
// SILNÝ na datech celého enginu. Vstupní metodika převzata z backtest-cot.js:
// obchod nejdřív od následujícího denního fixu po snapshotu.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

// ── localStorage/window stub ──────────────────────────────────────────
const store = {};
const localStorageStub = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

// Seed: stejná data, jaká frontend mergne z data/*.json
const cotHist = readJSON("data/cot_hist.json");
store["cot_hist"] = JSON.stringify(cotHist.weeks);
try { const oil = readJSON("data/oil.json"); store["oil_wti_v1"] = JSON.stringify({ data: oil, ts: Date.now() }); } catch (e) {}
let retailLatest = null;
try { const rh = readJSON("data/retail_hist.json"); if (rh && Array.isArray(rh.points) && rh.points.length) retailLatest = rh.points[rh.points.length - 1]; } catch (e) {}
let prices = null;
try { prices = readJSON("data/prices.json"); } catch (e) {}

// ── Načtení engine.js do izolovaného scope ────────────────────────────
const engineSrc = fs.readFileSync(path.join(ROOT, "engine.js"), "utf8");
const exportsList = [
  "CURRENCIES", "STANDARD_PAIRS", "FUND_HIST_WINDOW_WEEKS",
  "mapFFEvent", "capEventsWindow", "scoreCurrency", "rankPairs",
  "getLatestCOTScores", "loadCOT", "loadSentiment", "getCOTPercentile",
  "autoUpdateFromCalendar", "applyAutoRiskSentiment", "getLivePrices",
].join(",");
const factory = new Function(
  "window", "localStorage", "__prices",
  engineSrc + "\n;if(__prices){_PRICES=__prices;}\nreturn {" + exportsList + "};"
);
const E = factory({}, localStorageStub, prices);

// ── Výpočet přesně jako frontend refreshData() ────────────────────────
const cal = readJSON("data/calendar.json");
const events = cal.events.map(E.mapFFEvent);
try { E.autoUpdateFromCalendar(events); } catch (e) {}
try { E.applyAutoRiskSentiment(); } catch (e) {}
const calScoring = E.capEventsWindow(events, E.FUND_HIST_WINDOW_WEEKS);
const cotScores = E.getLatestCOTScores() || E.loadCOT();
const sent = (retailLatest && retailLatest.ccy) || E.loadSentiment();

const day = {};
for (const c of E.CURRENCIES) {
  const s = E.scoreCurrency(calScoring, c, cotScores, sent);
  day[c] = {
    score: s.score,
    comp: Object.fromEntries((s.components || []).map((x) => [x.key, x.value])),
    cot_pct: s.cot_pct,
  };
}
const pairPrices = E.getLivePrices();

const today = new Date().toISOString().slice(0, 10);
const record = { ts: new Date().toISOString(), cur: day, px: pairPrices };

// ── Merge do data/engine_hist.json (nikdy nepřepisovat starší dny) ────
let out = { source: "snapshot-engine.js — denní komponenty skóre + ceny", days: {} };
try { const prev = readJSON("data/engine_hist.json"); if (prev && prev.days) out = prev; } catch (e) {}
const prevRecord = JSON.stringify(out.days[today] && out.days[today].cur);
out.days[today] = record;
out.updated = record.ts;

if (prevRecord === JSON.stringify(record.cur)) {
  console.log("Snapshot pro " + today + " beze změny, nepřepisuji.");
  process.exit(0);
}
fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "data", "engine_hist.json"), JSON.stringify(out));
console.log("OK · " + today + " · dnů v historii: " + Object.keys(out.days).length +
  " · skóre: " + E.CURRENCIES.map((c) => c + " " + day[c].score).join(", "));

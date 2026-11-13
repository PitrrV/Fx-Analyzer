// Point-in-time stav Analyzeru pro MT5 deník → data/analyzer_state.json (jen NEJNOVĚJŠÍ stav).
// Historii z něj skládá Supabase edge funkce analyzer-state-capture (každých 15 min ukládá
// nový stav do tabulky analyzer_state_history), takže se git nezahlcuje.
// Počítá se stejným engine.js a stejnými daty jako appka (viz snapshot-engine.js).
// Každý zdroj nese vlastní čas aktualizace; co chybí, je null (nikdy se nedoplňuje).
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const tryJSON = (p) => { try { return readJSON(p); } catch (e) { return null; } };

const store = {};
const localStorageStub = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };

const cotHist = readJSON("data/cot_hist.json");
store["cot_hist"] = JSON.stringify(cotHist.weeks);
const oil = tryJSON("data/oil.json"); if (oil) store["oil_wti_v1"] = JSON.stringify({ data: oil, ts: Date.now() });
const retailHist = tryJSON("data/retail_hist.json");
const retailLatest = retailHist && Array.isArray(retailHist.points) && retailHist.points.length ? retailHist.points[retailHist.points.length - 1] : null;
const prices = tryJSON("data/prices.json"), vix = tryJSON("data/vix.json"), alerts = tryJSON("data/bias_alert_state.json");
if (alerts && alerts.rpEr) store["rp_er_since"] = JSON.stringify(alerts.rpEr);
if (alerts && alerts.seasonal) store["seasonal_radar_since"] = JSON.stringify(alerts.seasonal);

const engineSrc = fs.readFileSync(path.join(ROOT, "engine.js"), "utf8");
const names = ["CURRENCIES", "STANDARD_PAIRS", "FUND_HIST_WINDOW_WEEKS", "CENTRAL_BANK_RATES", "mapFFEvent", "capEventsWindow", "scoreCurrency", "rankPairs",
  "getLatestCOTScores", "loadCOT", "loadSentiment", "autoUpdateFromCalendar", "applyAutoRiskSentiment"].join(",");
const E = new Function("window", "localStorage", "__prices", "__vix", engineSrc + "\n;if(__prices){_PRICES=__prices;}\nif(__vix){_VIX_LATEST=__vix;}\nreturn {" + names + "};")({}, localStorageStub, prices, vix);

const cal = tryJSON("data/calendar_hist.json") || readJSON("data/calendar.json");
const events = cal.events.map(E.mapFFEvent);
try { E.autoUpdateFromCalendar(events); } catch (e) {}
try { E.applyAutoRiskSentiment(); } catch (e) {}
const calScoring = E.capEventsWindow(events, E.FUND_HIST_WINDOW_WEEKS);
const cotScores = E.getLatestCOTScores() || E.loadCOT();
const sent = (retailLatest && retailLatest.ccy) || E.loadSentiment();

const weekKeys = Object.keys(cotHist.weeks).sort(), lastWeek = weekKeys[weekKeys.length - 1];
const rawCot = (cotHist.weeks[lastWeek] || {}).raw || {};
const scores = {}, cur = {}, cotOut = {};
for (const c of E.CURRENCIES) {
  const s = E.scoreCurrency(calScoring, c, cotScores, sent);
  scores[c] = s;
  cur[c] = { score: s.score, comp: Object.fromEntries((s.components || []).map((x) => [x.key, { value: x.value, raw: x.raw == null ? null : x.raw }])), cot_pct: s.cot_pct == null ? null : s.cot_pct };
  const r = rawCot[c];
  cotOut[c] = r ? { lev_long: r.levLong, lev_short: r.levShort, lev_net: r.levNet, asset_long: r.assetLong, asset_short: r.assetShort, asset_net: r.assetNet, flow: r.flow == null ? null : r.flow } : null;
}
let ranked = [];
try { ranked = E.rankPairs(scores, {}).map((p) => ({ pair: p.pair, dir: p.dir, diff: +(+p.diff).toFixed(3), conviction: p.conv ?? p.conviction ?? null })); } catch (e) {}
const sources = {
  cot: { report_week: lastWeek || null, updated: cotHist.updated || null },
  retail: { point_time: retailLatest ? retailLatest.t : null, updated: retailHist ? retailHist.updated || null : null },
  calendar: { updated: cal.updated || null },
  vix: { updated: vix ? vix.updated || null : null },
  prices: { updated: prices ? prices.updated || null : null },
  bias_alerts: { updated: alerts ? alerts.updated || null : null },
};
const state = {
  asof: new Date().toISOString(), schema: 1,
  cur, cot: cotOut,
  retail: retailLatest ? { t: retailLatest.t, pairs: retailLatest.pairs || null } : null,
  pairs: ranked,
  rates: Object.fromEntries(E.CURRENCIES.map((c) => [c, E.CENTRAL_BANK_RATES[c] == null ? null : E.CENTRAL_BANK_RATES[c]])),
  vix: vix ? { value: vix.vix, regime: vix.regime } : null,
  reversal: alerts && alerts.rpEr ? alerts.rpEr : null,       // aktivní RP+ER signály (typ a od kdy)
  seasonal_radar: alerts && alerts.seasonal ? alerts.seasonal : null,
  technical: null,                                              // technická data Analyzer nemá => NULL, ne odhad
  sources,
};
// Obsah beze změny (mimo asof) => ponechat starý soubor i asof: stav platí dál od původního asof
// a git/DB se nezahlcují (stejný princip jako snapshot-engine.js).
const strip = (o) => JSON.stringify({ ...o, asof: null });
const prev = tryJSON("data/analyzer_state.json");
if (prev && strip(prev) === strip(state)) { console.log("analyzer_state beze změny (asof " + prev.asof + ")"); process.exit(0); }
fs.writeFileSync(path.join(ROOT, "data", "analyzer_state.json"), JSON.stringify(state));
console.log("analyzer_state OK · " + state.asof + " · párů: " + ranked.length);

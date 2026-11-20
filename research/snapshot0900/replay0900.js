#!/usr/bin/env node
// Zpětná rekonstrukce stavu Analyzeru k 09:00 Europe/Prague (s letním časem) pro daný den.
// Jen výzkum/diagnostika — NEMĚNÍ produkční kód ani data. Nic nezapisuje do repozitáře (jen do tmp složky).
//
// Princip ("git time-travel"): všechny vstupy (data/*.json) i engine.js se vezmou z POSLEDNÍHO commitu
// s časem <= okamžik 09:00 Prague (cutoff). Skript snapshot-analyzer-state.js (stejný, který počítá
// produkční snímek analyzer_state.json) se spustí nad touto složkou s ZMRAZENÝM časem (Date shim = cutoff),
// takže engine nemá jak vidět "teď" ani žádný pozdější vstup.
//
// Použití: node replay0900.js 2026-11-17 [--engine=asof|current] [--cutoff=ISO] [--leak=hodiny] [--out=soubor.json]
const fs = require("fs"), path = require("path"), os = require("os"), { execSync, spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "../..");
const sh = (c, o = {}) => execSync(c, { cwd: ROOT, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, ...o });
const args = process.argv.slice(2);
const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const opt = (k, d) => { const a = args.find((x) => x.startsWith("--" + k + "=")); return a ? a.split("=").slice(1).join("=") : d; };
const producer = opt("producer", "analyzer_state"); // "engine_hist" = skript snapshot-engine.js ve verzi platné v tu dobu (přesná reprodukce záznamu engine_hist.json)
const engineMode = opt("engine", "asof"), leakH = +opt("leak", 0), outFile = opt("out", null);
if (!day && !opt("cutoff", null)) { console.error("Zadej den YYYY-MM-DD"); process.exit(2); }

// 09:00 Europe/Prague -> UTC ms (správně i s letním časem)
function pragueNine(d) {
  for (const h of [7, 8]) {
    const ms = Date.parse(`${d}T0${h}:00:00Z`);
    const hh = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Prague", hour: "2-digit", hour12: false }).format(new Date(ms));
    if (hh === "09") return ms;
  }
  throw new Error("DST?");
}
const cutoffMs = opt("cutoff", null) ? Date.parse(opt("cutoff")) : pragueNine(day);
const effMs = cutoffMs + leakH * 3600e3; // jen pro "leak test": záměrně se podívat do budoucnosti

function cftcFriday(reportWeek) {
  const d = new Date(Date.parse(reportWeek + "T00:00:00Z") + 3 * 86400000); // úterý + 3 = pátek
  const ymd = d.toISOString().slice(0, 10);
  for (const h of [19, 20]) { const ms = Date.parse(`${ymd}T${h}:30:00Z`); const ny = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms)); if (ny === "15:30") return new Date(ms).toISOString(); }
  return null;
}

const FILES = ["data/gold_cot.json", "data/gold_retail.json", "data/gold_price.json", "data/us100_cot.json", "data/us100_retail.json", "data/us100_macro.json", "data/us100_price.json", "data/cot_hist.json", "data/calendar_hist.json", "data/calendar.json", "data/oil.json", "data/retail_hist.json", "data/prices.json", "data/vix.json", "data/bias_alert_state.json"];
const commitsCache = {};
function commitsOf(f) { return commitsCache[f] ||= sh(`git log origin/main --format='%H %ct' -- ${f}`).trim().split("\n").filter(Boolean).map((l) => { const [h, t] = l.split(" "); return { h, ts: +t * 1000 }; }); }
const pick = (f, ms) => commitsOf(f).find((c) => c.ts <= ms) || null;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "replay0900-"));
fs.mkdirSync(path.join(tmp, "data"), { recursive: true }); fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
const prov = { day: day || null, cutoff_utc: new Date(cutoffMs).toISOString(), leak_hours: leakH, engine_mode: engineMode, files: {} };
const put = (f, c) => { fs.writeFileSync(path.join(tmp, f), execSync(`git show ${c.h}:${f}`, { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 })); prov.files[f] = { commit: c.h.slice(0, 10), commit_time: new Date(c.ts).toISOString() }; };
const FALLBACK = ["data/cot_hist.json", "data/calendar_hist.json", "data/retail_hist.json"]; // mají v sobě celou historii => lze je časově ořezat
for (const f of FILES) {
  const c = pick(f, effMs);
  if (c) put(f, c);
  else if (FALLBACK.includes(f)) {
    // soubor v git v ten čas ještě neexistoval (archiv začal později): vezme se dnešní verze a ořízne se na to, co bylo v cutoff známé
    const d = JSON.parse(execSync(`git show origin/main:${f}`, { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 }).toString());
    if (f.includes("cot_hist")) { for (const w of Object.keys(d.weeks)) { const pub = cftcFriday(w); if (!pub || Date.parse(pub) > effMs) delete d.weeks[w]; } }
    if (f.includes("calendar_hist")) { d.events = d.events.filter((e) => Date.parse(e.date) <= effMs); d.updated = new Date(effMs).toISOString(); }
    if (f.includes("retail_hist")) { d.points = d.points.filter((p) => Date.parse(p.t) <= effMs); d.updated = d.points.length ? d.points.at(-1).t : null; }
    if (f.includes("retail_hist") && !d.points.length) { prov.files[f] = { fallback: "před začátkem sběru retail sentimentu — chybí (sentiment neutrální)" }; continue; }
    fs.writeFileSync(path.join(tmp, f), JSON.stringify(d));
    prov.files[f] = { fallback: "dnešní verze oříznutá na čas ≤ cutoff (" + (f.includes("cot") ? "dle pravidla CFTC pátek 15:30 NY" : f.includes("calendar") ? "události s datem ≤ cutoff; actual = finální/revidovaná hodnota, ne první otisk" : "body s časem ≤ cutoff") + ")" };
  } else prov.files[f] = null;
}
let eng = engineMode === "current" ? { h: "origin/main", ts: Date.now() } : pick("engine.js", effMs);
if (!eng) { eng = { h: "origin/main", ts: Date.now() }; prov.engine_mode = "current (engine.js v tu dobu v git neexistoval)"; }
fs.writeFileSync(path.join(tmp, "engine.js"), execSync(`git show ${eng.h}:engine.js`, { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 }));
prov.files["engine.js"] = { commit: String(eng.h).slice(0, 10), commit_time: new Date(eng.ts).toISOString() };
// skript snímku: verze platná v tu dobu, jinak aktuální
const SCRIPT = producer === "engine_hist" ? "scripts/snapshot-engine.js" : "scripts/snapshot-analyzer-state.js";
const sc = pick(SCRIPT, effMs);
fs.writeFileSync(path.join(tmp, SCRIPT), execSync(sc ? `git show ${sc.h}:${SCRIPT}` : `git show origin/main:${SCRIPT}`, { cwd: ROOT }));
prov.files[SCRIPT] = sc ? { commit: sc.h.slice(0, 10), commit_time: new Date(sc.ts).toISOString() } : { note: "v tu dobu neexistoval; použita aktuální verze skriptu" };
if (producer === "engine_hist") fs.writeFileSync(path.join(tmp, "data/engine_hist.json"), JSON.stringify({ days: {} }));

// Date shim: "teď" = cutoff (engine nemůže vidět budoucnost ani skutečný dnešek)
fs.writeFileSync(path.join(tmp, "shim.js"), `const R=Date,N=${effMs};class D extends R{constructor(...a){if(a.length===0)super(N);else super(...a)}static now(){return N}}D.parse=R.parse;D.UTC=R.UTC;globalThis.Date=D;`);
let r = spawnSync("node", ["-r", path.join(tmp, "shim.js"), path.join(tmp, SCRIPT)], { cwd: tmp, encoding: "utf8" });
if (r.status !== 0 && engineMode === "asof") { // engine z té doby nemá funkce, které snímací skript potřebuje => dnešní engine (přepočet "dnešním kódem")
  fs.writeFileSync(path.join(tmp, "engine.js"), execSync(`git show origin/main:engine.js`, { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 }));
  prov.engine_mode = "current (fallback: engine z té doby nešel načíst)"; prov.files["engine.js"] = { fallback: "dnešní engine.js" };
  r = spawnSync("node", ["-r", path.join(tmp, "shim.js"), path.join(tmp, SCRIPT)], { cwd: tmp, encoding: "utf8" });
}
const outPath = path.join(tmp, producer === "engine_hist" ? "data/engine_hist.json" : "data/analyzer_state.json");
if (!fs.existsSync(outPath)) { console.error("Snímek se nepodařilo spočítat:\n" + (r.stderr || r.stdout).slice(0, 600)); process.exit(4); }
let state = JSON.parse(fs.readFileSync(outPath, "utf8"));
if (producer === "engine_hist") { // záznam dne do tvaru shodného s analyzer_state (cur: score/comp/cot_pct)
  const dk = Object.keys(state.days).sort().pop(), e = state.days[dk];
  state = { asof: e.ts, cur: Object.fromEntries(Object.entries(e.cur).map(([c, v]) => [c, { score: v.score, comp: Object.fromEntries(Object.entries(v.comp).map(([k, x]) => [k, { value: x, raw: null }])), cot_pct: v.cot_pct }])), px: e.px, pairs: [], retail: null, vix: null, sources: {} };
}

// ── audit "žádný pohled do budoucnosti": nejpozdější časová razítka ve vstupech ──
const J = (f) => { try { return JSON.parse(fs.readFileSync(path.join(tmp, f), "utf8")); } catch (e) { return null; } };
const cot = J("data/cot_hist.json"), ret = J("data/retail_hist.json"), cal = J("data/calendar_hist.json"), vix = J("data/vix.json"), pr = J("data/prices.json"), oil = J("data/oil.json");
const maxIso = (a) => a.filter(Boolean).sort().pop() || null;
const future = (iso) => iso && Date.parse(iso) > cutoffMs;
const calFutureActuals = cal ? cal.events.filter((e) => e.actual && Date.parse(e.date) > cutoffMs).length : null;
const cotViaGit = !(prov.files["data/cot_hist.json"] || {}).fallback;
const audit = {
  cot_latest_publication_by_cftc_rule: cot ? maxIso(Object.keys(cot.weeks).map(cftcFriday)) : null,
  cot_max_updatedAt: cot && cotViaGit ? maxIso(Object.values(cot.weeks).map((w) => w.updatedAt)) : null,
  cot_newest_report_week: cot ? Object.keys(cot.weeks).sort().pop() : null,
  retail_newest_point: ret ? ret.points.at(-1).t : null,
  vix_updated: vix ? vix.updated : null, prices_updated: pr ? pr.updated : null, oil_updated: oil ? oil.updated : null,
  calendar_updated: cal ? cal.updated : null,
  calendar_events_with_actual_after_cutoff: calFutureActuals,
};
audit.lookahead_free = !(future(audit.cot_latest_publication_by_cftc_rule) || future(audit.cot_max_updatedAt) || future(audit.retail_newest_point) || future(audit.vix_updated) || future(audit.prices_updated) || future(audit.oil_updated) || future(audit.calendar_updated) || calFutureActuals > 0);
// ── doplňkové sekce: COT (kdy bylo zveřejněno), kalendář před cutoffem, trh (VIX/ropa/retail/ceny), RP/ER signály ──
const extras = {};
// COT: datum REPORTU (úterý) vs. datum ZVEŘEJNĚNÍ. Pravidlo CFTC: pátek 15:30 New York (po svátku později);
// empiricky: první commit, v němž se daný týden v cot_hist.json objevil (jen od 2026-06-27, kdy se commity začaly archivovat).
if (cot) {
  extras.cot = Object.keys(cot.weeks).sort().slice(-3).map((w) => {
    let first = null;
    try { first = sh(`git log origin/main -S'"${w}"' --format=%cI -- data/cot_hist.json`).trim().split("\n").filter(Boolean).pop() || null; } catch (e) {}
    return { report_date: w, publication_rule_cftc: cftcFriday(w), first_seen_in_repo: first, scores: cot.weeks[w].scores };
  });
}
// kalendář: události dne (podle pražského dne) vydané před cutoffem; BEAT/MISS ze směru, který počítá sám engine
try {
  const pragueDay = (ms) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date(ms));
  const E = new Function("window", "localStorage", "return (function(){" + fs.readFileSync(path.join(tmp, "engine.js"), "utf8") + "\n;return {mapFFEvent,eventDirection,getEventMeta};})()")({}, { getItem: () => null, setItem() {}, removeItem() {} });
  const calSrc = J("data/calendar.json") || cal; const dayStr = pragueDay(cutoffMs);
  extras.calendar_before_cutoff = (calSrc.events || []).filter((e) => Date.parse(e.date) <= cutoffMs && pragueDay(Date.parse(e.date)) === dayStr && String(e.actual || "").trim() !== "")
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).map((e) => {
      let dir = null; try { dir = E.eventDirection(E.mapFFEvent(e)); } catch (x) {}
      return { time_prague: new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague", hour: "2-digit", minute: "2-digit" }).format(new Date(e.date)), ccy: e.country, event: e.title, impact: e.impact, actual: e.actual, forecast: e.forecast || null, previous: e.previous || null,
        beat_miss: !String(e.forecast || "").trim() ? "bez forecastu (nelze určit)" : dir === 1 ? "BEAT" : dir === -1 ? "MISS" : (E.getEventMeta(e.title) ? "IN-LINE" : "nehodnoceno (událost není v pravidlech engine)") };
    });
  extras.calendar_source = J("data/calendar.json") ? "data/calendar.json (živý snapshot = první otisk, od 2026-06-19)" : "calendar_hist.json (backfill, finální/revidované hodnoty)";
} catch (e) { extras.calendar_error = String(e.message).slice(0, 200); }
const rl = ret && ret.points.length ? ret.points.at(-1) : null;
extras.market = { vix: vix ? { value: vix.vix, regime: vix.regime, updated: vix.updated, five_day_change: vix.vix5dChange } : null,
  oil_wti: oil ? { current: oil.current, as_of: oil.date, w4ago: oil.w4ago, w13ago: oil.w13ago } : null,
  dxy: null, dxy_note: "DXY se nikam neukládá (ani v repozitáři, ani v Supabase); jde jen přibližně dopočítat z párů",
  retail_sentiment: rl ? { point_time: rl.t, ccy_long_pct: rl.ccy || null, pairs_long_pct: rl.pairs ? Object.fromEntries(Object.entries(rl.pairs).map(([k, v]) => [k, v.l])) : null } : null,
  prices_updated: pr ? pr.updated : null };
const bas = J("data/bias_alert_state.json");
extras.reversal_active = bas ? bas.rpEr : null; extras.bias_state = bas ? bas.biasState : null;
// ── páry (28 FX + XAUUSD + US100): směr, skóre, hvězdy, výhled %, RP/ER, COT percentil — stejným postupem jako scripts/bias-alerts.js ──
try {
  const store = {};
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  if (cot) store["cot_hist"] = JSON.stringify(cot.weeks);
  if (oil) store["oil_wti_v1"] = JSON.stringify({ data: oil, ts: effMs });
  const g = (f, d) => J(f) || d;
  store["gold_cot_hist"] = JSON.stringify(g("data/gold_cot.json", { hist: {} }).hist || {});
  store["gold_retail_hist"] = JSON.stringify(g("data/gold_retail.json", { points: [] }).points || []);
  if (J("data/gold_price.json")) store["gold_price"] = JSON.stringify(J("data/gold_price.json"));
  store["us100_cot_hist"] = JSON.stringify(g("data/us100_cot.json", { hist: {} }).hist || {});
  store["us100_retail_hist"] = JSON.stringify(g("data/us100_retail.json", { points: [] }).points || []);
  store["us100_macro"] = JSON.stringify(g("data/us100_macro.json", {}));
  if (J("data/us100_price.json")) store["us100_price"] = JSON.stringify(J("data/us100_price.json"));
  const RealDate = Date; class RD extends RealDate { constructor(...a) { if (a.length === 0) super(effMs); else super(...a); } static now() { return effMs; } } RD.parse = RealDate.parse; RD.UTC = RealDate.UTC;
  const names = "CURRENCIES,FUND_HIST_WINDOW_WEEKS,mapFFEvent,capEventsWindow,scoreCurrency,rankPairs,getLatestCOTScores,loadCOT,loadSentiment,autoUpdateFromCalendar,applyAutoRiskSentiment,buildGoldPair,scoreGold,scoreUS100,deriveUpcomingFromEvents,buildForecastV5,getRangePosition,getEfficiencyRatio,getGoldRangePosition,getGoldEfficiencyRatio,getUS100RangePosition,getUS100EfficiencyRatio";
  const F = new Function("window", "localStorage", "__prices", "__vix", "Date", fs.readFileSync(path.join(tmp, "engine.js"), "utf8") + "\n;if(__prices){_PRICES=__prices;}\nif(__vix){_VIX_LATEST=__vix;}\nreturn {" + names + "};");
  const E = F({}, ls, pr, vix, RD);
  const rawEvents = (cal && cal.events && cal.events.length) ? cal.events : ((J("data/calendar.json") || { events: [] }).events || []);
  const evs = rawEvents.map(E.mapFFEvent); try { E.autoUpdateFromCalendar(evs); } catch (e) {} try { E.applyAutoRiskSentiment(); } catch (e) {}
  const calScoring = E.capEventsWindow(evs, E.FUND_HIST_WINDOW_WEEKS), cotScores = E.getLatestCOTScores() || E.loadCOT();
  const sent = (rl && rl.ccy) || E.loadSentiment(); const sc = {}; for (const c of E.CURRENCIES) sc[c] = E.scoreCurrency(calScoring, c, cotScores, sent);
  store["score_hist"] = JSON.stringify({ [new Date(effMs).toISOString().slice(0, 10)]: Object.fromEntries(E.CURRENCIES.map((c) => [c, sc[c].score])) });
  let ranked = E.rankPairs(sc, {}); let gold = null; try { gold = E.scoreGold(); } catch (e) {} if (gold) ranked = ranked.concat([E.buildGoldPair(gold)]);
  const up = E.deriveUpcomingFromEvents(rawEvents);
  extras.pairs = ranked.map((p) => {
    let rp = null, er = null, fc = null;
    try { if (p.isGold) { rp = E.getGoldRangePosition(10); er = E.getGoldEfficiencyRatio(10); } else { rp = E.getRangePosition(p.pair, 10); er = E.getEfficiencyRatio(p.pair, 10); } } catch (e) {}
    if (!p.isGold) { try { fc = E.buildForecastV5(p, sc, calScoring, up); } catch (e) {} }
    return { pair: p.pair, dir: p.dir, diff: +(+p.diff).toFixed(3), stars: p.conviction ?? p.conv ?? null, outlook_dir: fc ? fc.dir : null, outlook_prob_pct: fc ? fc.prob : null,
      RP10: rp ? rp.rp : null, ER10: er ? er.er : null, cot_pct_base: (sc[p.base] && sc[p.base].cot_pct) ?? null, cot_pct_quote: (sc[p.quote] && sc[p.quote].cot_pct) ?? null };
  });
  try { const u = E.scoreUS100(); if (u) { const rpu = E.getUS100RangePosition(10), eru = E.getUS100EfficiencyRatio(10); extras.us100 = { score: u.score, dir: u.score > 0 ? "BUY" : "SELL", RP10: rpu ? rpu.rp : null, ER10: eru ? eru.er : null }; } } catch (e) {}
} catch (e) { extras.pairs_error = String(e.message).slice(0, 300); }
const res = { provenance: prov, audit, extras, state };
if (outFile) fs.writeFileSync(outFile, JSON.stringify(res, null, 1));
console.log(JSON.stringify({ provenance: prov, audit, asof: state.asof }, null, 1));
if (!outFile) fs.writeFileSync(path.join(tmp, "result.json"), JSON.stringify(res)), console.error("výsledek:", path.join(tmp, "result.json"));

// Telegram alerty na DISKRÉTNÍ, kvalitativní události — nahrazuje dřívější
// scripts/score-alerts.js (alert na |Δ diff| >= 1.0 OD POSLEDNÍHO ALERTU).
// Ten měl reálný problém: baseline "poslední odeslaná hodnota" mohla být
// klidně 16+ dní stará (pár se dlouho nehnul), takže pomalý plíživý drift
// vypadal ve zprávě stejně dramaticky jako čerstvý 36h pohyb — uživatel to
// označil za nepřehledné/nepoužitelné (2026-09-18).
//
// Nový přístup — dvě věci, které appka už stejně počítá pro UI, jen se
// zatím neposílaly na Telegram:
//   1) OTOČENÍ BIASU (BUY↔SELL flip) — stejná detekce jako panel "⚡ Otočení
//      biasu" v appce (engine.js: updateBiasFlips/getRecentFlips). Diskrétní
//      binární událost, ne kontinuální číslo — buď se bias otočil, nebo ne.
//   2) RP+ER EXHAUSTION signál — stejná karta jako v detailu páru/zlata/
//      US100 ("RP + ER — exhaustion signál"). Alertuje se na NÁBĚŽNOU HRANU
//      (signál se právě objevil), ne opakovaně každých 15 min, dokud trvá.
//
// Stav = data/bias_alert_state.json — VÝHRADNĚ tohoto skriptu, nezávislé na
// "bias_state" v localStorage prohlížeče (to řídí per-zařízení UI panel);
// tenhle soubor je jen serverová paměť "co už bylo odesláno".
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const readJSON = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")); }
  catch (e) { return fallback; }
};

function computeLive(prevBiasState) {
  const store = {};
  const localStorageStub = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };

  const cotHist = readJSON("data/cot_hist.json", { weeks: {} });
  store["cot_hist"] = JSON.stringify(cotHist.weeks || {});
  try { const oil = readJSON("data/oil.json", null); if (oil) store["oil_wti_v1"] = JSON.stringify({ data: oil, ts: Date.now() }); } catch (e) {}
  let retailLatest = null;
  try { const rh = readJSON("data/retail_hist.json", null); if (rh && Array.isArray(rh.points) && rh.points.length) retailLatest = rh.points[rh.points.length - 1]; } catch (e) {}
  const prices = readJSON("data/prices.json", null);
  const vix = readJSON("data/vix.json", null);

  // Zlato/US100 — jen POSLEDNÍ záznam/okno stačí (scoreGold/scoreUS100 čtou
  // vždy jen nejnovější datum), žádná potřeba akumulované historie napříč
  // běhy jako u FX cot_hist.
  store["gold_cot_hist"] = JSON.stringify(readJSON("data/gold_cot.json", { hist: {} }).hist || {});
  store["gold_retail_hist"] = JSON.stringify(readJSON("data/gold_retail.json", { points: [] }).points || []);
  const goldPrice = readJSON("data/gold_price.json", null); if (goldPrice) store["gold_price"] = JSON.stringify(goldPrice);
  store["us100_cot_hist"] = JSON.stringify(readJSON("data/us100_cot.json", { hist: {} }).hist || {});
  store["us100_retail_hist"] = JSON.stringify(readJSON("data/us100_retail.json", { points: [] }).points || []);
  store["us100_macro"] = JSON.stringify(readJSON("data/us100_macro.json", {}));
  const us100Price = readJSON("data/us100_price.json", null); if (us100Price) store["us100_price"] = JSON.stringify(us100Price);

  // Flip-detekce potřebuje svůj předchozí stav (viz hlavička souboru).
  store["bias_state"] = JSON.stringify(prevBiasState || {});

  const engineSrc = fs.readFileSync(path.join(ROOT, "engine.js"), "utf8");
  const exportsList = [
    "CURRENCIES", "STANDARD_PAIRS", "FUND_HIST_WINDOW_WEEKS",
    "mapFFEvent", "capEventsWindow", "scoreCurrency", "rankPairs",
    "getLatestCOTScores", "loadCOT", "loadSentiment",
    "autoUpdateFromCalendar", "applyAutoRiskSentiment",
    "buildGoldPair", "scoreGold", "scoreUS100",
    "updateBiasFlips", "getRecentFlips", "deriveUpcomingFromEvents",
    "getRangePosition", "getEfficiencyRatio",
    "getGoldRangePosition", "getGoldEfficiencyRatio",
    "getUS100RangePosition", "getUS100EfficiencyRatio",
  ].join(",");
  const factory = new Function(
    "window", "localStorage", "__prices", "__vix",
    engineSrc + "\n;if(__prices){_PRICES=__prices;}\nif(__vix){_VIX_LATEST=__vix;}\nreturn {" + exportsList + "};"
  );
  const E = factory({}, localStorageStub, prices, vix);

  // Stejné rozlišení RAW vs. MAPOVANÝCH eventů, jaké appka dělá v prohlížeči:
  // "cal"/"up" (flip driver, upcoming) čekají SUROVÝ tvar (viz refreshData()
  // v index.html: mergeEvents(this._cal,this._up) dostává přímo výstup
  // mergeFFHistory, ne mapFFEvent), zatímco skórování (capEventsWindow) chce
  // mapovaný tvar — dřívější scripts/score-alerts.js/snapshot-engine.js tenhle
  // rozdíl nepotřebovaly (nepočítaly flips), tady je to nutné udržet správně.
  const calHist = readJSON("data/calendar_hist.json", null);
  const rawEvents = (calHist && Array.isArray(calHist.events) && calHist.events.length) ? calHist.events : (readJSON("data/calendar.json", { events: [] }).events || []);
  const events = rawEvents.map(E.mapFFEvent);
  try { E.autoUpdateFromCalendar(events); } catch (e) {}
  try { E.applyAutoRiskSentiment(); } catch (e) {}
  const calScoring = E.capEventsWindow(events, E.FUND_HIST_WINDOW_WEEKS);
  const cotScores = E.getLatestCOTScores() || E.loadCOT();
  const sent = (retailLatest && retailLatest.ccy) || E.loadSentiment();

  const sc = {};
  for (const c of E.CURRENCIES) sc[c] = E.scoreCurrency(calScoring, c, cotScores, sent);

  // score_hist seed pro scoreGold()/scoreUS100() (USD-inverzní komponenta) —
  // server nemá persistovanou "score_hist" napříč běhy jako prohlížeč, ale
  // potřebuje jen DNEŠNÍ číslo, ne historii, takže stačí dosadit čerstvě
  // spočtené skóre pod dnešní datum.
  const today = new Date().toISOString().slice(0, 10);
  const shSeed = {}; E.CURRENCIES.forEach((c) => { shSeed[c] = sc[c].score; });
  store["score_hist"] = JSON.stringify({ [today]: shSeed });

  let ranked = E.rankPairs(sc, {});
  let goldScoreObj = null;
  try { goldScoreObj = E.scoreGold(); } catch (e) {}
  if (goldScoreObj) ranked = ranked.concat([E.buildGoldPair(goldScoreObj)]);

  let us100ScoreObj = null;
  try { us100ScoreObj = E.scoreUS100(); } catch (e) {}

  const up = E.deriveUpcomingFromEvents(rawEvents);

  return { E, ranked, sc, rawEvents, up, goldScoreObj, us100ScoreObj };
}

// Port getRPERSignal() z index.html (FXApp metoda) do samostatné funkce —
// STEJNÁ logika/prahy/PF tabulka, jen bez React/self. Viz komentář u
// getRPERSignal v index.html pro odůvodnění pásem.
function rpErSignal(E, p, sbScore, sqScore) {
  let rp = null, er = null;
  try {
    if (p.isGold) { rp = E.getGoldRangePosition(10); er = E.getGoldEfficiencyRatio(10); }
    else if (p.isUS100) { rp = E.getUS100RangePosition(10); er = E.getUS100EfficiencyRatio(10); }
    else { rp = E.getRangePosition(p.pair, 10); er = E.getEfficiencyRatio(p.pair, 10); }
  } catch (e) {}
  if (!rp || !er) return null;
  const diff = (sbScore || 0) - (sqScore || 0), NEUTRAL = 0.3;
  const bandPF = (type, e) => {
    const bands = type === "SHORT" ? [[0.5, 0.65, 1.19], [0.65, 0.8, 1.37], [0.8, 1.01, 2.45]] : [[0.2, 0.35, 1.66], [0.35, 0.5, 1.39], [0.5, 0.65, 1.64]];
    const b = bands.find(([lo, hi]) => e >= lo && e < hi) || bands[bands.length - 1];
    return b[2];
  };
  if (rp.rp >= 0.8 && er.er > 0.5) {
    if (diff < -NEUTRAL) return null;
    return { type: "SHORT", rp: rp.rp, er: er.er, diff, pf: bandPF("SHORT", er.er) };
  }
  if (rp.rp <= 0.2 && er.er >= 0.2 && er.er < 0.65) {
    if (diff > NEUTRAL) return null;
    return { type: "LONG", rp: rp.rp, er: er.er, diff, pf: bandPF("LONG", er.er) };
  }
  return null;
}

function escapeTgHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
async function sendTelegramMessage(token, chatId, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!r.ok) console.log("Telegram send fail", r.status, await r.text());
  } catch (e) { console.log("Telegram send error", e.message); }
}

(async () => {
  const state = readJSON("data/bias_alert_state.json", { biasState: {}, rpEr: {} });
  const prevBiasState = state.biasState || {};
  const { E, ranked, sc, rawEvents, up, goldScoreObj, us100ScoreObj } = computeLive(prevBiasState);

  // ── 1) OTOČENÍ BIASU ────────────────────────────────────────────────────
  const newBiasState = E.updateBiasFlips(ranked);
  const flippedPairs = Object.keys(newBiasState).filter((pair) => {
    const now = newBiasState[pair], prev = prevBiasState[pair];
    return now && now.flippedAt && (!prev || prev.flippedAt !== now.flippedAt);
  });
  // getRecentFlips dá zdarma "driver" (která měna/event flip nejspíš způsobil)
  // — okno 2h stačí s rezervou na to, co jsme právě detekovali jako nové výš.
  const recentFlips = flippedPairs.length ? E.getRecentFlips(ranked, rawEvents, up, 2) : [];
  const flipMoves = flippedPairs.map((pair) => recentFlips.find((f) => f.pair === pair)).filter(Boolean);

  // ── 2) RP+ER EXHAUSTION (náběžná hrana) ─────────────────────────────────
  const prevRpEr = state.rpEr || {};
  const newRpEr = {};
  const rpErMoves = [];
  for (const p of ranked) {
    const sbScore = p.isGold ? goldScoreObj.score : sc[p.base].score;
    const sqScore = p.isGold ? sc.USD.score : sc[p.quote].score;
    const sig = rpErSignal(E, p, sbScore, sqScore);
    newRpEr[p.pair] = sig ? sig.type : null;
    if (sig && sig.type !== prevRpEr[p.pair]) rpErMoves.push({ pair: p.pair, ...sig });
  }
  if (us100ScoreObj) {
    const us100Pair = { pair: "US100", isUS100: true };
    const sig = rpErSignal(E, us100Pair, us100ScoreObj.score, 0);
    newRpEr.US100 = sig ? sig.type : null;
    if (sig && sig.type !== prevRpEr.US100) rpErMoves.push({ pair: "US100", ...sig });
  }

  const token = (process.env.SCORE_TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = (process.env.SCORE_TELEGRAM_CHAT_ID || "").trim();
  const fmtNum = (n) => { const r = +n.toFixed(2); return (r >= 0 ? "+" : "") + r; };

  const blocks = [];
  for (const f of flipMoves) {
    const driverTxt = f.driver ? ` · driver: ${escapeTgHtml(f.driver)}` : "";
    blocks.push(`⚡ <b>${escapeTgHtml(f.pair)}</b> — otočení biasu\n${escapeTgHtml(f.from || "?")} → <b>${escapeTgHtml(f.to)}</b>${driverTxt}`);
  }
  for (const m of rpErMoves) {
    const icon = m.type === "SHORT" ? "🔴" : "🟢";
    blocks.push(`${icon} <b>${escapeTgHtml(m.pair)}</b> — RP+ER exhaustion (${m.type})\n`
      + `RP ${Math.round(m.rp * 100)}% · ER ${m.er.toFixed(2)} · historicky PF ${m.pf.toFixed(2)} · fundament ${fmtNum(m.diff)}`);
  }

  if (blocks.length && token && chatId) {
    const header = blocks.length > 1 ? `🔔 <b>${blocks.length} nová událost(i):</b>\n\n` : "";
    const chunks = []; let cur = header;
    for (const b of blocks) {
      if (cur.length + b.length + 2 > 3800 && cur !== header) { chunks.push(cur); cur = ""; }
      cur += (cur && cur !== header ? "\n\n" : "") + b;
    }
    if (cur) chunks.push(cur);
    for (const chunk of chunks) await sendTelegramMessage(token, chatId, chunk);
    console.log("Odesláno " + blocks.length + " událost(i) na Telegram v " + chunks.length + " zpráv(ách).");
  } else if (blocks.length) {
    console.log(blocks.length + " událost(i), ale chybí SCORE_TELEGRAM_BOT_TOKEN/SCORE_TELEGRAM_CHAT_ID — nic neposláno.");
  } else {
    console.log("Žádné otočení biasu ani nový RP+ER signál od minulého běhu.");
  }

  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "bias_alert_state.json"), JSON.stringify({ biasState: newBiasState, rpEr: newRpEr }));
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

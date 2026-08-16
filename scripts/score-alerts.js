// Telegram alert na výrazný pohyb skóre páru — |Δ diff| >= ALERT_THRESHOLD od
// POSLEDNÍHO odeslaného alertu pro ten pár (ne "od včerejška" — appka běží na
// stejném 15minutovém cronu jako kalendář/VIX/ropa v data-refresh.yml, takže
// tohle chytí i pohyb UVNITŘ dne, ne jen jednou večer po US session).
//
// Počítá živé skóre STEJNÝM enginem jako appka (localStorage stub — Date shim
// není potřeba, appka chce "teď") — stejný trik jako scripts/snapshot-engine.js,
// jen se čte pokaždé znovu, ne jednou denně.
//
// Práh 1.0 zvolen z reálných dat (25 dní historie, 192 měřených denních změn
// skóre napříč 8 měnami k 2026-08-14): medián |Δ| = 0.18, p90 = 0.87 — práh 1.0
// odpovídá zhruba nejvýraznějším ~8 % denních pohybů, ne běžnému šumu. Stejný
// práh ponechán i pro intraday kontrolu — appka porovnává proti poslední
// ODESLANÉ hodnotě, ne proti minulému běhu, takže sémantika prahu ("kolik je
// už neobvyklý pohyb") zůstává stejná, jen se kontroluje častěji.
//
// Samostatný Telegram bot/chat (SCORE_TELEGRAM_BOT_TOKEN/SCORE_TELEGRAM_CHAT_ID,
// jiné repo secrets než RADAR_TELEGRAM_*). Bez secrets tiše nic neposílá.
//
// Stav = poslední ODESLANÁ hodnota diffu pro každý pár, v
// data/score_alert_state.json. Při prvním běhu (pár v state chybí) se jen
// nasetuje baseline, NEALERTUJE — jinak by první spuštění poslalo 28 zpráv
// najednou. Každý další běh porovnává PROTI TÉ BASELINE, ne proti minulému
// běhu — jinak by pomalý plíživý posun (0.3 každých 15 min) nikdy nepřekročil
// práh, i kdyby se za pár hodin sečetl na 2+.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const readJSON = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")); }
  catch (e) { return fallback; }
};

const ALERT_THRESHOLD = 1.0;

function computeLiveScores() {
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
  let prices = null;
  try { prices = readJSON("data/prices.json", null); } catch (e) {}

  const engineSrc = fs.readFileSync(path.join(ROOT, "engine.js"), "utf8");
  const exportsList = [
    "CURRENCIES", "STANDARD_PAIRS", "FUND_HIST_WINDOW_WEEKS",
    "mapFFEvent", "capEventsWindow", "scoreCurrency",
    "getLatestCOTScores", "loadCOT", "loadSentiment",
    "autoUpdateFromCalendar", "applyAutoRiskSentiment",
  ].join(",");
  const factory = new Function(
    "window", "localStorage", "__prices",
    engineSrc + "\n;if(__prices){_PRICES=__prices;}\nreturn {" + exportsList + "};"
  );
  const E = factory({}, localStorageStub, prices);

  const cal = readJSON("data/calendar.json", { events: [] });
  const events = (cal.events || []).map(E.mapFFEvent);
  try { E.autoUpdateFromCalendar(events); } catch (e) {}
  try { E.applyAutoRiskSentiment(); } catch (e) {}
  const calScoring = E.capEventsWindow(events, E.FUND_HIST_WINDOW_WEEKS);
  const cotScores = E.getLatestCOTScores() || E.loadCOT();
  const sent = (retailLatest && retailLatest.ccy) || E.loadSentiment();

  const scores = {};
  for (const c of E.CURRENCIES) scores[c] = E.scoreCurrency(calScoring, c, cotScores, sent).score;
  return { scores, pairs: E.STANDARD_PAIRS };
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
  const { scores, pairs } = computeLiveScores();
  const state = readJSON("data/score_alert_state.json", {});
  const nowIso = new Date().toISOString();
  const moves = [];
  let seededCount = 0;

  for (const { pair, base, quote } of pairs) {
    const sB = scores[base], sQ = scores[quote];
    if (typeof sB !== "number" || typeof sQ !== "number") continue;
    const diffNow = +(sB - sQ).toFixed(2);
    const baseline = state[pair];
    if (baseline == null || typeof baseline.diff !== "number") {
      state[pair] = { diff: diffNow, ts: nowIso };
      seededCount++;
      continue;
    }
    const delta = +(diffNow - baseline.diff).toFixed(2);
    if (Math.abs(delta) >= ALERT_THRESHOLD) {
      moves.push({ pair, base, quote, diffPrev: baseline.diff, diffNow, delta, prevTs: baseline.ts });
      state[pair] = { diff: diffNow, ts: nowIso };
    }
  }
  moves.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const token = (process.env.SCORE_TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = (process.env.SCORE_TELEGRAM_CHAT_ID || "").trim();
  if (moves.length && token && chatId) {
    for (const m of moves) {
      const dir = m.diffNow >= 0 ? "BUY" : "SELL", strong = m.diffNow >= 0 ? m.base : m.quote;
      const arrow = m.delta > 0 ? "📈" : "📉";
      const text = `${arrow} <b>${escapeTgHtml(m.pair)}</b> skóre diff ${m.diffPrev >= 0 ? "+" : ""}${m.diffPrev} → ${m.diffNow >= 0 ? "+" : ""}${m.diffNow} (${m.delta >= 0 ? "+" : ""}${m.delta})\nNový bias: ${dir} (${escapeTgHtml(strong)} silnější)`;
      await sendTelegramMessage(token, chatId, text);
    }
    console.log("Odesláno " + moves.length + " alert(ů) na Telegram.");
  } else if (moves.length) {
    console.log(moves.length + " pohyb(ů) nad prahem " + ALERT_THRESHOLD + ", ale chybí SCORE_TELEGRAM_BOT_TOKEN/SCORE_TELEGRAM_CHAT_ID — nic neposláno: " +
      moves.map((m) => m.pair + " " + (m.delta >= 0 ? "+" : "") + m.delta).join(", "));
  } else if (seededCount) {
    console.log("Prvotní seed baseline pro " + seededCount + " párů, žádný alert (očekávané při prvním běhu).");
  } else {
    console.log("Žádný pár nepřekročil práh " + ALERT_THRESHOLD + " od posledního alertu.");
  }

  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "score_alert_state.json"), JSON.stringify(state));
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

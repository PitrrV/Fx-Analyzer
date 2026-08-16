// Denní Telegram alert na výrazné pohyby skóre párů — |Δ diff| >= ALERT_THRESHOLD
// mezi dvěma po sobě jdoucími denními snapshoty z data/engine_hist.json (píše ho
// scripts/snapshot-engine.js, běží ve stejném workflow o krok dřív). Žádný nový
// fetch, jen porovnání už existujících dat.
//
// Práh 1.0 zvolen z reálných dat (25 dní historie, 192 měřených denních změn
// skóre napříč 8 měnami k 2026-08-14): medián |Δ| = 0.18, p90 = 0.87 — práh 1.0
// odpovídá zhruba nejvýraznějším ~8 % denních pohybů, ne běžnému dennímu šumu.
//
// Samostatný Telegram bot/chat (SCORE_TELEGRAM_BOT_TOKEN/SCORE_TELEGRAM_CHAT_ID,
// jiné repo secrets než RADAR_TELEGRAM_*) — na výslovné přání ať se skóre alerty
// neminou s news squawkem z Market Radaru. Bez secrets tiše nic neposílá (stejný
// vzor jako GEMINI_KEY/FINNHUB_KEY ve fetch-radar.js).
//
// Stav (poslední den, za který se už alertovalo) v data/score_alert_state.json,
// ať re-run stejného dne (retry / workflow_dispatch) neposlal duplicitní alerty.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const readJSON = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")); }
  catch (e) { return fallback; }
};

const ALERT_THRESHOLD = 1.0;

// STANDARD_PAIRS z reálného engine.js (ne ruční kopie) — stejný trik jako
// scripts/snapshot-engine.js, ať se seznam párů nikdy nerozejde s appkou.
function loadStandardPairs() {
  const engineSrc = fs.readFileSync(path.join(ROOT, "engine.js"), "utf8");
  const store = {};
  const localStorageStub = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const factory = new Function("window", "localStorage", engineSrc + "\n;return STANDARD_PAIRS;");
  return factory({}, localStorageStub);
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
  const hist = readJSON("data/engine_hist.json", null);
  if (!hist || !hist.days) { console.log("data/engine_hist.json chybí/prázdné, nic k porovnání."); process.exit(0); }
  const dates = Object.keys(hist.days).sort();
  if (dates.length < 2) { console.log("Míň než 2 dny historie, nic k porovnání."); process.exit(0); }
  const today = dates[dates.length - 1], prevDate = dates[dates.length - 2];

  const state = readJSON("data/score_alert_state.json", { lastAlertedDate: "" });
  if (state.lastAlertedDate === today) {
    console.log("Za " + today + " už bylo alertováno, přeskakuji (re-run stejného dne).");
    process.exit(0);
  }

  const curToday = hist.days[today].cur || {}, curPrev = hist.days[prevDate].cur || {};
  const pairs = loadStandardPairs();
  const moves = [];
  for (const { pair, base, quote } of pairs) {
    const sBt = curToday[base] && curToday[base].score, sQt = curToday[quote] && curToday[quote].score;
    const sBp = curPrev[base] && curPrev[base].score, sQp = curPrev[quote] && curPrev[quote].score;
    if ([sBt, sQt, sBp, sQp].some((v) => typeof v !== "number")) continue;
    const diffToday = +(sBt - sQt).toFixed(2), diffPrev = +(sBp - sQp).toFixed(2);
    const delta = +(diffToday - diffPrev).toFixed(2);
    if (Math.abs(delta) >= ALERT_THRESHOLD) moves.push({ pair, base, quote, diffToday, diffPrev, delta });
  }
  moves.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const token = (process.env.SCORE_TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = (process.env.SCORE_TELEGRAM_CHAT_ID || "").trim();
  if (moves.length && token && chatId) {
    for (const m of moves) {
      const dir = m.diffToday >= 0 ? "BUY" : "SELL", strong = m.diffToday >= 0 ? m.base : m.quote;
      const arrow = m.delta > 0 ? "📈" : "📉";
      const text = `${arrow} <b>${escapeTgHtml(m.pair)}</b> skóre diff ${m.diffPrev >= 0 ? "+" : ""}${m.diffPrev} → ${m.diffToday >= 0 ? "+" : ""}${m.diffToday} (${m.delta >= 0 ? "+" : ""}${m.delta})\nNový bias: ${dir} (${escapeTgHtml(strong)} silnější) · ${prevDate} → ${today}`;
      await sendTelegramMessage(token, chatId, text);
    }
    console.log("Odesláno " + moves.length + " alert(ů) na Telegram (" + prevDate + " → " + today + ").");
  } else if (moves.length) {
    console.log(moves.length + " pohyb(ů) nad prahem " + ALERT_THRESHOLD + ", ale chybí SCORE_TELEGRAM_BOT_TOKEN/SCORE_TELEGRAM_CHAT_ID — nic neposláno: " +
      moves.map((m) => m.pair + " " + (m.delta >= 0 ? "+" : "") + m.delta).join(", "));
  } else {
    console.log("Žádný pár nepřekročil práh " + ALERT_THRESHOLD + " (" + prevDate + " → " + today + ").");
  }

  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "score_alert_state.json"), JSON.stringify({ lastAlertedDate: today, lastCheckedMoves: moves.length }));
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

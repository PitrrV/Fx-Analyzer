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
// jiné secrets než Market Radar (RADAR_TELEGRAM_*)). Bez secrets tiše nic
// neposílá.
//
// Stav = poslední ODESLANÁ hodnota diffu PRO KAŽDÝ PÁR (+ jaké byly tehdy
// složky skóre obou měn) v data/score_alert_state.json. Při prvním běhu (pár
// v state chybí) se jen nasetuje baseline, NEALERTUJE — jinak by první
// spuštění poslalo 28 zpráv najednou. Každý další běh porovnává PROTI TÉ
// BASELINE, ne proti minulému běhu — jinak by pomalý plíživý posun (0.3
// každých 15 min) nikdy nepřekročil práh, i kdyby se za pár hodin sečetl na
// 2+. Baseline u konkrétního páru tak může být klidně několik dní stará,
// pokud se ten pár dlouho nehnul — proto zpráva vždycky uvádí, jak stará
// srovnávaná hodnota je (jinak "skok o 1.8" vypadá dramaticky, i když je to
// součet přes 2 dny klidu).
//
// Reálný nález (2026-08-19): uživatel zkontroloval "aktuální skóre" proti
// tomu, co bylo v alertu, a nesedělo mu to — ukázalo se, že to byla jen
// otázka ČASU (appka mezitím dál počítá živě, číslo v alertu je snímek z
// okamžiku odeslání) a CHYBĚJÍCÍHO KONTEXTU (proč se to hnulo). Odsud tři
// změny: baseline stáří v textu, "hlavní příčina" (která složka skóre
// nejvíc přispěla k delta) a víc pohybů najednou = JEDNA souhrnná zpráva
// místo spamu, ať je hned vidět, že spolu souvisí.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const readJSON = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")); }
  catch (e) { return fallback; }
};

const ALERT_THRESHOLD = 1.0;

// Popisky komponent — musí sedět na "key" ze scoreCurrency().components v
// engine.js (viz komentář "VÁŽENÉ KOMPONENTY" tam). Ručně držené v syncu,
// stejně jako zbytek tohohle skriptu duplikuje enginový výpočet do Node.
const COMPONENT_LABELS = {
  fund_data: "Fundamenty (kalendář)", policy: "CB Policy", yield: "Real yield",
  cot: "COT", sent: "Retail", season: "Sezónnost", oil: "Ropa (WTI)",
  risk: "Risk režim", momentum: "Momentum", clip: "Ořez na ±10",
};

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

  const scores = {}, components = {};
  for (const c of E.CURRENCIES) {
    const s = E.scoreCurrency(calScoring, c, cotScores, sent);
    scores[c] = s.score;
    components[c] = Object.fromEntries((s.components || []).map((x) => [x.key, x.value]));
  }
  return { scores, components, pairs: E.STANDARD_PAIRS };
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

// Kolik je hodin/dní od ISO timestampu — do textu zprávy, ať je jasné, jestli
// jde o náhlý skok, nebo součet za dlouhou dobu klidu.
function ageLabel(iso) {
  const h = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (h < 1) return Math.round(h * 60) + " min";
  if (h < 48) return h.toFixed(0) + " h";
  return (h / 24).toFixed(0) + " dní";
}

// Která komponenta skóre nejvíc přispěla k delta páru — porovná (base−quote)
// složku teď vs. při baseline. Vrací null, když baseline složky chybí (starý
// formát state souboru, ještě bez nich — self-heal na dalším běhu).
function dominantComponent(m) {
  if (!m.baseCompPrev || !m.quoteCompPrev) return null;
  let best = null, bestAbs = 0;
  for (const key of Object.keys(COMPONENT_LABELS)) {
    const nowV = (m.baseCompNow[key] || 0) - (m.quoteCompNow[key] || 0);
    const prevV = (m.baseCompPrev[key] || 0) - (m.quoteCompPrev[key] || 0);
    const d = +(nowV - prevV).toFixed(2);
    if (Math.abs(d) > bestAbs) { bestAbs = Math.abs(d); best = { key, delta: d }; }
  }
  return (best && bestAbs >= 0.05) ? best : null;
}

(async () => {
  const { scores, components, pairs } = computeLiveScores();
  const state = readJSON("data/score_alert_state.json", {});
  const nowIso = new Date().toISOString();
  const moves = [];
  let seededCount = 0;

  for (const { pair, base, quote } of pairs) {
    const sB = scores[base], sQ = scores[quote];
    if (typeof sB !== "number" || typeof sQ !== "number") continue;
    const diffNow = +(sB - sQ).toFixed(2);
    const baseline = state[pair];
    const nextBaseline = { diff: diffNow, ts: nowIso, baseComp: components[base], quoteComp: components[quote] };
    if (baseline == null || typeof baseline.diff !== "number") {
      state[pair] = nextBaseline;
      seededCount++;
      continue;
    }
    const delta = +(diffNow - baseline.diff).toFixed(2);
    if (Math.abs(delta) >= ALERT_THRESHOLD) {
      moves.push({
        pair, base, quote, diffPrev: baseline.diff, diffNow, delta, prevTs: baseline.ts,
        baseCompNow: components[base], quoteCompNow: components[quote],
        baseCompPrev: baseline.baseComp, quoteCompPrev: baseline.quoteComp,
      });
      state[pair] = nextBaseline;
    }
  }
  moves.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const token = (process.env.SCORE_TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = (process.env.SCORE_TELEGRAM_CHAT_ID || "").trim();
  if (moves.length && token && chatId) {
    // Jedna souhrnná zpráva místo N zvlášť (reálný nález: 6 párů najednou
    // vypadalo jako spam a nebylo hned vidět, že spolu souvisí — typicky
    // sdílenou měnou). Telegram limit ~4096 znaků na zprávu — bezpečně
    // rozděl po blocích, kdyby jich bylo hodně.
    const blocks = moves.map((m) => {
      const dir = m.diffNow >= 0 ? "BUY" : "SELL", strong = m.diffNow >= 0 ? m.base : m.quote;
      const arrow = m.delta > 0 ? "📈" : "📉";
      const dom = dominantComponent(m);
      const domLine = dom ? `\nHlavní příčina: ${escapeTgHtml(COMPONENT_LABELS[dom.key] || dom.key)} ${dom.delta >= 0 ? "+" : ""}${dom.delta}` : "";
      return `${arrow} <b>${escapeTgHtml(m.pair)}</b> skóre diff ${m.diffPrev >= 0 ? "+" : ""}${m.diffPrev} → ${m.diffNow >= 0 ? "+" : ""}${m.diffNow} (${m.delta >= 0 ? "+" : ""}${m.delta})\n`
        + `Nový bias: ${dir} (${escapeTgHtml(strong)} silnější) · základna stará ${ageLabel(m.prevTs)}${domLine}`;
    });
    const header = moves.length > 1 ? `🔔 <b>${moves.length} párů překročilo práh ${ALERT_THRESHOLD}:</b>\n\n` : "";
    const chunks = [];
    let cur = header;
    for (const b of blocks) {
      if (cur.length + b.length + 2 > 3800 && cur !== header) { chunks.push(cur); cur = ""; }
      cur += (cur && cur !== header ? "\n\n" : "") + b;
    }
    if (cur) chunks.push(cur);
    for (const chunk of chunks) await sendTelegramMessage(token, chatId, chunk);
    console.log("Odesláno " + moves.length + " pohyb(ů) na Telegram v " + chunks.length + " zpráv(ách).");
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

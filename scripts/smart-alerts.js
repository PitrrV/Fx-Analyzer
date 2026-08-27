// AI Smart Alerts — sleduje pravidla, co admin vytvořil v index.html (přirozená
// věta → OpenRouter LLM → strukturované pravidlo, uloženo přes GitHub Contents
// API do data/smart_alerts.json). Appka nemá backend, takže samotné sledování
// na pozadí běží stejně jako Telegram skóre alerty — tenhle skript na cronu
// v data-refresh.yml (15 min), žádný nový trigger, žádný nový Telegram bot
// (reused SCORE_TELEGRAM_BOT_TOKEN/CHAT_ID).
//
// Dva typy pravidel (rozlišené polem "kind"):
// - kind:"metric" (výchozí/starší pravidla bez "kind" se chovají takhle):
//   {id,text,summary,metric,targetType,target,op,value,repeat,status,
//   lastValue,lastMet,lastCheckedAt,firedAt,firedValue}. status: active|paused|fired.
//   Vyhodnocení: met = op==="gte" ? value>=threshold : value<=threshold. Alert se
//   spustí jen na PŘECHODU !lastMet→met (ne opakovaně, dokud je podmínka trvale
//   splněná) — lastMet je uloženo z minulého běhu (nebo z okamžiku vytvoření
//   pravidla v prohlížeči, spočtené na aktuální hodnotě, ať čerstvě vytvořené
//   pravidlo, co je hned splněné, nespustí falešný alert při první kontrole).
//   Bez "repeat" (výchozí) se po spuštění pravidlo samo pozastaví (status
//   "fired") — typický záměr věty "upozorni mě, AŽ..." je jednorázový.
// - kind:"event": {id,text,summary,kind:"event",ccy,event,date(YYYY-MM-DD),
//   status,notified,lastCheckedAt,firedAt,firedActual,firedEstimate,firedPrev}.
//   Žádná hranice — spustí se jednou, jakmile appka v kalendářních datech uvidí
//   pro danou (ccy,event,date) vyplněné "actual". "repeat" se u tohoto typu
//   ignoruje (ekonomická zpráva vyjde jen jednou), po spuštění vždy → "fired".
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const readJSON = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")); }
  catch (e) { return fallback; }
};

// Stejný trik jako scripts/score-alerts.js — reálný engine.js přes localStorage
// stub, ať skóre i retail % nikdy neujedou appce v prohlížeči.
function computeLiveState() {
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
    "autoUpdateFromCalendar", "applyAutoRiskSentiment", "getRetailPairData", "getEfficiencyRatio",
  ].join(",");
  const factory = new Function(
    "window", "localStorage", "__prices",
    engineSrc + "\n;if(__prices){_PRICES=__prices;}\nreturn {" + exportsList + "};"
  );
  const E = factory({}, localStorageStub, prices);

  // Akumulovaná historie (data/calendar_hist.json), ne jen rolling ~8týdenní
  // okno — viz stejný komentář ve scripts/score-alerts.js.
  const calHist = readJSON("data/calendar_hist.json", null);
  const cal = (calHist && Array.isArray(calHist.events) && calHist.events.length) ? calHist : readJSON("data/calendar.json", { events: [] });
  const events = (cal.events || []).map(E.mapFFEvent);
  try { E.autoUpdateFromCalendar(events); } catch (e) {}
  try { E.applyAutoRiskSentiment(); } catch (e) {}
  const calScoring = E.capEventsWindow(events, E.FUND_HIST_WINDOW_WEEKS);
  const cotScores = E.getLatestCOTScores() || E.loadCOT();
  const sent = (retailLatest && retailLatest.ccy) || E.loadSentiment();

  const scores = {};
  for (const c of E.CURRENCIES) scores[c] = E.scoreCurrency(calScoring, c, cotScores, sent).score;
  // sentData pro retail % — stejný tvar jako browser (currency -> long %),
  // fallback 50 (neutrální) když provider daný den nic nemá.
  const sentData = {};
  for (const c of E.CURRENCIES) sentData[c] = sent && sent[c] != null ? sent[c] : 50;

  return {
    scores, sentData, pairs: E.STANDARD_PAIRS,
    getRetailPairData: E.getRetailPairData, getEfficiencyRatio: E.getEfficiencyRatio,
    directPairs: (retailLatest && retailLatest.pairs) || null,
  };
}

function evalMetric(rule, live) {
  if (rule.metric === "score") {
    if (rule.targetType === "currency") {
      const v = live.scores[rule.target];
      return typeof v === "number" ? v : null;
    }
    const p = live.pairs.find((x) => x.pair === rule.target);
    if (!p) return null;
    const sb = live.scores[p.base], sq = live.scores[p.quote];
    if (typeof sb !== "number" || typeof sq !== "number") return null;
    return +(sb - sq).toFixed(2);
  }
  if (rule.metric === "retail_long_pct" || rule.metric === "retail_short_pct") {
    const p = live.pairs.find((x) => x.pair === rule.target);
    if (!p) return null;
    const rd = live.getRetailPairData(p, live.sentData, live.directPairs);
    return rule.metric === "retail_long_pct" ? rd.retailLong : rd.retailShort;
  }
  if (rule.metric === "efficiency_ratio") {
    const p = live.pairs.find((x) => x.pair === rule.target);
    if (!p) return null;
    const er = live.getEfficiencyRatio(p.pair, 10);
    return er ? er.er : null;
  }
  return null;
}

// Stejná OR-sémantika jako smartRuleMet() v index.html (drženo ručně v syncu —
// prohlížeč a tenhle skript běží v oddělených runtime, žádný sdílený modul).
function ruleMet(rule, v) {
  if (v == null) return false;
  const test = (op, val) => (op === "gte" ? v >= val : v <= val);
  if (rule.op2 != null && rule.value2 != null) return test(rule.op, rule.value) || test(rule.op2, rule.value2);
  return test(rule.op, rule.value);
}

// Stejný zdroj jako computeLiveState() (přednost akumulované historii, ta se
// aktualizuje cronem a má i starší/rychle proběhlé události, co z rolling
// calendar.json okna už mohly vypadnout), ale BEZ mapFFEvent() — surová data
// mají "country" už jako 3písmennou měnu (viz data/calendar_hist.json), takže
// se rovnou porovnává s rule.ccy beze ztráty/konverze.
function loadCalendarEventsRaw() {
  const hist = readJSON("data/calendar_hist.json", null);
  if (hist && Array.isArray(hist.events) && hist.events.length) return hist.events;
  const cal = readJSON("data/calendar.json", { events: [] });
  return cal.events || [];
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
  const state = readJSON("data/smart_alerts.json", { rules: [] });
  if (!Array.isArray(state.rules)) state.rules = [];
  if (!state.rules.length) { console.log("Žádná AI Smart Alerts pravidla."); return; }

  const live = computeLiveState();
  const calEvents = loadCalendarEventsRaw();
  const token = (process.env.SCORE_TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = (process.env.SCORE_TELEGRAM_CHAT_ID || "").trim();
  const nowIso = new Date().toISOString();
  let changed = false, fired = 0, checked = 0;

  for (const rule of state.rules) {
    if (rule.status !== "active") continue;

    if (rule.kind === "event") {
      checked++;
      rule.lastCheckedAt = nowIso;
      changed = true;
      const match = calEvents.find((e) =>
        String(e.country || "").toUpperCase() === rule.ccy &&
        e.title === rule.event &&
        String(e.date || "").slice(0, 10) === rule.date
      );
      const actual = match && match.actual != null ? String(match.actual).trim() : "";
      if (actual && !rule.notified) {
        fired++;
        rule.notified = true;
        rule.firedAt = nowIso;
        rule.firedActual = actual;
        rule.firedEstimate = (match.forecast != null && String(match.forecast).trim() !== "") ? String(match.forecast).trim() : null;
        rule.firedPrev = (match.previous != null && String(match.previous).trim() !== "") ? String(match.previous).trim() : null;
        rule.status = "fired"; // jednorázová zpráva — "repeat" u tohoto typu nedává smysl
        if (token && chatId) {
          const text = `🔔 <b>AI Smart Alert — výsledek</b>\n${escapeTgHtml(rule.ccy)} · ${escapeTgHtml(rule.event)}\n\nVýsledek: <b>${escapeTgHtml(rule.firedActual)}</b>`
            + (rule.firedEstimate ? `\nOdhad: ${escapeTgHtml(rule.firedEstimate)}` : "")
            + (rule.firedPrev ? `\nPředchozí: ${escapeTgHtml(rule.firedPrev)}` : "");
          await sendTelegramMessage(token, chatId, text);
        }
      }
      continue;
    }

    const val = evalMetric(rule, live);
    if (val == null) continue;
    checked++;
    const met = ruleMet(rule, val);
    const prevMet = !!rule.lastMet;
    rule.lastValue = val;
    rule.lastCheckedAt = nowIso;
    changed = true;

    if (met && !prevMet) {
      fired++;
      rule.firedAt = nowIso;
      rule.firedValue = val;
      if (token && chatId) {
        const unit = (rule.metric === "retail_long_pct" || rule.metric === "retail_short_pct") ? " %" : "";
        const text = `🔔 <b>AI Smart Alert</b>\n„${escapeTgHtml(rule.text)}"\n\n${escapeTgHtml(rule.summary || "")}\nAktuální hodnota: <b>${val}${unit}</b>`;
        await sendTelegramMessage(token, chatId, text);
      }
      rule.status = rule.repeat ? "active" : "fired";
      rule.lastMet = rule.repeat ? true : prevMet; // repeat: zůstává "met" dokud nespadne pod/nad — pak může znovu spustit
    } else {
      rule.lastMet = met;
    }
  }

  if (changed) fs.writeFileSync(path.join(ROOT, "data", "smart_alerts.json"), JSON.stringify(state));
  console.log(`AI Smart Alerts: zkontrolováno ${checked}, spuštěno ${fired}.`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

// Jednorázová testovací Telegram zpráva — ukázka PŘESNÉHO formátu, v jakém
// appka posílá reálné bias alerty (scripts/bias-alerts.js: otočení biasu +
// RP+ER exhaustion signál), ale bez čekání na skutečnou událost. Spouští se
// ručně (workflow_dispatch) z test-telegram-alert.yml. Nic nezapisuje, nic
// neovlivňuje — jen demo zpráva.
function escapeTgHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
async function sendTelegramMessage(token, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) { console.error("Telegram send fail", r.status, await r.text()); process.exit(1); }
  console.log("Testovací zpráva odeslána.");
}

(async () => {
  const token = (process.env.SCORE_TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = (process.env.SCORE_TELEGRAM_CHAT_ID || "").trim();
  if (!token || !chatId) { console.error("Chybí SCORE_TELEGRAM_BOT_TOKEN/SCORE_TELEGRAM_CHAT_ID — nastav v repo secrets."); process.exit(1); }

  const intro = "🧪 <b>Testovací zpráva</b> — takhle bude vypadat ostrý alert, žádná skutečná událost:";
  const sample = `⚡ <b>${escapeTgHtml("EURUSD")}</b> — otočení biasu\nSELL → <b>BUY</b> · driver: EUR\n\n`
    + `🟢 <b>${escapeTgHtml("GBPJPY")}</b> — RP+ER exhaustion (LONG)\nRP 12% · ER 0.42 · historicky PF 1.39 · fundament +0.60`;

  await sendTelegramMessage(token, chatId, intro);
  await sendTelegramMessage(token, chatId, sample);
})();

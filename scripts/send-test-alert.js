// Jednorázová testovací Telegram zpráva — ukázka PŘESNÉHO formátu, v jakém
// appka posílá reálné skóre alerty (scripts/score-alerts.js), ale bez čekání
// na skutečný pohyb skóre. Spouští se ručně (workflow_dispatch) z
// test-telegram-alert.yml. Nic nezapisuje, nic neovlivňuje — jen demo zpráva.
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

  const intro = "🧪 <b>Testovací zpráva</b> — takhle bude vypadat ostrý alert, žádný skutečný pohyb skóre:";
  const sample = `📈 <b>${escapeTgHtml("EURUSD")}</b> skóre diff +1.2 → +2.7 (+1.5)\nNový bias: BUY (EUR silnější)`;

  await sendTelegramMessage(token, chatId, intro);
  await sendTelegramMessage(token, chatId, sample);
})();

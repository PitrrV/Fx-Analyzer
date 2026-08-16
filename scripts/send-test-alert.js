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

  // Diagnostika (bez vyzrazení tajných hodnot) — "chat not found" může znamenat
  // buď špatné chat_id, nebo že secret obsahuje něco jiného, než uživatel čeká
  // (mezery, uvozovky, zalomení řádku zkopírované z BotFail/getUpdates apod.).
  console.log(`Diagnostika: token délka=${token.length}, obsahuje ':' na pozici=${token.indexOf(":")}`);
  console.log(`Diagnostika: chat_id délka=${chatId.length}, první3="${chatId.slice(0, 3)}", poslední3="${chatId.slice(-3)}", je číslo=${/^-?\d+$/.test(chatId)}`);

  // getMe ověří token nezávisle na chat_id — ať víme, jestli je problém v tokenu,
  // nebo výhradně v chat_id.
  try {
    const me = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const meBody = await me.json();
    console.log("Diagnostika getMe:", JSON.stringify(meBody));
  } catch (e) { console.log("Diagnostika getMe selhala:", e.message); }

  // getUpdates PŘÍMO z tohoto tokenu (ne z ručně přečteného screenshotu) — ukáže
  // přesně, jaké chaty tenhle konkrétní bot vůbec kdy zaznamenal. chat.id není
  // citlivý údaj (je to jen Telegram user ID), bezpečné vypsat celé.
  try {
    const upd = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    const updBody = await upd.json();
    if (updBody.ok && Array.isArray(updBody.result)) {
      const chats = updBody.result.map((u) => {
        const m = u.message || u.my_chat_member || u.channel_post || {};
        const chat = m.chat || (u.my_chat_member && u.my_chat_member.chat) || {};
        return { chat_id: chat.id, type: chat.type, username: chat.username, text: m.text };
      });
      console.log(`Diagnostika getUpdates: ${updBody.result.length} záznam(ů):`, JSON.stringify(chats));
      if (updBody.result.length === 0) {
        console.log("Diagnostika: getUpdates je PRÁZDNÉ — tenhle bot (podle tokenu výš) nikdy nedostal žádnou zprávu. Pošli /start na t.me/AT_FX_Analyzer_bot znovu a zkus to hned zas.");
      }
    } else {
      console.log("Diagnostika getUpdates chyba:", JSON.stringify(updBody));
    }
  } catch (e) { console.log("Diagnostika getUpdates selhala:", e.message); }

  const intro = "🧪 <b>Testovací zpráva</b> — takhle bude vypadat ostrý alert, žádný skutečný pohyb skóre:";
  const sample = `📈 <b>${escapeTgHtml("EURUSD")}</b> skóre diff +1.2 → +2.7 (+1.5)\nNový bias: BUY (EUR silnější)`;

  await sendTelegramMessage(token, chatId, intro);
  await sendTelegramMessage(token, chatId, sample);
})();

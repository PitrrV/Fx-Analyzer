// DIAGNOSTIKA (dispatch-only, není součást žádného cronu).
//
// KOLO 1: FXSSI a FXBlue z GH Actions vrací 200; Myfxbook/DailyFX/ForexClientSentiment 403.
// KOLO 2: nalezen funkční veřejný endpoint bez přihlášení —
//         https://c.fxssi.com/api/current-ratio → 200, application/json,
//         agreguje 10 brokerů (myfxbook, oanda, dukascopy, fxblue, IG, XM, …).
// KOLO 3 (tenhle skript): vypsat kompletní strukturu odpovědi, ať se dá napsat parser.
const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://fxssi.com/tools/current-ratio",
  "Origin": "https://fxssi.com",
};

function summarize(v, depth = 0, key = "") {
  const pad = "  ".repeat(depth);
  if (Array.isArray(v)) {
    console.log(`${pad}${key}: Array(${v.length})`);
    if (v.length) summarize(v[0], depth + 1, "[0]");
    return;
  }
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    console.log(`${pad}${key}: Object{${keys.length}} → ${keys.slice(0, 14).join(", ")}${keys.length > 14 ? ", …" : ""}`);
    if (depth < 3) {
      for (const k of keys.slice(0, 3)) summarize(v[k], depth + 1, k);
    }
    return;
  }
  console.log(`${pad}${key}: ${typeof v} = ${JSON.stringify(v)}`);
}

(async () => {
  const url = "https://c.fxssi.com/api/current-ratio";
  console.log("=== FXSSI current-ratio: kompletní struktura ===\n" + url + "\n");
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
  const raw = await r.text();
  console.log(`status=${r.status} ctype=${r.headers.get("content-type")} len=${raw.length}\n`);

  let j;
  try { j = JSON.parse(raw); } catch (e) {
    console.log("⛔ nelze parsovat JSON: " + e.message);
    console.log(raw.slice(0, 2000));
    return;
  }

  console.log("--- STROM ---");
  summarize(j, 0, "root");

  // Detailní pohled na to, kde jsou reálná long/short čísla per pár.
  console.log("\n--- HLEDÁM DATA PER PÁR ---");
  for (const [k, v] of Object.entries(j)) {
    if (!v || typeof v !== "object") continue;
    const keys = Object.keys(v);
    const pairLike = keys.filter((x) => /^[A-Z]{6}$/.test(x) || /^[A-Z]{3}\/[A-Z]{3}$/.test(x));
    if (pairLike.length >= 4) {
      console.log(`\n✅ "${k}" obsahuje ${pairLike.length} párů: ${pairLike.slice(0, 12).join(", ")}`);
      const sample = pairLike.slice(0, 3);
      for (const p of sample) {
        console.log(`\n   ${p} =\n   ${JSON.stringify(v[p]).slice(0, 900)}`);
      }
    }
  }

  console.log("\n\n--- CELÝ JSON (prvních 4500 znaků) ---");
  console.log(raw.slice(0, 4500));
  console.log("\nHotovo.");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

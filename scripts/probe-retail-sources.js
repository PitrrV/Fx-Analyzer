// DIAGNOSTIKA (dispatch-only).
//
// KOLO 1: FXSSI/FXBlue z GH Actions 200; Myfxbook/DailyFX/ForexClientSentiment 403.
// KOLO 2: nalezen veřejný endpoint bez přihlášení https://c.fxssi.com/api/current-ratio
//         (200, JSON, agreguje 10 brokerů včetně myfxbook/oanda/dukascopy/IG/XM).
// KOLO 3: struktura = { pairs: { EURUSD: { <broker>: "62.06", …, average: "…" } }, … }.
// KOLO 4 (tenhle skript): ROZHODNOUT SMĚR — je to číslo long% nebo short%?
//   Korelace FXSSI vs. naše uložená myfxbook data = −0.90 (stejná data, opačná
//   konvence), korelace s CFTC favorizuje "short%". Intuice (retail bývá long zlato)
//   favorizuje "long%". Spor rozhodne přímo FXSSI vykreslovací kód/šablony.
const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

function ctx(text, needle, radius, max) {
  const out = [];
  let i = -1;
  while ((i = text.indexOf(needle, i + 1)) !== -1 && out.length < max) {
    out.push(text.slice(Math.max(0, i - radius), i + needle.length + radius).replace(/\s+/g, " "));
  }
  return out;
}

(async () => {
  const r = await fetch("https://fxssi.com/tools/current-ratio", { headers: UA, signal: AbortSignal.timeout(25000) });
  const t = await r.text();
  console.log(`status=${r.status} len=${t.length}\n`);

  // 1) Šablony — ukážou, jak se hodnota popisuje uživateli.
  console.log("=== ŠABLONY (text/template) ===");
  const tpls = [...t.matchAll(/<script[^>]*type=["']text\/template["'][^>]*id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of tpls.slice(0, 8)) {
    console.log(`\n--- id="${m[1]}" ---`);
    console.log(m[2].replace(/\s+/g, " ").slice(0, 1100));
  }

  // 2) Kde se v JS bere hodnota a jak se mapuje na buy/sell.
  console.log("\n\n=== JS: výskyty buy/sell/long/short u vykreslování ===");
  for (const needle of ["sellers", "buyers", "sell_percent", "buy_percent", "'sell'", '"sell"', "'buy'", '"buy"']) {
    const hits = ctx(t, needle, 200, 3);
    if (hits.length) {
      console.log(`\n--- "${needle}" (${hits.length}×) ---`);
      hits.forEach((h, i) => console.log(`[${i}] …${h}…`));
    }
  }

  // 3) Jak se používá hodnota z api.response (pairs[pair][broker]).
  console.log("\n\n=== JS: použití api.response / pairs hodnot ===");
  for (const needle of ["response['pairs']", 'response["pairs"]', "response.pairs", "['average']", ".average"]) {
    const hits = ctx(t, needle, 260, 3);
    if (hits.length) {
      console.log(`\n--- "${needle}" (${hits.length}×) ---`);
      hits.forEach((h, i) => console.log(`[${i}] …${h}…`));
    }
  }

  console.log("\nHotovo.");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

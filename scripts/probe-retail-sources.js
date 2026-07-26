// DIAGNOSTIKA (dispatch-only). KOLO 5 — finální potvrzení směru FXSSI hodnoty.
//
// Kolo 4 vytáhlo vykreslovací kód:
//   addBroker(id,title,weight,perc){ perc = 100-perc; open=perc; close=100-perc; … }
//   šablona: <div class="buy-text">Buy</div><div class="sell-text">Sell</div>
//            <div class="ratio-bar-left" style="width:{{close}}%">{{close}}%</div>
//            <div class="ratio-bar-right" style="width:{{open}}%">{{open}}%</div>
// Takže: close == RAW hodnota z API, open == 100 − RAW.
// Zbývá jediná neznámá: který pruh (left/right) je Buy. To jednoznačně určí CSS
// pozicování .buy-text/.sell-text a .ratio-bar-left/right → tenhle skript ho vypíše.
const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// Vytáhne CSS pravidla, jejichž selektor obsahuje daný název třídy.
function cssRules(text, cls) {
  const out = [];
  const re = new RegExp("[^{}]*\\." + cls + "[^{}]*\\{[^}]*\\}", "g");
  for (const m of text.matchAll(re)) {
    out.push(m[0].replace(/\s+/g, " ").trim());
    if (out.length >= 6) break;
  }
  return out;
}

(async () => {
  const r = await fetch("https://fxssi.com/tools/current-ratio", { headers: UA, signal: AbortSignal.timeout(25000) });
  const t = await r.text();
  console.log(`status=${r.status} len=${t.length}\n`);

  console.log("=== CSS: orientace popisků a pruhů ===");
  for (const cls of ["buy-text", "sell-text", "ratio-bar-left", "ratio-bar-right", "ratio-bar-divider"]) {
    const rules = cssRules(t, cls);
    console.log(`\n--- .${cls} (${rules.length} pravidel) ---`);
    rules.forEach((x) => console.log("   " + x));
  }

  // Legenda/nápověda u nástroje často říká význam natvrdo.
  console.log("\n\n=== TEXTY: legenda / vysvětlení nástroje ===");
  const plain = t.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  for (const kw of ["blue bar", "orange bar", "left", "right side", "percentage of Buy", "percentage of Sell"]) {
    const i = plain.toLowerCase().indexOf(kw.toLowerCase());
    if (i !== -1) console.log(`\n[${kw}] …${plain.slice(Math.max(0, i - 260), i + 300)}…`);
  }

  console.log("\nHotovo.");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

// DIAGNOSTIKA (dispatch-only, není součást žádného cronu): otestuje dostupnost
// kandidátních zdrojů retail sentimentu PŘÍMO Z GITHUB ACTIONS runneru — což je
// jediné prostředí, kde na tom záleží (sandbox i lokální prohlížeč se chovají jinak,
// viz CFTC .htm 403 vs. Socrata OK, nebo Myfxbook session vázaná na IP).
//
// Pro každý zdroj hlásí: HTTP status, délku odpovědi, jestli to vypadá jako
// Cloudflare/bot blok, jestli HTML obsahuje rovnou long/short procenta (pak stačí
// parsovat, žádné API netřeba) a jaké datové endpointy stránka odkazuje.
const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// Stránky, u kterých chci vědět, jestli je runner vůbec stáhne a co v nich je.
const PAGES = [
  ["FXSSI current-ratio", "https://fxssi.com/tools/current-ratio"],
  ["FXSSI ratios", "https://fxssi.com/tools/ratios"],
  ["Dukascopy SWFX sentiment", "https://www.dukascopy.com/swiss/english/marketwatch/sentiment/"],
  ["DailyFX sentiment (IG)", "https://www.dailyfx.com/sentiment"],
  ["FXBlue sentiment", "https://www.fxblue.com/market-data/tools/sentiment"],
  ["ForexClientSentiment", "https://forexclientsentiment.com/"],
  ["Myfxbook outlook (baseline)", "https://www.myfxbook.com/community/outlook"],
];

// Přímé tipy na datové endpointy (když projdou, je to nejčistší cesta).
const ENDPOINTS = [
  ["Dukascopy freeserv sentiment", "https://freeserv.dukascopy.com/2.0/index.php?path=sentiment/sentiment&instrument=EUR/USD"],
  ["Dukascopy freeserv swfx", "https://freeserv.dukascopy.com/2.0/index.php?path=swfx/sentiment"],
  ["FXBlue sentiment CSV", "https://www.fxblue.com/market-data/tools/sentiment/data"],
  ["DailyFX IG sentiment json", "https://www.dailyfx.com/sentiment-report"],
];

const BLOCK_HINTS = ["cf-browser-verification", "Just a moment", "cf_chl", "Attention Required", "Access denied", "Enable JavaScript and cookies"];

function looksBlocked(t) {
  return BLOCK_HINTS.some((h) => t.includes(h));
}

// Hledá dvojice procent u šestipísmenného páru — příznak, že jsou data přímo v HTML.
function findInlinePairPercents(t) {
  const hits = [];
  const re = /([A-Z]{3}\/?[A-Z]{3})[\s\S]{0,300}?(\d{1,3}(?:\.\d+)?)\s*%[\s\S]{0,300}?(\d{1,3}(?:\.\d+)?)\s*%/g;
  for (const m of t.matchAll(re)) {
    const a = parseFloat(m[2]), b = parseFloat(m[3]);
    if (a + b > 95 && a + b < 105) {
      hits.push(`${m[1]} ${a}/${b}`);
      if (hits.length >= 6) break;
    }
  }
  return hits;
}

// Vytáhne odkazované datové zdroje (api/json/ajax/graphql/freeserv…).
function findDataUrls(t) {
  const out = new Set();
  const re = /["'`(]((?:https?:)?\/\/[^"'`\s)]*(?:api|\.json|ajax|graphql|freeserv|sentiment[^"'`\s)]*data)[^"'`\s)]*)["'`)]/gi;
  for (const m of t.matchAll(re)) {
    const u = m[1];
    if (u.length < 200 && !/\.(png|jpg|svg|css|woff)/i.test(u)) out.add(u);
    if (out.size >= 12) break;
  }
  return [...out];
}

// Hledá vnořená JSON data (__NEXT_DATA__, window.__X = {...}) s náznakem sentimentu.
function findEmbeddedJson(t) {
  const notes = [];
  if (/__NEXT_DATA__/.test(t)) notes.push("__NEXT_DATA__ přítomno");
  if (/longPercentage|shortPercentage/i.test(t)) notes.push("longPercentage/shortPercentage v HTML");
  if (/"long"\s*:\s*\d|"short"\s*:\s*\d/i.test(t)) notes.push('"long"/"short" číselné klíče');
  if (/window\.__(\w+)__?\s*=/.test(t)) notes.push("window.__STATE__ pattern");
  return notes;
}

async function probe(label, url, isEndpoint) {
  const line = `\n── ${label}\n   ${url}`;
  try {
    const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    console.log(line);
    console.log(`   status=${r.status} len=${t.length} ctype=${r.headers.get("content-type") || "?"}`);
    if (looksBlocked(t)) { console.log("   ⛔ vypadá jako Cloudflare/bot blok"); return; }
    if (r.status >= 400) { console.log("   ⛔ HTTP chyba"); return; }

    if (isEndpoint) {
      console.log("   ukázka: " + t.slice(0, 300).replace(/\s+/g, " "));
      return;
    }
    const pct = findInlinePairPercents(t);
    if (pct.length) console.log("   ✅ procenta přímo v HTML: " + pct.join(", "));
    else console.log("   – žádná inline long/short procenta (data se asi dotahují JS)");
    const emb = findEmbeddedJson(t);
    if (emb.length) console.log("   📦 " + emb.join(" · "));
    const urls = findDataUrls(t);
    if (urls.length) console.log("   🔗 odkazované datové URL:\n      " + urls.join("\n      "));
  } catch (e) {
    console.log(line);
    console.log("   ⛔ CHYBA: " + e.message);
  }
}

(async () => {
  console.log("=== STRÁNKY (hledám inline data / odkazy na API) ===");
  for (const [label, url] of PAGES) await probe(label, url, false);
  console.log("\n\n=== PŘÍMÉ ENDPOINTY (tipy) ===");
  for (const [label, url] of ENDPOINTS) await probe(label, url, true);
  console.log("\nHotovo.");
})();

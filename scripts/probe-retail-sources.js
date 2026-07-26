// DIAGNOSTIKA (dispatch-only, není součást žádného cronu): hledá použitelný zdroj
// retail sentimentu PŘÍMO Z GITHUB ACTIONS runneru — jediného prostředí, kde na tom
// záleží (sandbox i prohlížeč se chovají jinak, viz CFTC .htm 403 vs. Socrata OK).
//
// KOLO 1 zjistilo: FXSSI a FXBlue vrací 200 (neblokované), Myfxbook/DailyFX/
// ForexClientSentiment 403 (Cloudflare). FXSSI stránka odkazuje na c.fxssi.com/api/.
// KOLO 2 (tenhle skript) hledá konkrétní datový endpoint za tou subdoménou.
const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function get(url, extraHeaders) {
  const r = await fetch(url, { headers: { ...UA, ...(extraHeaders || {}) }, redirect: "follow", signal: AbortSignal.timeout(25000) });
  const t = await r.text();
  return { status: r.status, ctype: r.headers.get("content-type") || "?", t };
}

// Vypíše okolí každého výskytu jehly — chci vidět, jak se URL skládá v JS.
function showContext(text, needle, radius, max) {
  const out = [];
  let i = -1;
  while ((i = text.indexOf(needle, i + 1)) !== -1 && out.length < max) {
    out.push(text.slice(Math.max(0, i - radius), i + needle.length + radius).replace(/\s+/g, " "));
  }
  return out;
}

async function stage1_fxssiPage() {
  console.log("\n=== 1) FXSSI stránka: kontext kolem c.fxssi.com/api ===");
  const { status, t } = await get("https://fxssi.com/tools/current-ratio");
  console.log(`   status=${status} len=${t.length}`);

  for (const needle of ["c.fxssi.com", "fxssi.com/api"]) {
    const ctx = showContext(t, needle, 220, 6);
    console.log(`\n   --- kontext "${needle}" (${ctx.length} výskytů) ---`);
    ctx.forEach((c, i) => console.log(`   [${i}] …${c}…`));
  }

  // Skripty stránky — v nich bývá skutečné volání API.
  const scripts = [...t.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1])
    .filter((u) => /fxssi|ratio|sentiment|app|main|bundle/i.test(u) && !/google|gtag|analytics|recaptcha/i.test(u));
  console.log(`\n   --- vlastní skripty (${scripts.length}) ---`);
  scripts.slice(0, 15).forEach((s) => console.log("      " + s));
  return scripts;
}

async function stage2_scanScripts(scripts) {
  console.log("\n\n=== 2) Skeny JS souborů na volání API ===");
  for (const src of scripts.slice(0, 10)) {
    const url = src.startsWith("http") ? src : src.startsWith("//") ? "https:" + src : "https://fxssi.com" + (src.startsWith("/") ? "" : "/") + src;
    try {
      const { status, t } = await get(url);
      const hits = [...t.matchAll(/["'`]([^"'`\s]*\/api\/[^"'`\s]*)["'`]/g)].map((m) => m[1]);
      const uniq = [...new Set(hits)].slice(0, 15);
      console.log(`\n   ${url}\n   status=${status} len=${t.length} · api cest: ${uniq.length}`);
      uniq.forEach((h) => console.log("      → " + h));
      if (!uniq.length) {
        const ctx = showContext(t, "c.fxssi", 160, 3);
        ctx.forEach((c) => console.log("      ~ …" + c + "…"));
      }
    } catch (e) {
      console.log(`\n   ${url}\n   ⛔ ${e.message}`);
    }
  }
}

async function stage3_guessEndpoints() {
  console.log("\n\n=== 3) Přímé tipy na FXSSI datové endpointy ===");
  const guesses = [
    "https://c.fxssi.com/api/current-ratio",
    "https://c.fxssi.com/api/current-ratio/data",
    "https://c.fxssi.com/api/ratios",
    "https://c.fxssi.com/api/sentiment",
    "https://c.fxssi.com/api/v1/current-ratio",
    "https://fxssi.com/api/current-ratio",
    "https://fxssi.com/wp-admin/admin-ajax.php?action=current_ratio",
  ];
  for (const url of guesses) {
    try {
      const { status, ctype, t } = await get(url, { "Referer": "https://fxssi.com/tools/current-ratio", "Origin": "https://fxssi.com" });
      console.log(`\n   ${url}\n   status=${status} ctype=${ctype} len=${t.length}`);
      if (status < 400 && t.length) console.log("   ukázka: " + t.slice(0, 400).replace(/\s+/g, " "));
    } catch (e) {
      console.log(`\n   ${url}\n   ⛔ ${e.message}`);
    }
  }
}

async function stage4_dukascopyWithReferer() {
  console.log("\n\n=== 4) Dukascopy freeserv s Referer (403 bez něj) ===");
  const urls = [
    "https://freeserv.dukascopy.com/2.0/index.php?path=sentiment/sentiment&instrument=EUR/USD",
    "https://freeserv.dukascopy.com/2.0/index.php?path=common/instruments",
    "https://freeserv.dukascopy.com/2.0/core.js",
  ];
  for (const url of urls) {
    try {
      const { status, ctype, t } = await get(url, { "Referer": "https://www.dukascopy.com/", "Origin": "https://www.dukascopy.com" });
      console.log(`\n   ${url}\n   status=${status} ctype=${ctype} len=${t.length}`);
      if (status < 400 && t.length) {
        console.log("   ukázka: " + t.slice(0, 300).replace(/\s+/g, " "));
        const hits = [...t.matchAll(/["'`]([^"'`\s]*(?:sentiment|swfx)[^"'`\s]*)["'`]/gi)].map((m) => m[1]);
        [...new Set(hits)].slice(0, 10).forEach((h) => console.log("      → " + h));
      }
    } catch (e) {
      console.log(`\n   ${url}\n   ⛔ ${e.message}`);
    }
  }
}

(async () => {
  const scripts = await stage1_fxssiPage();
  await stage2_scanScripts(scripts);
  await stage3_guessEndpoints();
  await stage4_dukascopyWithReferer();
  console.log("\nHotovo.");
})();

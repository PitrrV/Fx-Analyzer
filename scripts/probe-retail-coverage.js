// PRŮZKUM POKRYTÍ PÁRŮ (dispatch-only, nic nezapisuje).
//
// Otázka: proč /api/current-ratio vrací jen 14 měnových párů a existuje cesta
// ke všem 28 z STANDARD_PAIRS? Testuje se:
//   A) parametry a varianty current-ratio endpointu
//   B) další FXSSI endpointy (/api/ratios — historický, vyžadoval "Unauthorized")
//   C) jestli FXSSI chybějící kříže vůbec sleduje (seznam nástrojů/párů na webu)
//   D) FXBlue jako druhý zdroj, který z GH Actions vrací 200
const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://fxssi.com/tools/current-ratio",
  "Origin": "https://fxssi.com",
};
const CHYBI = ["GBPNZD", "NZDJPY", "EURCAD", "CADJPY", "AUDNZD", "CHFJPY", "GBPAUD", "AUDCAD"];

async function get(url, hdrs) {
  try {
    const r = await fetch(url, { headers: { ...UA, ...(hdrs || {}) }, signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    return { status: r.status, ctype: r.headers.get("content-type") || "?", t };
  } catch (e) { return { status: 0, ctype: "", t: "", err: e.message }; }
}
const short = (t, n = 220) => t.slice(0, n).replace(/\s+/g, " ");

(async () => {
  // ── A) varianty a parametry current-ratio ────────────────────────
  console.log("=== A) Parametry / varianty /api/current-ratio ===");
  const varianty = [
    "https://c.fxssi.com/api/current-ratio",
    "https://c.fxssi.com/api/current-ratio?all=1",
    "https://c.fxssi.com/api/current-ratio?pairs=all",
    "https://c.fxssi.com/api/current-ratio?pair=GBPNZD",
    "https://c.fxssi.com/api/current-ratio?instrument=GBPNZD",
    "https://c.fxssi.com/api/current-ratio?limit=100",
    "https://c.fxssi.com/api/current-ratio/GBPNZD",
    "https://c.fxssi.com/api/v2/current-ratio",
  ];
  for (const u of varianty) {
    const { status, ctype, t, err } = await get(u);
    let info = "";
    try {
      const j = JSON.parse(t);
      const n = j.pairs ? Object.keys(j.pairs).length : 0;
      const má = CHYBI.filter((p) => j.pairs && j.pairs[p]);
      info = `párů=${n}${má.length ? " · MÁ CHYBĚJÍCÍ: " + má.join(",") : ""}`;
    } catch (e) { info = err ? "ERR " + err : short(t, 110); }
    console.log(`  ${status} ${u.replace("https://c.fxssi.com", "")}\n      ${info}`);
  }

  // ── B) historický endpoint /api/ratios ───────────────────────────
  console.log("\n=== B) /api/ratios (historický) — zná chybějící kříže? ===");
  for (const p of ["EURUSD", "GBPNZD", "NZDJPY", "EURCAD"]) {
    const { status, t } = await get(`https://c.fxssi.com/api/ratios?pair=${p}`);
    let info = short(t, 200);
    try {
      const j = JSON.parse(t);
      info = `status_text=${j.status_text} · currency_pair=${j.currency_pair} · instrument=${j.instrument} · má data=${!!(j.brokers || j.data)}`;
    } catch (e) {}
    console.log(`  ${status} pair=${p}\n      ${info}`);
  }

  // ── C) sleduje FXSSI ty kříže vůbec? ─────────────────────────────
  console.log("\n=== C) Seznam párů, které FXSSI nabízí (stránka nástroje) ===");
  const { status: st, t: html } = await get("https://fxssi.com/tools/ratios", { Accept: "text/html" });
  console.log(`  stránka /tools/ratios status=${st} len=${html.length}`);
  const nalezene = new Set();
  for (const m of html.matchAll(/[?&]pair=([A-Z]{6})/g)) nalezene.add(m[1]);
  for (const m of html.matchAll(/"([A-Z]{3}\/[A-Z]{3})"/g)) nalezene.add(m[1].replace("/", ""));
  const seznam = [...nalezene].sort();
  console.log(`  nalezeno symbolů v HTML: ${seznam.length}`);
  console.log("  " + seznam.join(" "));
  const chybiTam = CHYBI.filter((p) => nalezene.has(p));
  console.log(`  z našich chybějících křížů se na webu vyskytuje: ${chybiTam.length ? chybiTam.join(", ") : "ŽÁDNÝ"}`);

  // ── D) FXBlue jako druhý zdroj ───────────────────────────────────
  console.log("\n=== D) FXBlue — hledám datový endpoint ===");
  const fb = [
    "https://www.fxblue.com/market-data/tools/sentiment",
    "https://www.fxblue.com/Sentiment/GetData",
    "https://www.fxblue.com/market-data/api/sentiment",
    "https://www.fxblue.com/apps/sentiment/data",
  ];
  for (const u of fb) {
    const { status, ctype, t, err } = await get(u, { Accept: "text/html,application/json" });
    console.log(`  ${status} ${ctype.split(";")[0]} len=${t.length} ${u}${err ? " ERR " + err : ""}`);
    if (status === 200 && /sentiment|ratio|long|short/i.test(t) && t.length < 200000) {
      const urls = new Set();
      for (const m of t.matchAll(/["'`]([^"'`\s]*(?:GetData|\.json|api\/[^"'`\s]*)[^"'`\s]*)["'`]/gi)) {
        if (m[1].length < 160) urls.add(m[1]);
      }
      [...urls].slice(0, 12).forEach((x) => console.log("      → " + x));
    }
  }

  console.log("\nHotovo.");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

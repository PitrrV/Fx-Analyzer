// US100 (Nasdaq-100) — retail sentiment, samostatný pipeline nezávislý na FX
// (fetch-retail.js zůstává beze změny). Píše data/us100_retail.json, které si
// appka stahuje do VLASTNÍHO localStorage klíče (us100_retail_hist) — viz
// fetchActionUS100Retail() v engine.js. Nikdy nezapisuje do
// data/retail_hist.json.
//
// Zdroj: FXSSI Current Ratio (veřejné, bez klíče — appka ho už používá jako
// zálohu pro FX). Ověřeno živě (probe-gold-us100.js): symbol "NAS100" existuje
// v odpovědi vedle 28 FX párů, jen ho fetch-retail.js dnes zahazuje (filtruje
// jen přesně 6 velkých písmen, "NAS100" má číslice) — tenhle skript ten filtr
// nemá, protože cílí přímo na jeden konkrétní symbol.
const fs = require("fs");

const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://fxssi.com/tools/current-ratio",
};

async function fetchRetail() {
  const r = await fetch("https://c.fxssi.com/api/current-ratio", { headers: UA, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error("FXSSI HTTP " + r.status);
  const j = await r.json();
  const d = j && j.pairs && j.pairs.NAS100;
  if (!d) throw new Error("FXSSI: symbol NAS100 nenalezen v odpovědi");
  let long = parseFloat(d.average);
  if (!Number.isFinite(long)) {
    const vals = Object.entries(d).filter(([k]) => k !== "average" && k !== "oip").map(([, v]) => parseFloat(v)).filter(Number.isFinite);
    if (!vals.length) throw new Error("FXSSI: NAS100 bez použitelných hodnot");
    long = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  if (!(long >= 0 && long <= 100)) throw new Error("FXSSI: NAS100 long% mimo rozsah (" + long + ")");
  return { l: Math.round(long), s: Math.round(100 - long) };
}

(async () => {
  let retail;
  try {
    retail = await fetchRetail();
    console.log("Retail OK · long", retail.l, "% / short", retail.s, "%");
  } catch (e) {
    // Recoverable — existující data/us100_retail.json zůstává nedotčené,
    // další běh (za 30 min) to zkusí znovu. Exit 0, ať to negeneruje failure
    // e-maily za dočasný výpadek FXSSI.
    console.warn("Retail fetch selhal, nezapisuju:", e.message);
    process.exit(0);
  }

  let store = { updated: "", symbol: "NAS100", points: [] };
  try { store = JSON.parse(fs.readFileSync("data/us100_retail.json", "utf8")); } catch (e) {}
  if (!Array.isArray(store.points)) store.points = [];

  // Anti-inverze proti předchozímu bodu — retail pozicování je setrvačné,
  // silná záporná korelace (=zrcadlový obrat) mezi dvěma běhy (30 min) by
  // znamenala prohozené long/short, ne skutečný pohyb trhu.
  const prev = store.points.length ? store.points[store.points.length - 1] : null;
  if (prev && Number.isFinite(prev.l) && Math.abs((100 - prev.l) - retail.l) < Math.abs(prev.l - retail.l) - 40) {
    console.error("VALIDACE SELHALA — nový bod (l=" + retail.l + ") vypadá jako zrcadlový obrat proti předchozímu (l=" + prev.l + "), nezapisuju.");
    process.exit(1);
  }

  store.points.push({ t: new Date().toISOString(), l: retail.l, s: retail.s });
  store.points = store.points.slice(-1100); // ~45 dní bodů po 30 min, stejná retence jako data/retail_hist.json
  store.symbol = "NAS100";
  store.updated = new Date().toISOString();

  fs.writeFileSync("data/us100_retail.json", JSON.stringify(store));
  console.log("Zapsáno data/us100_retail.json · bodů:", store.points.length);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

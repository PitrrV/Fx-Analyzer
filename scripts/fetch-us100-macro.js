// US100 (Nasdaq-100) — makro komponenty (výnosy, dolar, sazby) pro fundamentální
// směr, samostatný pipeline nezávislý na FX (žádný existující fetch skript se
// nemění). Píše data/us100_macro.json — NIKDY nezasahuje do jiných data/*.json.
//
// Zdroj: FRED fredgraph.csv, bez API klíče — appka STEJNÝ zdroj a STEJNÝ
// parsovací vzorec už ověřeně používá pro VIX (fetch-vix.js) a v research
// reportu (fetch-research-data.js), takže nejde o nový/neověřený zdroj.
//
//   DGS10    = 10letý výnos amerických dluhopisů (denně) — klesající trend je
//              historicky bullish pro Nasdaq-100 (nižší diskontní sazba zvedá
//              ocenění growth/tech firem, kterých je index plný)
//   DTWEXBGS = Broad Dollar Index (denně) — přímé měřítko síly dolaru z trhu
//              (na rozdíl od syntetického USD skóre appky, které je z
//              fundamentálních dat/kalendáře)
//   DFF      = efektivní Fed funds rate (denně) — přímý pohled na měnovou
//              politiku, doplňuje výnosy
const fs = require("fs");

const SERIES = { dgs10: "DGS10", dxy: "DTWEXBGS", fedfunds: "DFF" };

async function fetchFredSeries(id) {
  const r = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=" + id, {
    signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!r.ok) throw new Error("FRED " + id + " HTTP " + r.status);
  const text = await r.text();
  const lines = text.trim().split("\n").slice(1); // přeskočit hlavičku "observation_date,<id>"
  const rows = [];
  for (const line of lines) {
    const [date, raw] = line.split(",");
    const value = parseFloat(raw);
    if (date && Number.isFinite(value)) rows.push({ date, value }); // FRED píše "." pro chybějící dny (svátky) — parseFloat(".")=NaN, přeskočí se samo
  }
  if (rows.length < 25) throw new Error("FRED " + id + ": málo dat (" + rows.length + " bodů)");
  return rows; // chronologicky vzestupně
}

// Změna za posledních ~20 obchodních dní (měsíční trend, ne denní šum) —
// stejná logika jako appka používá pro 5denní VIX změnu, jen delší okno,
// protože výnosy/dolar/sazby se hýbou pomaleji než volatilita.
function trend20d(rows) {
  const latest = rows[rows.length - 1];
  const ref = rows[rows.length - 21] || rows[0];
  return { value: latest.value, chg20d: Math.round((latest.value - ref.value) * 1000) / 1000, asOf: latest.date };
}

(async () => {
  const out = { updated: "", dgs10: null, dxy: null, fedfunds: null };
  const failures = [];
  for (const [key, id] of Object.entries(SERIES)) {
    try {
      const rows = await fetchFredSeries(id);
      out[key] = trend20d(rows);
      console.log(key + " (" + id + ") OK · " + out[key].value + " · 20d " + (out[key].chg20d >= 0 ? "+" : "") + out[key].chg20d);
    } catch (e) {
      failures.push(key + ": " + e.message);
      console.log(key + " (" + id + ") selhal:", e.message);
    }
  }

  if (!out.dgs10 && !out.dxy && !out.fedfunds) {
    // Recoverable — existující data/us100_macro.json zůstává nedotčené, další
    // běh to zkusí znovu. Exit 0, ať to negeneruje failure e-maily za
    // dočasný výpadek FRED.
    console.warn("Všechny FRED série selhaly, nezapisuju:", failures.join("; "));
    process.exit(0);
  }

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync("data/us100_macro.json", "utf8")); } catch (e) {}
  const same = prev && JSON.stringify({ dgs10: prev.dgs10, dxy: prev.dxy, fedfunds: prev.fedfunds }) === JSON.stringify({ dgs10: out.dgs10, dxy: out.dxy, fedfunds: out.fedfunds });
  if (same) { console.log("Beze změny, nepřepisuji."); process.exit(0); }

  out.updated = new Date().toISOString();
  fs.writeFileSync("data/us100_macro.json", JSON.stringify(out));
  console.log("Zapsáno data/us100_macro.json" + (failures.length ? " (částečně, selhalo: " + failures.join("; ") + ")" : ""));
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

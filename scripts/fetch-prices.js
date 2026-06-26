// FX ceny — GitHub Action stahuje denní referenční kurzy (bez API klíče).
// Primárně frankfurter.app (ECB), fallback open.er-api.com. Píše data/prices.json:
//   { updated, source, base:"USD", rates:{USD:1,EUR:..,JPY:..}, hist:[{d,rates}] }
// rates = kolik dané měny za 1 USD. Cenu páru engine počítá jako rates[quote]/rates[base].
// Denní historie (1 záznam/den) slouží k výpočtu price-momentum potvrzovací vrstvy.
const fs = require("fs");
const CUR = ["EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"]; // vs USD

async function getRates() {
  // 1) frankfurter (ECB, bez klíče)
  try {
    const r = await fetch("https://api.frankfurter.app/latest?from=USD&to=" + CUR.join(","), { signal: AbortSignal.timeout(15000) });
    if (r.ok) { const j = await r.json(); if (j && j.rates && Object.keys(j.rates).length >= 6) return { src: "frankfurter", rates: j.rates }; }
  } catch (e) { console.log("frankfurter ERR", e.message); }
  // 2) open.er-api (bez klíče)
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(15000) });
    if (r.ok) { const j = await r.json(); if (j && j.rates) { const o = {}; CUR.forEach(c => { if (j.rates[c] != null) o[c] = j.rates[c]; }); if (Object.keys(o).length >= 6) return { src: "er-api", rates: o }; } }
  } catch (e) { console.log("er-api ERR", e.message); }
  throw new Error("žádný zdroj cen nedostupný");
}

(async () => {
  const { src, rates } = await getRates();
  const full = { USD: 1 };
  CUR.forEach(c => { if (rates[c] != null && isFinite(rates[c])) full[c] = rates[c]; });
  if (Object.keys(full).length < 7) throw new Error("neúplné kurzy: " + Object.keys(full).join(","));

  let prev = { hist: [] };
  try { prev = JSON.parse(fs.readFileSync("data/prices.json", "utf8")); } catch (e) {}
  const prevRates = prev.rates || {};
  const same = Object.keys(full).length === Object.keys(prevRates).length &&
    Object.keys(full).every(k => Math.abs((prevRates[k] || 0) - full[k]) < 1e-9);
  if (same) { console.log("Kurzy beze změny, nepřepisuji."); process.exit(0); }

  const today = new Date().toISOString().slice(0, 10);
  const hist = (Array.isArray(prev.hist) ? prev.hist : []).filter(h => h && h.d !== today);
  hist.push({ d: today, rates: full });
  const trimmed = hist.slice(-150);

  const out = { updated: new Date().toISOString(), source: src, base: "USD", rates: full, hist: trimmed };
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/prices.json", JSON.stringify(out));
  console.log("OK", src, "· měn:", Object.keys(full).length, "· hist:", trimmed.length);
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });

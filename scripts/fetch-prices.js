// FX ceny — GitHub Action stahuje živé kurzy (bez API klíče). Píše data/prices.json:
//   { updated, source, base:"USD", rates:{USD:1,EUR:..,JPY:..}, hist:[{d,rates}] }
// rates = kolik dané měny za 1 USD. Cenu páru engine počítá jako rates[quote]/rates[base].
// Denní historie (1 záznam/den) slouží k výpočtu price-momentum potvrzovací vrstvy.
//
// PŮVODNĚ primárně frankfurter.app (ECB) — ZAMĚNĚNO 17.9.2026, protože ECB
// referenční kurz se publikuje JEN JEDNOU DENNĚ (odpoledne). Appka na 15min
// cronu tak většinu dne správně hlásila "Kurzy beze změny" — nebyl to bug,
// jen špatná volba zdroje pro appku, co chce živé ceny (zpětná vazba "ceny
// jsou 17h staré"). Yahoo Finance je živý, tikový zdroj — appka ho už dřív
// ověřila jako spolehlivý pro GH Actions IP (fetch-oil.js, fetch-gold-price.js
// ho používají celou dobu bez výpadku). Frankfurter/er-api zůstávají jako
// záložní zdroj, kdyby Yahoo zrovna vypadl.
const fs = require("fs");
const CUR = ["EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"]; // vs USD

// Standardní FX konvence: EUR/GBP/AUD/NZD kotují jako "cizí měna za 1 USD"
// obráceně (Yahoo "EURUSD=X" dává USD za 1 EUR, proto invertovat), zatímco
// JPY/CAD/CHF kotují přímo jako "USDJPY=X" apod. (stejná konvence appka už
// používá napříč STANDARD_PAIRS v engine.js).
const YAHOO_INVERT = new Set(["EUR", "GBP", "AUD", "NZD"]);
function yahooSymbol(c) { return YAHOO_INVERT.has(c) ? c + "USD=X" : "USD" + c + "=X"; }

async function fromYahoo() {
  const rates = {};
  for (const c of CUR) {
    const sym = yahooSymbol(c);
    const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/" + sym + "?range=1d&interval=1m", {
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });
    if (!r.ok) throw new Error("yahoo " + sym + " HTTP " + r.status);
    const j = await r.json();
    const price = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta && j.chart.result[0].meta.regularMarketPrice;
    if (price == null || !isFinite(price)) throw new Error("yahoo " + sym + ": žádná cena");
    rates[c] = YAHOO_INVERT.has(c) ? 1 / price : price;
    await new Promise((res) => setTimeout(res, 150)); // zdvořilé zpoždění mezi 7 dotazy
  }
  return { src: "yahoo", rates };
}

async function getRates() {
  // 1) Yahoo Finance — živé tikové kurzy (primární, viz komentář nahoře)
  try { return await fromYahoo(); } catch (e) { console.log("yahoo ERR", e.message); }
  // 2) frankfurter (ECB, denní referenční kurz) — záložní
  try {
    const r = await fetch("https://api.frankfurter.app/latest?from=USD&to=" + CUR.join(","), { signal: AbortSignal.timeout(15000) });
    if (r.ok) { const j = await r.json(); if (j && j.rates && Object.keys(j.rates).length >= 6) return { src: "frankfurter", rates: j.rates }; }
  } catch (e) { console.log("frankfurter ERR", e.message); }
  // 3) open.er-api (denní) — poslední záchranná síť
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

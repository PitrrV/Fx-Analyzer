// AUDIT INTEGRITY RETAIL SENTIMENTU (dispatch-only, nic nezapisuje).
//
// Ověřuje celý datový tok LONG/SHORT: ZDROJ (FXSSI) → DATABÁZE (data/retail_hist.json)
// → ANALYZER (engine.js scoreCurrency/getSentimentScore), a to na živých datech.
// Vznikl po incidentu, kdy poziční parser prohodil long/short a retail data byla
// 30 dní obrácená (22.6.–23.7.2026).
//
// Spouští se ručně přes .github/workflows/probe-retail.yml.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const FXSSI_URL = "https://c.fxssi.com/api/current-ratio";
const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://fxssi.com/tools/current-ratio",
};
const CUR = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
const VZORKY = ["EURUSD", "AUDUSD", "USDJPY", "GBPUSD", "AUDJPY", "EURJPY"];

let fail = 0;
const check = (ok, label, detail) => {
  if (!ok) fail++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? " · " + detail : ""}`);
};

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const sx = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0));
  const sy = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));
  return cov / (sx * sy);
}

(async () => {
  // ── 1. ZDROJ ──────────────────────────────────────────────────────
  console.log("=== 1) ZDROJ: FXSSI current-ratio (živě) ===");
  const r = await fetch(FXSSI_URL, { headers: UA, signal: AbortSignal.timeout(25000) });
  const src = await r.json();
  console.log(`  HTTP ${r.status} · párů: ${Object.keys(src.pairs || {}).length} · brokerů: ${Object.keys(src.broker_titles || {}).length}`);
  console.log(`  server_time: ${src.server_time_text || src.server_time || "?"}`);

  // ── 2. KONZISTENCE DEFINICE LONG/SHORT NAPŘÍČ BROKERY ─────────────
  // Kdyby některý broker používal opačnou definici, jeho sloupec by proti
  // ostatním ANTIkoreloval. Test: korelace každého brokera vs. `average`.
  console.log("\n=== 2) Používají všichni brokeři STEJNOU definici LONG? ===");
  console.log("  (korelace sloupce brokera vs. `average` přes společné páry;");
  console.log("   obrácený broker by dal výrazně ZÁPORNOU korelaci)");
  const brokers = Object.keys(src.broker_titles || {});
  for (const b of brokers) {
    const xs = [], ys = [];
    for (const [pair, cols] of Object.entries(src.pairs || {})) {
      const v = parseFloat(cols[b]), avg = parseFloat(cols.average);
      if (Number.isFinite(v) && Number.isFinite(avg)) { xs.push(v); ys.push(avg); }
    }
    const rho = pearson(xs, ys);
    const label = `${(src.broker_titles[b] || b).padEnd(10)} n=${String(xs.length).padStart(2)}  r=${Number.isFinite(rho) ? rho.toFixed(3) : "n/a"}`;
    if (!Number.isFinite(rho)) { console.log(`  ⚠  ${label} (v tomto snímku nejsou společné páry)`); continue; }
    // Práh záměrně na ZÁPORNÉ straně: hledá se PODPIS INVERZE, ne „síla souhlasu".
    // Malý broker s hrubě zaokrouhlenými hodnotami (FiboGroup uvádí celá procenta)
    // a n≈12 dá klidně r≈0.3, aniž by s definicí LONG bylo cokoliv v nepořádku —
    // dřívější práh 0.3 tohle označil za chybu falešně. Obrácená definice se
    // projeví silnou ANTIkorelací, protože ostatní brokeři měří tentýž trh.
    if (rho < -0.2) check(false, label, "PODEZŘENÍ NA OBRÁCENOU DEFINICI LONG");
    else if (rho < 0.3) console.log(`  ⚠  ${label} (slabá, ale kladná shoda — malý vzorek/hrubé zaokrouhlení)`);
    else check(true, label);
  }

  // ── 3. ZDROJ → DATABÁZE ───────────────────────────────────────────
  // Přesně stejná transformace jako ve fetch-retail.js.
  console.log("\n=== 3) ZDROJ → DATABÁZE (mapování long/short) ===");
  const db = JSON.parse(fs.readFileSync(path.join(ROOT, "data/retail_hist.json"), "utf8"));
  const last = db.points[db.points.length - 1];
  console.log(`  poslední bod DB: ${last.t} · zdroj: ${last.source}`);
  console.log(`\n  ${"pár".padEnd(8)} ${"ZDROJ avg".padStart(10)} ${"DB long".padStart(8)} ${"DB short".padStart(9)} ${"l+s".padStart(5)}`);
  for (const p of VZORKY) {
    const sv = parseFloat((src.pairs[p] || {}).average);
    const d = (last.pairs || {})[p];
    if (!Number.isFinite(sv) || !d) { console.log(`  ${p.padEnd(8)} — v jednom ze zdrojů chybí`); continue; }
    console.log(`  ${p.padEnd(8)} ${sv.toFixed(2).padStart(10)} ${String(d.l).padStart(8)} ${String(d.s).padStart(9)} ${String(d.l + d.s).padStart(5)}`);
    check(d.l + d.s === 100, `${p}: long+short = 100`);
    // DB bod je z dřívějšího běhu cronu, takže povolím drift; jde o to, že
    // NENÍ obrácený (|l − avg| musí být mnohem menší než |(100−l) − avg|).
    const dLong = Math.abs(d.l - sv), dInv = Math.abs(100 - d.l - sv);
    check(dLong <= dInv, `${p}: DB long odpovídá zdroji, ne jeho převrácení`, `|Δ|=${dLong.toFixed(1)} vs převrácené ${dInv.toFixed(1)}`);
  }

  // ── 4. DATABÁZE → ANALYZER ────────────────────────────────────────
  console.log("\n=== 4) DATABÁZE → ANALYZER (engine.js) ===");
  const store = {};
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const E = new Function("window", "localStorage",
    fs.readFileSync(path.join(ROOT, "engine.js"), "utf8") + "\n;return {getSentimentScore};")({}, ls);

  // per-měnový průměr přesně jako fetch-retail.js
  const sum = {}, cnt = {};
  for (const [pair, d] of Object.entries(last.pairs || {})) {
    const b = pair.slice(0, 3), q = pair.slice(3, 6);
    if (!CUR.includes(b) || !CUR.includes(q)) continue;
    sum[b] = (sum[b] || 0) + d.l; cnt[b] = (cnt[b] || 0) + 1;
    sum[q] = (sum[q] || 0) + (100 - d.l); cnt[q] = (cnt[q] || 0) + 1;
  }
  console.log(`  ${"měna".padEnd(5)} ${"DB ccy".padStart(7)} ${"přepočet".padStart(9)} ${"sent skóre".padStart(11)}  směr`);
  for (const c of CUR) {
    const recomputed = cnt[c] ? Math.round(sum[c] / cnt[c]) : 50;
    const stored = last.ccy[c];
    const s = E.getSentimentScore(c, last.ccy);
    const dir = s > 0 ? "BULLISH (dav short)" : s < 0 ? "BEARISH (dav long)" : "neutrál";
    console.log(`  ${c.padEnd(5)} ${String(stored).padStart(7)} ${String(recomputed).padStart(9)} ${String(s).padStart(11)}  ${dir}`);
    check(stored === recomputed, `${c}: ccy v DB == přepočet z pairs`);
    // kontrariánský směr musí sedět na uloženou hodnotu
    const expect = stored >= 70 ? -1 : stored <= 30 ? 1 : 0;
    check(Math.sign(s) === expect, `${c}: kontrariánský směr sedí na retail ${stored}%`);
  }

  console.log("\n" + (fail === 0 ? "✅ VŠECHNY KONTROLY PROŠLY" : `❌ NEPROŠLO KONTROL: ${fail}`));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

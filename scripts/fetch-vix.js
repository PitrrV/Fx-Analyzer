// VIX (CBOE Volatility Index) — přesnější zdroj pro risk-on/risk-off než dosavadní
// AUDJPY/NZDJPY cenové momentum (viz computeAutoRiskSentiment v engine.js, který
// tenhle soubor bere jako PRIMÁRNÍ zdroj a na momentum padá zpět jen když VIX data
// chybí/jsou stará). Historie + 5denní změna z FRED (VIXCLS, denní close, bez
// klíče) — poslední hodnotu ale přepisujeme ŽIVOU cenou z CBOE (burza sama, žádný
// klíč) s fallbackem na Yahoo Finance, protože FRED VIXCLS je jen denní závěrka se
// zpožděním 1-2 dny. Stejný princip a stejné zdroje/prahy jako sesterská appka
// Fundamet-app (scripts/market-regime.mjs) — tam živě ověřeno (31.7.2026), že FRED
// uměl ukazovat 20,66 (zpožděná hodnota z 29.7.) zatímco živý trh byl na 17,09.
// Píše data/vix.json:
//   { updated, vix, vix5dChange, regime: "RISK_ON"|"NEUTRAL"|"RISK_OFF", liveSource }
const fs = require("fs");

async function fetchFredVix() {
  const r = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS", {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!r.ok) throw new Error("FRED HTTP " + r.status);
  const text = await r.text();
  const lines = text.trim().split("\n").slice(1); // přeskočit hlavičku "observation_date,VIXCLS"
  const rows = [];
  for (const line of lines) {
    const [date, raw] = line.split(",");
    const value = parseFloat(raw);
    if (date && Number.isFinite(value)) rows.push({ date, value });
  }
  if (rows.length < 6) throw new Error("FRED VIXCLS: málo dat (" + rows.length + " bodů)");
  return rows; // chronologicky vzestupně
}

// Zkouší CBOE (burza, žádný klíč), pak Yahoo Finance. První úspěch vyhrává; když
// selžou oba, volající prostě zůstane u FRED denní hodnoty (žádný tvrdý pád).
async function fetchLiveVix() {
  try {
    const r = await fetch("https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json", {
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (r.ok) {
      const j = await r.json();
      const p = j && j.data && j.data.current_price;
      if (typeof p === "number") return p;
    }
  } catch (e) { console.log("CBOE ERR", e.message); }
  try {
    const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d", {
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (r.ok) {
      const j = await r.json();
      const p = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta && j.chart.result[0].meta.regularMarketPrice;
      if (typeof p === "number") return p;
    }
  } catch (e) { console.log("Yahoo ERR", e.message); }
  return null;
}

// VIX úroveň + 5denní změna → risk-on/neutral/risk-off. Prahy jsou tržní konvence
// (<15 klid, >20 zvýšené obavy), NE zpětně testované — stejný princip jako zbytek
// enginu (viz classifyRegime ve Fundamet-app/scripts/market-regime.mjs).
function classifyRegime(rows) {
  const latest = rows[rows.length - 1];
  const fiveDaysAgo = rows[rows.length - 6];
  const change5d = latest.value - fiveDaysAgo.value;
  const pctChange5d = fiveDaysAgo.value > 0 ? (change5d / fiveDaysAgo.value) * 100 : 0;
  let regime = "NEUTRAL";
  if (latest.value > 20 || pctChange5d > 15) regime = "RISK_OFF";
  else if (latest.value < 15 && pctChange5d < 5) regime = "RISK_ON";
  return {
    vix: Math.round(latest.value * 100) / 100,
    vix5dChange: Math.round(change5d * 100) / 100,
    regime,
  };
}

(async () => {
  const rows = await fetchFredVix();
  const liveVix = await fetchLiveVix();
  if (liveVix !== null) {
    const today = new Date().toISOString().slice(0, 10);
    const last = rows[rows.length - 1];
    if (last.date === today) last.value = liveVix;
    else rows.push({ date: today, value: liveVix });
  }
  const { vix, vix5dChange, regime } = classifyRegime(rows);

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync("data/vix.json", "utf8")); } catch (e) {}
  if (prev && prev.vix === vix && prev.vix5dChange === vix5dChange && prev.regime === regime) {
    console.log("VIX beze změny (" + vix + ", " + regime + "), nepřepisuji.");
    process.exit(0);
  }

  const out = {
    updated: new Date().toISOString(),
    vix,
    vix5dChange,
    regime,
    liveSource: liveVix !== null ? "cboe/yahoo" : "fred-only",
  };
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/vix.json", JSON.stringify(out));
  console.log("OK · VIX " + vix + " (5d " + (vix5dChange >= 0 ? "+" : "") + vix5dChange + ") · " + regime + " · zdroj " + out.liveSource);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

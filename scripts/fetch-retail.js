// Retail sentiment — hodinový/půlhodinový snímek na server.
// PŘÍSTUP 1: CFTC Non-reportable positions (oficiální, .gov, žádná Cloudflare blokace) —
// stejný primární zdroj a stejný parser jako klientský fetchRetailSentiment() v engine.js
// (parseNonReportableFromCOT). Malí spekulanti z CFTC TFF = reálný retail proxy, per měna
// (ne per pár — CFTC reportuje na úrovni měnového futures kontraktu). Aktualizuje se týdně
// (páteční CFTC report), ne intradenně — ale je spolehlivý a appka ho i tak preferuje.
// PŘÍSTUP 2 (fallback): Myfxbook Community Outlook přes „čtecí" proxy — per pár, intradenní,
// ale v posledních dnech blokovaný na všech proxy (Cloudflare zpřísnění na straně Myfxbook).
// Ponecháno jako druhotný zdroj pro jemnější/intradenní obohacení, když je dostupný.
// Výstup: data/retail_hist.json = { updated, points:[ {t, pairs:{EURUSD:{l,s}}, ccy:{USD:..}, source } ] }
const fs = require("fs");
const CUR = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" };

// ── CFTC Non-reportable (primární) ──────────────────────────────────
const COT_MARKETS = {
  EUR: "EURO FX", GBP: "BRITISH POUND", JPY: "JAPANESE YEN", AUD: "AUSTRALIAN DOLLAR",
  CAD: "CANADIAN DOLLAR", CHF: "SWISS FRANC", NZD: "NZ DOLLAR",
};
const CFTC_TXT_URL = "https://www.cftc.gov/dea/futures/financial_lf.htm";

function parseNums(line) { return (line.match(/-?\d[\d,]*/g) || []).map((x) => parseInt(x.replace(/,/g, ""), 10)); }

// Stejná fixed-position logika jako parseNonReportableFromCOT() v engine.js:
// TFF report řádek "Positions" má 14 čísel: [0-2]=Dealer, [3-5]=Asset Mgr, [6-8]=Lev.Funds,
// [9-11]=Other Rep., [12-13]=NonReportable (Long,Short) — malí spekulanti = retail proxy.
function parseNonReportableFromCOT(txt) {
  const lines = txt.split(/\r?\n/);
  const out = {};
  for (const [ccy, market] of Object.entries(COT_MARKETS)) {
    const idx = lines.findIndex((l) => l.toUpperCase().includes(market) && l.toUpperCase().includes("CHICAGO MERCANTILE EXCHANGE"));
    if (idx < 0) continue;
    const posIdx = lines.findIndex((l, i) => i > idx && i < idx + 14 && l.trim().toLowerCase() === "positions");
    if (posIdx < 0) continue;
    let n = [];
    for (let j = posIdx + 1; j < Math.min(lines.length, posIdx + 8); j++) {
      const nums = parseNums(lines[j]);
      if (nums.length >= 14) { n = nums; break; }
    }
    if (n.length < 14) continue;
    const nrLong = n[12], nrShort = n[13];
    if (nrLong > 0 || nrShort > 0) {
      const total = nrLong + nrShort;
      out[ccy] = total > 0 ? Math.round((nrLong / total) * 100) : 50;
    }
  }
  const vals = Object.values(out).filter((v) => typeof v === "number");
  if (vals.length >= 3) out.USD = Math.round(100 - vals.reduce((a, b) => a + b, 0) / vals.length);
  return Object.keys(out).length >= 4 ? out : null;
}

// Stejný vzor jako fetchTextWithFallback() v engine.js: přímý fetch napřed (server nemá
// CORS problém a CFTC .gov nemá Cloudflare jako Myfxbook), proxy jen jako záloha.
async function fetchTextWithFallback(url) {
  const urls = [url, "https://r.jina.ai/" + url, "https://api.allorigins.win/raw?url=" + encodeURIComponent(url), "https://corsproxy.io/?url=" + encodeURIComponent(url)];
  let lastErr = null;
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: UA, cache: "no-store" });
      console.log(`CFTC txt ${u.slice(0, 45)}… status=${r.status}`);
      if (r.ok) {
        const t = await r.text();
        if (t && t.includes("Positions") && (t.includes("EURO FX") || t.includes("CANADIAN DOLLAR"))) return t;
        lastErr = new Error("stažený text neobsahuje očekávaná data");
      } else lastErr = new Error("HTTP " + r.status);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("CFTC text fetch selhal");
}

async function fetchCftcNonReportable() {
  const txt = await fetchTextWithFallback(CFTC_TXT_URL);
  const parsed = parseNonReportableFromCOT(txt);
  if (!parsed) throw new Error("parseNonReportableFromCOT nevrátil dost měn");
  return parsed;
}

// ── Myfxbook (sekundární, intradenní obohacení, když je dostupný) ──────
const MYFX = "https://www.myfxbook.com/community/outlook";
const MYFX_PROXIES = [
  "https://r.jina.ai/" + MYFX,
  "https://api.allorigins.win/raw?url=" + encodeURIComponent(MYFX),
  "https://corsproxy.io/?url=" + encodeURIComponent(MYFX),
  "https://thingproxy.freeboard.io/fetch/" + MYFX,
];

function parseMyfxPairs(html) {
  const out = {};
  const pats = [
    /"symbol"\s*:\s*"([A-Z]{6})"[^}]*?"longPercentage"\s*:\s*([\d.]+)[^}]*?"shortPercentage"\s*:\s*([\d.]+)/g,
    /"symbol"\s*:\s*"([A-Z]{6})"[^}]*?"shortPercentage"\s*:\s*([\d.]+)[^}]*?"longPercentage"\s*:\s*([\d.]+)/g,
  ];
  for (const [i, p] of pats.entries()) {
    for (const m of html.matchAll(p)) {
      const sym = m[1];
      const l = parseFloat(i === 1 ? m[3] : m[2]);
      const s = parseFloat(i === 1 ? m[2] : m[3]);
      if (isFinite(l) && isFinite(s) && l + s > 90 && l + s < 110) out[sym] = { l: Math.round(l), s: Math.round(s) };
    }
    if (Object.keys(out).length >= 4) return out;
  }
  const nd = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nd) {
    try {
      const str = JSON.stringify(JSON.parse(nd[1]));
      for (const m of str.matchAll(/"symbol"\s*:\s*"([A-Z]{6})"[^}]*?"longPercentage"\s*:\s*([\d.]+)/g)) {
        const l = parseFloat(m[2]); out[m[1]] = { l: Math.round(l), s: Math.round(100 - l) };
      }
    } catch (e) {}
  }
  if (Object.keys(out).length < 4) {
    for (const m of html.matchAll(/([A-Z]{6})[^%]{0,80}?(\d{2,3}(?:\.\d+)?)\s*%[^%]{0,80}?(\d{2,3}(?:\.\d+)?)\s*%/g)) {
      const l = parseFloat(m[2]), s = parseFloat(m[3]);
      if (l + s > 95 && l + s < 105) out[m[1]] = { l: Math.round(l), s: Math.round(s) };
    }
  }
  return out;
}
function pairsToCcy(pairs) {
  const sum = {}, cnt = {};
  for (const [pair, d] of Object.entries(pairs)) {
    const b = pair.slice(0, 3), q = pair.slice(3, 6);
    if (CUR.includes(b)) { sum[b] = (sum[b] || 0) + d.l; cnt[b] = (cnt[b] || 0) + 1; }
    if (CUR.includes(q)) { sum[q] = (sum[q] || 0) + (100 - d.l); cnt[q] = (cnt[q] || 0) + 1; }
  }
  const ccy = {};
  for (const c of CUR) ccy[c] = cnt[c] ? Math.round(sum[c] / cnt[c]) : 50;
  return ccy;
}
async function fetchMyfxbook() {
  for (const u of MYFX_PROXIES) {
    try {
      const r = await fetch(u, { headers: UA });
      const html = await r.text();
      console.log(`proxy ${u.slice(0, 40)}… status=${r.status} len=${html.length}`);
      if (!r.ok || html.length < 800) continue;
      const pairs = parseMyfxPairs(html);
      console.log("  parsed pairs:", Object.keys(pairs).length);
      if (Object.keys(pairs).length >= 4) return pairs;
    } catch (e) { console.log("  ERR", e.message); }
  }
  return null;
}

(async () => {
  let ccy = null, pairs = {}, source = "";

  try {
    ccy = await fetchCftcNonReportable();
    source = "cftc-nonreport";
    console.log("CFTC Non-reportable OK:", JSON.stringify(ccy));
  } catch (e) { console.log("CFTC Non-reportable selhal:", e.message); }

  // Myfxbook: pokud dostupný, dá jemnější per-pár rozpad. Pokud CFTC selhal, je to
  // jediná šance na výsledek vůbec; pokud CFTC uspěl, Myfxbook jen doplní `pairs`
  // (ccy z CFTC se nepřepisuje — je to spolehlivější primární zdroj).
  const myfx = await fetchMyfxbook();
  if (myfx) {
    pairs = myfx;
    if (!ccy) { ccy = pairsToCcy(myfx); source = "myfxbook-outlook"; }
    else source += "+myfxbook";
  }

  if (!ccy) { console.error("Žádný retail zdroj nedostupný (CFTC i Myfxbook selhaly) — nepřepisuju."); process.exit(1); }

  const point = { t: new Date().toISOString(), pairs, ccy, source };

  let store = { updated: "", points: [] };
  try { store = JSON.parse(fs.readFileSync("data/retail_hist.json", "utf8")); } catch (e) {}
  if (!Array.isArray(store.points)) store.points = [];
  store.points.push(point);
  // drž ~45 dní bodů
  store.points = store.points.slice(-1100);
  store.updated = point.t;
  store.source = source;

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/retail_hist.json", JSON.stringify(store));
  console.log("Zapsáno data/retail_hist.json · bodů:", store.points.length, "· zdroj:", source, "· ccy:", JSON.stringify(ccy));
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

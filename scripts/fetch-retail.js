// Retail sentiment (Myfxbook Community Outlook) — hodinový snímek na server.
// Myfxbook má Cloudflare → přímý fetch je 403, proto přes „čtecí" proxy
// (stejně jako appka v prohlížeči). Server (GitHub Action) nemá CORS problém.
// Výstup: data/retail_hist.json = { updated, points:[ {t, pairs:{EURUSD:{l,s}}, ccy:{USD:..} } ] }
const fs = require("fs");
const CUR = ["USD","EUR","GBP","JPY","AUD","CAD","CHF","NZD"];
const MYFX = "https://www.myfxbook.com/community/outlook";
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" };

const PROXIES = [
  "https://r.jina.ai/" + MYFX,
  "https://api.allorigins.win/raw?url=" + encodeURIComponent(MYFX),
  "https://corsproxy.io/?url=" + encodeURIComponent(MYFX),
  "https://thingproxy.freeboard.io/fetch/" + MYFX,
];

function parsePairs(html) {
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
  // __NEXT_DATA__ fallback
  const nd = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nd) {
    try {
      const str = JSON.stringify(JSON.parse(nd[1]));
      for (const m of str.matchAll(/"symbol"\s*:\s*"([A-Z]{6})"[^}]*?"longPercentage"\s*:\s*([\d.]+)/g)) {
        const l = parseFloat(m[2]); out[m[1]] = { l: Math.round(l), s: Math.round(100 - l) };
      }
    } catch (e) {}
  }
  // poslední záchrana: dvojice procent u 6-písmenného páru
  if (Object.keys(out).length < 4) {
    for (const m of html.matchAll(/([A-Z]{6})[^%]{0,80}?(\d{2,3}(?:\.\d+)?)\s*%[^%]{0,80}?(\d{2,3}(?:\.\d+)?)\s*%/g)) {
      const l = parseFloat(m[2]), s = parseFloat(m[3]);
      if (l + s > 95 && l + s < 105) out[m[1]] = { l: Math.round(l), s: Math.round(s) };
    }
  }
  return out;
}

function toCcy(pairs) {
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

(async () => {
  let pairs = {};
  for (const u of PROXIES) {
    try {
      const r = await fetch(u, { headers: UA });
      const html = await r.text();
      console.log(`proxy ${u.slice(0, 40)}… status=${r.status} len=${html.length}`);
      if (!r.ok || html.length < 800) continue;
      pairs = parsePairs(html);
      console.log("  parsed pairs:", Object.keys(pairs).length);
      if (Object.keys(pairs).length >= 4) break;
    } catch (e) { console.log("  ERR", e.message); }
  }
  if (Object.keys(pairs).length < 4) { console.error("Málo retail dat — nepřepisuju."); process.exit(1); }

  const ccy = toCcy(pairs);
  const point = { t: new Date().toISOString(), pairs, ccy };

  let store = { updated: "", points: [] };
  try { store = JSON.parse(fs.readFileSync("data/retail_hist.json", "utf8")); } catch (e) {}
  if (!Array.isArray(store.points)) store.points = [];
  store.points.push(point);
  // drž ~45 dní hodinových bodů
  store.points = store.points.slice(-1100);
  store.updated = point.t;
  store.source = "myfxbook-outlook";

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/retail_hist.json", JSON.stringify(store));
  console.log("Zapsáno data/retail_hist.json · bodů:", store.points.length, "· ccy:", JSON.stringify(ccy));
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

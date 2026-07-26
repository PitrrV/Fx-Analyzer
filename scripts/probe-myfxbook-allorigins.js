// PRŮZKUM (dispatch-only): dotáhnout nadějný nález u allorigins.
//
// Run 30190587747: přes allorigins login PROŠEL (session_len=98) a outlook
// NEvrátil "Invalid session.", ale HTTP 500 od SAMOTNÉ PROXY. To není odmítnutí
// Myfxbookem — je to selhání prostředníka, tedy neprůkazný výsledek.
// Ostatní proxy: r.jina.ai 403 (Cloudflare), corsproxy.io 403, codetabs 522.
//
// Tady se zkouší varianty allorigins (/raw vs /get) s opakováním, aby se
// rozlišilo mezi "proxy je jen nespolehlivá" a "Myfxbook session stejně nefunguje".
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" };
const MYFX = "https://www.myfxbook.com/api";
const VARIANTY = {
  raw: (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  get: (u) => "https://api.allorigins.win/get?url=" + encodeURIComponent(u),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  return { status: r.status, body: await r.text() };
}
// /get vrací {contents:"..."}; /raw vrací rovnou tělo
function extract(varianta, body) {
  if (varianta === "get") {
    try { const w = JSON.parse(body); return w.contents; } catch (e) { return null; }
  }
  return body;
}
const pj = (b) => { try { return JSON.parse(b); } catch (e) { return null; } };

async function zkus(varianta, url, pokusy = 3) {
  const wrap = VARIANTY[varianta];
  for (let i = 1; i <= pokusy; i++) {
    try {
      const { status, body } = await fetchText(wrap(url));
      const inner = extract(varianta, body);
      const j = inner ? pj(inner) : null;
      if (j) return { ok: true, j, status };
      console.log(`    pokus ${i}/${pokusy}: HTTP ${status} · ${String(inner || body).slice(0, 90).replace(/\s+/g, " ")}`);
    } catch (e) { console.log(`    pokus ${i}/${pokusy}: ${e.message}`); }
    if (i < pokusy) await sleep(2500 * i);
  }
  return { ok: false };
}

(async () => {
  const email = process.env.MYFXBOOK_EMAIL, pass = process.env.MYFXBOOK_PASSWORD;
  if (!email || !pass) { console.log("⚠ přihlašovací údaje nejsou nastavené."); return; }
  const need = ["EURCAD","EURNZD","GBPAUD","GBPCAD","GBPNZD","AUDCAD","AUDNZD","AUDCHF","NZDCAD","NZDJPY","NZDCHF","CADJPY","CADCHF","CHFJPY"];

  for (const varianta of Object.keys(VARIANTY)) {
    console.log(`\n=== allorigins /${varianta} ===`);
    const lg = await zkus(varianta, `${MYFX}/login.json?email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`);
    if (!lg.ok || !lg.j || lg.j.error || !lg.j.session) {
      console.log(`  ❌ login neprošel${lg.j ? " · " + JSON.stringify(lg.j.message) : ""}`);
      continue;
    }
    console.log(`  login OK · session_len=${lg.j.session.length}`);
    const ok = await zkus(varianta, `${MYFX}/get-community-outlook.json?session=${encodeURIComponent(lg.j.session)}`);
    if (!ok.ok) { console.log("  ❌ outlook: proxy neodpověděla použitelně ani po 3 pokusech"); continue; }
    if (ok.j.error) { console.log(`  ❌ outlook odmítnut Myfxbookem · ${JSON.stringify(ok.j.message)}`); continue; }

    const syms = (ok.j.symbols || []).map((s) => String(s.name || "").toUpperCase().replace("/", ""))
      .filter((x) => /^[A-Z]{6}$/.test(x)).sort();
    const má = need.filter((p) => syms.includes(p));
    console.log(`  ✅ FUNGUJE · měnových párů: ${syms.length}`);
    console.log(`     ${syms.join(" ")}`);
    console.log(`     z 14 chybějících křížů pokrývá ${má.length}/14: ${má.join(" ")}`);
    try { await zkus(varianta, `${MYFX}/logout.json?session=${encodeURIComponent(lg.j.session)}`, 1); } catch (e) {}
    return;
  }
  console.log("\n❌ Ani jedna varianta allorigins nedala použitelný výsledek.");
})().catch((e) => { console.error("FATAL", e.message); });

// PRŮZKUM (dispatch-only): jde Myfxbook API z GH Actions rozchodit BEZ proxy?
//
// Problém: Myfxbook váže session na IP. Z GH Actions login projde, ale navazující
// volání stejnou session vrátí "Invalid session." — cloud runner mění odchozí IP
// mezi jednotlivými HTTPS spojeními (sdílený NAT pool).
//
// Hypotéza: když se login i outlook pošlou po JEDNOM keep-alive TCP spojení,
// je zdrojová IP z principu identická a session by měla projít. Kdyby to vyšlo,
// odpadá závislost na externí proxy se statickou IP.
//
// Myfxbook má oproti FXSSI zásadní výhodu: dodává ~48 párů (vlastní historie
// data/retail_hist.json to dokládá), tedy VŠECH 28 z STANDARD_PAIRS, zatímco
// FXSSI kříže jako GBPNZD/NZDJPY vůbec nesleduje (/api/ratios na ně vrací 400).
const https = require("https");

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" };

// JEDEN agent se sdíleným keep-alive socketem pro všechna volání
const agent = new https.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30000 });

function req(path) {
  return new Promise((resolve, reject) => {
    const r = https.request({ hostname: "www.myfxbook.com", path, method: "GET", agent, headers: { ...UA, Connection: "keep-alive" }, timeout: 20000 }, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d, reused: res.socket && res.socket.remoteAddress }));
    });
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", reject);
    r.end();
  });
}

(async () => {
  const email = process.env.MYFXBOOK_EMAIL, pass = process.env.MYFXBOOK_PASSWORD;
  if (!email || !pass) { console.log("⚠ MYFXBOOK_EMAIL/PASSWORD nejsou nastavené — přeskakuji."); return; }

  console.log("=== Myfxbook přes JEDNO keep-alive spojení ===");
  const lg = await req(`/api/login.json?email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`);
  let j;
  try { j = JSON.parse(lg.body); } catch (e) { console.log("login: nelze parsovat:", lg.body.slice(0, 200)); return; }
  console.log(`  login  HTTP ${lg.status} · error=${j.error} · session_len=${j.session ? j.session.length : 0} · peer=${lg.reused}`);
  if (j.error || !j.session) { console.log("  login selhal:", j.message); return; }

  // stejný agent → stejný socket → stejná zdrojová IP
  const ok = await req(`/api/get-community-outlook.json?session=${encodeURIComponent(j.session)}`);
  let o;
  try { o = JSON.parse(ok.body); } catch (e) { console.log("outlook: nelze parsovat:", ok.body.slice(0, 200)); return; }
  console.log(`  outlook HTTP ${ok.status} · error=${o.error} · message=${JSON.stringify(o.message)} · peer=${ok.reused}`);

  if (o.error) {
    console.log("\n❌ Keep-alive NEPOMOHL — session je odmítnutá i po jednom spojení.");
    console.log("   → jediná cesta k Myfxbook je proxy se statickou IP.");
  } else {
    const syms = (o.symbols || []).map((s) => String(s.name || "").toUpperCase().replace("/", "")).filter((x) => /^[A-Z]{6}$/.test(x));
    console.log(`\n✅ FUNGUJE! symbolů: ${syms.length}`);
    console.log("   " + syms.sort().join(" "));
    const need = ["EURCAD","EURNZD","GBPAUD","GBPCAD","GBPNZD","AUDCAD","AUDNZD","AUDCHF","NZDCAD","NZDJPY","NZDCHF","CADJPY","CADCHF","CHFJPY"];
    const má = need.filter((p) => syms.includes(p));
    console.log(`   z 14 chybějících křížů pokrývá: ${má.length}/14 → ${má.join(" ")}`);
  }
  try { await req(`/api/logout.json?session=${encodeURIComponent(j.session)}`); } catch (e) {}
})().catch((e) => { console.error("FATAL", e.message); });

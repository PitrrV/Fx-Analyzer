// PRŮZKUM (dispatch-only): proč Myfxbook API odmítá čerstvou session?
//
// Keep-alive test (run 30190395760) VYVRÁTIL hypotézu o rotaci IP: login i outlook
// šly po JEDNOM TCP socketu (zdrojová IP tedy zaručeně identická) a session přesto
// padla o 18 ms později. Příčina je jinde než v IP.
//
// Zbývající hypotézy, které testuje tenhle skript:
//   H1) session vyžaduje i COOKIE z loginu (my ji nikdy neposíláme zpět)
//   H2) endpoint chce POST, ne GET
//   H3) chybí hlavičky, které posílá prohlížeč (Accept, Referer, X-Requested-With)
//   H4) Myfxbook blokuje POUŽITÍ session z datacentrových IP (reputace, ne rotace)
//       — tohle by se projevilo tím, že nepomůže nic z H1–H3
const https = require("https");

const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });

function req(path, { method = "GET", cookie, extra } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "en-US,en;q=0.9",
      "Connection": "keep-alive",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(extra || {}),
    };
    const r = https.request({ hostname: "www.myfxbook.com", path, method, agent, headers, timeout: 20000 }, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d, setCookie: res.headers["set-cookie"] || [] }));
    });
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", reject);
    r.end();
  });
}
const parseJson = (b) => { try { return JSON.parse(b); } catch (e) { return null; } };
const outlookPath = (s) => `/api/get-community-outlook.json?session=${encodeURIComponent(s)}`;

(async () => {
  const email = process.env.MYFXBOOK_EMAIL, pass = process.env.MYFXBOOK_PASSWORD;
  if (!email || !pass) { console.log("⚠ přihlašovací údaje nejsou nastavené — přeskakuji."); return; }

  const lg = await req(`/api/login.json?email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`);
  const j = parseJson(lg.body);
  if (!j || j.error || !j.session) { console.log("login selhal:", lg.body.slice(0, 200)); return; }
  const session = j.session;
  const cookies = lg.setCookie.map((c) => c.split(";")[0]).join("; ");
  console.log(`login OK · session_len=${session.length}`);
  console.log(`Set-Cookie z loginu: ${lg.setCookie.length ? cookies : "(ŽÁDNÁ)"}\n`);

  const testy = [
    ["H1 cookie z loginu", () => req(outlookPath(session), { cookie: cookies })],
    ["H2 POST místo GET", () => req(outlookPath(session), { method: "POST" })],
    ["H3 prohlížečové hlavičky", () => req(outlookPath(session), {
      cookie: cookies,
      extra: { Referer: "https://www.myfxbook.com/community/outlook", "X-Requested-With": "XMLHttpRequest", Origin: "https://www.myfxbook.com" },
    })],
    ["kontrola: holý GET", () => req(outlookPath(session))],
  ];

  let uspech = null;
  for (const [nazev, fn] of testy) {
    try {
      const r = await fn();
      const o = parseJson(r.body);
      const err = o ? o.error : "?";
      const msg = o ? JSON.stringify(o.message) : r.body.slice(0, 80);
      const n = o && Array.isArray(o.symbols) ? o.symbols.length : 0;
      console.log(`  ${err === false ? "✅" : "❌"} ${nazev.padEnd(26)} HTTP ${r.status} · error=${err} · ${msg}${n ? " · symbolů=" + n : ""}`);
      if (o && o.error === false && n) uspech = o;
    } catch (e) { console.log(`  ❌ ${nazev.padEnd(26)} ${e.message}`); }
  }

  if (uspech) {
    const syms = uspech.symbols.map((s) => String(s.name || "").toUpperCase().replace("/", "")).filter((x) => /^[A-Z]{6}$/.test(x)).sort();
    console.log(`\n✅ MYFXBOOK ZPŘÍSTUPNĚN · měnových párů: ${syms.length}`);
    console.log("   " + syms.join(" "));
    const need = ["EURCAD","EURNZD","GBPAUD","GBPCAD","GBPNZD","AUDCAD","AUDNZD","AUDCHF","NZDCAD","NZDJPY","NZDCHF","CADJPY","CADCHF","CHFJPY"];
    const má = need.filter((p) => syms.includes(p));
    console.log(`   z 14 chybějících křížů pokrývá ${má.length}/14: ${má.join(" ")}`);
  } else {
    console.log("\n❌ Žádná varianta neprošla → podporuje H4: Myfxbook blokuje POUŽITÍ");
    console.log("   session z datacentrových IP (reputace), ne rotaci IP.");
    console.log("   Statická proxy by pomohla jen tehdy, je-li její IP rezidenční.");
  }
  try { await req(`/api/logout.json?session=${encodeURIComponent(session)}`); } catch (e) {}
})().catch((e) => { console.error("FATAL", e.message); });

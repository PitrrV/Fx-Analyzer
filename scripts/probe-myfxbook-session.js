// PRŮZKUM OD NULY (dispatch-only): co přesně vadí Myfxbook session?
//
// Dosud vyloučeno: rotace IP (keep-alive po jednom socketu selhal stejně),
// cookies, POST, prohlížečové hlavičky, 4 veřejné proxy.
// Selhání přichází OKAMŽITĚ (18 ms) a konzistentně → vypadá to spíš na chybu
// ve tvaru požadavku než na síťovou/reputační blokaci.
//
// NETESTOVANÉ HYPOTÉZY, které to vysvětlují:
//  H-A) session obsahuje znaky (+ / =), které encodeURIComponent zakóduje na
//       %2B %2F %3D. Pokud server parametr NEDEKÓDUJE, čte jinou hodnotu →
//       "Invalid session." Testuje se odeslání session BEZ kódování.
//  H-B) debug=1 (zmíněno v dokumentaci) vrátí konkrétnější chybu.
//  H-C) XML varianta API jde jinou cestou než JSON.
//  H-D) účet nemá ověřený e-mail / nemá navázaný účet → API data zamčená.
//  H-E) vyčerpaný limit (100 req/24h) se hlásí jako "Invalid session.".
const https = require("https");
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" };

function req(path) {
  return new Promise((resolve, reject) => {
    const r = https.request({ hostname: "www.myfxbook.com", path, method: "GET", headers: UA, timeout: 25000 }, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", reject);
    r.end();
  });
}
const pj = (b) => { try { return JSON.parse(b); } catch (e) { return null; } };

(async () => {
  const email = process.env.MYFXBOOK_EMAIL, pass = process.env.MYFXBOOK_PASSWORD;
  if (!email || !pass) { console.log("⚠ údaje nejsou nastavené."); return; }

  const lg = await req(`/api/login.json?email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`);
  const j = pj(lg.body);
  if (!j || j.error || !j.session) { console.log("login selhal:", lg.body.slice(0, 200)); return; }
  const s = j.session;

  // Jaké znaky session vůbec obsahuje? (maskovaně)
  const zvlastni = [...new Set(s.split("").filter((c) => !/[A-Za-z0-9]/.test(c)))];
  console.log(`login OK · délka=${s.length} · prefix=${s.slice(0, 4)}…`);
  console.log(`nealfanumerické znaky v session: ${zvlastni.length ? JSON.stringify(zvlastni) : "ŽÁDNÉ"}`);
  console.log(`encodeURIComponent mění session: ${encodeURIComponent(s) !== s ? "ANO ⚠" : "ne"}\n`);

  const varianty = [
    ["H-A syrová session (bez kódování)", `/api/get-community-outlook.json?session=${s}`],
    ["    kódovaná session (dosavadní)",  `/api/get-community-outlook.json?session=${encodeURIComponent(s)}`],
    ["H-B debug=1",                        `/api/get-community-outlook.json?session=${s}&debug=1`],
    ["H-C XML varianta",                   `/api/get-community-outlook.xml?session=${s}`],
    ["H-D get-my-accounts (jiný endpoint)",`/api/get-my-accounts.json?session=${s}`],
  ];

  for (const [nazev, path] of varianty) {
    try {
      const r = await req(path);
      const o = pj(r.body);
      if (o) {
        const n = Array.isArray(o.symbols) ? o.symbols.length : 0;
        console.log(`  ${o.error === false ? "✅" : "❌"} ${nazev.padEnd(36)} HTTP ${r.status} · error=${o.error} · ${JSON.stringify(o.message)}${n ? " · symbolů=" + n : ""}`);
        if (o.error === false && n) {
          const syms = o.symbols.map((x) => String(x.name || "").toUpperCase().replace("/", "")).filter((x) => /^[A-Z]{6}$/.test(x)).sort();
          const need = ["EURCAD","EURNZD","GBPAUD","GBPCAD","GBPNZD","AUDCAD","AUDNZD","AUDCHF","NZDCAD","NZDJPY","NZDCHF","CADJPY","CADCHF","CHFJPY"];
          const má = need.filter((p) => syms.includes(p));
          console.log(`\n     🎯 ${syms.length} měnových párů · z 14 chybějících křížů ${má.length}/14`);
          console.log(`     ${syms.join(" ")}`);
        }
      } else {
        console.log(`  ?  ${nazev.padEnd(36)} HTTP ${r.status} · ${r.body.slice(0, 120).replace(/\s+/g, " ")}`);
      }
    } catch (e) { console.log(`  ⛔ ${nazev.padEnd(36)} ${e.message}`); }
  }
  try { await req(`/api/logout.json?session=${s}`); } catch (e) {}
})().catch((e) => { console.error("FATAL", e.message); });

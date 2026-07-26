// PRŮZKUM (dispatch-only): projde Myfxbook session, když login i dotaz jdou přes
// VEŘEJNOU ČTECÍ PROXY (tedy z její IP, ne z GH Actions runneru)?
//
// Dosavadní fakta:
//   · keep-alive (jeden TCP socket, zaručeně stejná IP) → "Invalid session."
//     ⇒ příčinou NENÍ rotace odchozí IP
//   · cookie z loginu / POST / prohlížečové hlavičky → taky "Invalid session."
//     ⇒ zbývá výklad, že Myfxbook blokuje POUŽITÍ session z datacentrových IP
//
// Poslední levný test: veřejné proxy mají jinou IP a jinou reputaci. Pokud přes
// některou projde i outlook, máme zdarma ~48 párů = všech 28 z STANDARD_PAIRS
// se SKUTEČNĚ MĚŘENÝMI daty a dopočet zmizí úplně.
const MYFX = "https://www.myfxbook.com/api";
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" };

const PROXY = {
  "r.jina.ai":   (u) => "https://r.jina.ai/" + u,
  "allorigins":  (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  "corsproxy.io":(u) => "https://corsproxy.io/?url=" + encodeURIComponent(u),
  "codetabs":    (u) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u),
};

async function get(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
  return { status: r.status, body: await r.text() };
}
const pj = (b) => { try { return JSON.parse(b); } catch (e) { return null; } };

(async () => {
  const email = process.env.MYFXBOOK_EMAIL, pass = process.env.MYFXBOOK_PASSWORD;
  if (!email || !pass) { console.log("⚠ přihlašovací údaje nejsou nastavené — přeskakuji."); return; }
  const loginUrl = `${MYFX}/login.json?email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`;

  const need = ["EURCAD","EURNZD","GBPAUD","GBPCAD","GBPNZD","AUDCAD","AUDNZD","AUDCHF","NZDCAD","NZDJPY","NZDCHF","CADJPY","CADCHF","CHFJPY"];

  for (const [jmeno, wrap] of Object.entries(PROXY)) {
    console.log(`\n=== ${jmeno} ===`);
    try {
      const lg = await get(wrap(loginUrl));
      const j = pj(lg.body);
      if (!j || j.error || !j.session) {
        console.log(`  login HTTP ${lg.status} · ${j ? JSON.stringify(j.message) : lg.body.slice(0, 120)}`);
        continue;
      }
      console.log(`  login OK · session_len=${j.session.length}`);
      // outlook PŘES STEJNOU proxy → stejná zdrojová IP jako login
      const ok = await get(wrap(`${MYFX}/get-community-outlook.json?session=${encodeURIComponent(j.session)}`));
      const o = pj(ok.body);
      if (!o) { console.log(`  outlook HTTP ${ok.status} · nelze parsovat: ${ok.body.slice(0, 120)}`); continue; }
      if (o.error) { console.log(`  ❌ outlook · ${JSON.stringify(o.message)}`); continue; }

      const syms = (o.symbols || []).map((s) => String(s.name || "").toUpperCase().replace("/", ""))
        .filter((x) => /^[A-Z]{6}$/.test(x)).sort();
      const má = need.filter((p) => syms.includes(p));
      console.log(`  ✅ FUNGUJE · měnových párů: ${syms.length}`);
      console.log(`     ${syms.join(" ")}`);
      console.log(`     z 14 chybějících křížů pokrývá ${má.length}/14: ${má.join(" ")}`);
      try { await get(wrap(`${MYFX}/logout.json?session=${encodeURIComponent(j.session)}`)); } catch (e) {}
    } catch (e) { console.log("  ⛔ " + e.message); }
  }
  console.log("\nHotovo.");
})().catch((e) => { console.error("FATAL", e.message); });

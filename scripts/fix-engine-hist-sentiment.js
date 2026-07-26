// Jednorázová oprava (dispatch-only): přepočítat sentiment složku v
// data/engine_hist.json u snapshotů, které vznikly z OBRÁCENÝCH retail dat.
//
// PROČ: snapshot-engine.js bere poslední bod z data/retail_hist.json a volá
// scoreCurrency() → uloží vážené komponenty včetně `comp.sent`. Snapshoty pořízené
// před opravou retail historie (22.6.–23.7.2026) tedy nesou sentiment spočítaný
// z prohozených long/short. Merge v snapshot-engine.js navíc starší dny NIKDY
// nepřepisuje, takže se samy neopraví.
//
// PROČ JE PŘEPOČET KOREKTNÍ: getSentimentScore() je přesně antisymetrická kolem 50
// (≥80→−1, ≥70→−0.5, ≤30→+0.5, ≤20→+1), takže pro obrácený vstup platí
// ss(100−x) = −ss(x). Sentiment složka je do skóre lineární (sentScore × wt.sent),
// takže správná hodnota = −uložená, a skóre se posune o −2×uložená. Ověřuje se,
// že uložená hodnota skutečně odpovídá ss(obrácené %) × váha; když ne, záznam se
// přeskočí (nespoléhá se na předpoklad).
//
// Idempotentní přes příznak `sent_fixed` na dni.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const EH = path.join(ROOT, "data/engine_hist.json");

const ss = (p) => (p >= 80 ? -1 : p >= 70 ? -0.5 : p <= 20 ? 1 : p <= 30 ? 0.5 : 0);

const eh = JSON.parse(fs.readFileSync(EH, "utf8"));
const rh = JSON.parse(fs.readFileSync(path.join(ROOT, "data/retail_hist.json"), "utf8"));
const pts = rh.points.map((p) => ({ t: Date.parse(p.t), p })).sort((a, b) => a.t - b.t);

let fixedDays = 0, fixedRecs = 0, skipped = 0;

for (const [day, rec] of Object.entries(eh.days || {})) {
  if (rec.sent_fixed) continue;
  const ts = Date.parse(rec.ts);
  // bod, který snapshot v ten okamžik reálně viděl = poslední s t <= ts
  const used = [...pts].reverse().find((x) => x.t <= ts);
  if (!used || !used.p.inv_fixed) continue;   // snapshot nebyl z obrácených dat

  let touched = false;
  for (const [c, v] of Object.entries(rec.cur || {})) {
    const correctPct = used.p.ccy && used.p.ccy[c];
    if (!Number.isFinite(correctPct)) continue;
    const invPct = 100 - correctPct;
    const stored = v.comp && v.comp.sent;
    if (!Number.isFinite(stored)) continue;

    const sInv = ss(invPct), sOk = ss(correctPct);
    if (sInv === 0 && sOk === 0) continue;              // beze změny
    // ověř, že uložená hodnota opravdu vznikla z obráceného vstupu
    if (sInv === 0) { if (Math.abs(stored) > 1e-9) { skipped++; } continue; }
    const w = stored / sInv;
    if (!(w > 0.05 && w < 0.35)) { skipped++; continue; }  // váha mimo očekávání → nesahat

    const corrected = parseFloat((sOk * w).toFixed(4));
    if (Math.abs(corrected - stored) < 1e-9) continue;
    const delta = corrected - stored;
    v.comp.sent = corrected;
    v.score = parseFloat((v.score + delta).toFixed(2));
    fixedRecs++; touched = true;
    console.log(`  ${day} ${c}: retail ${correctPct}% (uloženo jako ${invPct}%) · sent ${stored} → ${corrected} · skóre ${(v.score - delta).toFixed(2)} → ${v.score}`);
  }
  if (touched) { rec.sent_fixed = true; fixedDays++; }
}

console.log(`\nOpraveno dnů: ${fixedDays} · záznamů (den×měna): ${fixedRecs} · přeskočeno pro neshodu: ${skipped}`);
if (!fixedRecs) { console.log("Nic k opravě — nezapisuju."); process.exit(0); }
fs.writeFileSync(EH, JSON.stringify(eh));
console.log("Zapsáno data/engine_hist.json");

// Jednorázová oprava (dispatch-only): převrátit long/short u historických retail bodů
// z „myfxbook éry", které mají prohozené hodnoty.
//
// PROČ: dřívější parser bral čísla z volného HTML fallbacku myfxbook.com/community/outlook,
// kde se zobrazuje Short PŘED Long — první procento tedy skončilo jako `l` (long),
// ačkoliv to byl short. Doloženo porovnáním s FXSSI (který ta samá myfxbook data
// obsahuje jako jeden ze sloupců): korelace uložených `l` vs. FXSSI = −0.90, a po
// převrácení sedí per měnu skoro přesně (JPY 69 vs 68, AUD 38 vs 37, CHF 57 vs 58,
// GBP 47 vs 47). Směr FXSSI = Buy%/long% je ověřený z jejich vlastního kódu
// (.ratio-bar-left ← close ← RAW, a jinde $voter…('.ratio-bar-left').text(data.buy)).
//
// CO SE MĚNÍ: jen body z myfxbook éry — poznají se tak, že MAJÍ neprázdné `pairs`
// a NEMAJÍ source 'fxssi-current-ratio'. Body z CFTC (`source:'cftc-nonreport'`,
// prázdné `pairs`) jsou správně (pole nonrept_positions_long/short jsou jednoznačná)
// a zůstávají nedotčené — stejně tak nové FXSSI body.
//
// Skript je idempotentní přes příznak `inv_fixed:true` na opraveném bodu.
const fs = require("fs");
const PATH = "data/retail_hist.json";

const store = JSON.parse(fs.readFileSync(PATH, "utf8"));
if (!Array.isArray(store.points)) throw new Error("retail_hist.json: chybí pole points");

const flip = (v) => (Number.isFinite(v) ? 100 - v : v);

let fixed = 0, skippedCftc = 0, skippedFxssi = 0, alreadyDone = 0;

for (const p of store.points) {
  if (p.inv_fixed) { alreadyDone++; continue; }
  if (p.source === "fxssi-current-ratio") { skippedFxssi++; continue; }
  const hasPairs = p.pairs && Object.keys(p.pairs).length > 0;
  if (!hasPairs) { skippedCftc++; continue; }   // CFTC body: ccy-only, správný směr

  for (const d of Object.values(p.pairs)) {
    const l = d.l;
    d.l = flip(l);
    d.s = flip(d.s);
  }
  if (p.ccy) for (const k of Object.keys(p.ccy)) p.ccy[k] = flip(p.ccy[k]);
  p.inv_fixed = true;
  fixed++;
}

console.log("Opraveno (převráceno) bodů :", fixed);
console.log("Ponecháno CFTC/bez párů    :", skippedCftc);
console.log("Ponecháno FXSSI            :", skippedFxssi);
console.log("Už dříve opraveno          :", alreadyDone);
console.log("Celkem bodů                :", store.points.length);

if (!fixed) { console.log("Nic k opravě — nezapisuju."); process.exit(0); }

fs.writeFileSync(PATH, JSON.stringify(store));
console.log("Zapsáno", PATH);

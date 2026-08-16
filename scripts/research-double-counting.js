// VÝZKUMNÝ TEST: opravuje de-duplikace sazbového kanálu OOS výsledky?
//
// Hypotéza z docs/ENGINE_ARCHITECTURE_MAP.md §6.1 (a nezávisle
// docs/RESEARCH_AUDIT_2026-07.md / COUNTER_AUDIT_2026-07.md §9): CB rozhodnutí
// centrální banky se do skóre měny propisuje TŘEMI kanály —
//   1) fund_data — beat/miss "Interest Rates" eventů z kalendáře (uvnitř
//      fundScoreRaw, spolu s Inflation/Labor/GDP/PMI/... — nelze odsud izolovat
//      jen sazbovou kategorii bez re-instrumentace enginu, viz limity níže)
//   2) yield  — statická úroveň (nominální sazba − CPI) relativně k průměru koše
//   3) policy — trend/cyklus CB politiky relativně k průměru koše
// yield a policy měří RŮZNÉ vlastnosti (úroveň vs. směr), ale obě vycházejí ze
// STEJNÉHO zdroje dat (CENTRAL_BANK_RATES / CB_POLICY_DATA, samy z velké části
// odvozené auto-detekcí ze stejných kalendářních "Interest Rates" eventů, které
// počítá i fund_data) — proto "3 kanály, 1 podkladový jev".
//
// Tenhle skript testuje POUZE de-duplikaci (2) a (3) — yield a policy jsou obě
// přímo dostupné jako samostatné položky v `components` (viz data/calibration_
// replay.json), takže jde o čistou, přesně měřitelnou operaci. Izolovat sazbovou
// část z fund_data (1) by vyžadovalo znovu-spustit celý point-in-time replay
// s nástrojovaným enginem (capturing category_scores["Interest Rates"] per den) —
// to NENÍ v tomto kroku uděláno, viz "Co tenhle test NEŘEŠÍ" na konci.
//
// METODA: delta-simulace nad SKUTEČNÝM point-in-time replay výstupem
// (data/calibration_replay.json — 799 dní, 2024-05-27→2026-08-03, per-den
// atribuce komponent z reálného engine.js, žádný look-ahead — viz entryRule
// v souboru). Stejná technika jako scripts/simulate-proposed-score.js: od
// STARÉHO celkového skóre (které yield+policy už v sobě má) se odečte/upraví
// JEN tahle dvojice, zbytek komponent (fund_data, cot, sent, season, oil, risk)
// zůstává beze změny. Pak se identický obchodní test (vstup den X+1, horizonty
// 1/3/5/10 dní) přehraje pro každou variantu.
//
// VALIDACE: train/test split s embargem (stejná disciplína jako
// COUNTER_AUDIT_2026-07.md §3) — ne jen naivní half-split. Embargo 10 dní kolem
// splitAt, aby žádný obchod s horizontem přesahujícím hranici nepřispíval ani
// do train, ani do test.
//
// Žádná změna v engine.js. Čistě výzkumný skript.
// Výstup: data/research/double_counting_test.json
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const STANDARD_PAIRS = [
  { pair: "EURUSD", base: "EUR", quote: "USD" }, { pair: "USDJPY", base: "USD", quote: "JPY" },
  { pair: "GBPUSD", base: "GBP", quote: "USD" }, { pair: "AUDUSD", base: "AUD", quote: "USD" },
  { pair: "USDCAD", base: "USD", quote: "CAD" }, { pair: "USDCHF", base: "USD", quote: "CHF" },
  { pair: "NZDUSD", base: "NZD", quote: "USD" }, { pair: "EURGBP", base: "EUR", quote: "GBP" },
  { pair: "EURCHF", base: "EUR", quote: "CHF" }, { pair: "EURAUD", base: "EUR", quote: "AUD" },
  { pair: "EURCAD", base: "EUR", quote: "CAD" }, { pair: "EURJPY", base: "EUR", quote: "JPY" },
  { pair: "EURNZD", base: "EUR", quote: "NZD" }, { pair: "GBPCHF", base: "GBP", quote: "CHF" },
  { pair: "GBPJPY", base: "GBP", quote: "JPY" }, { pair: "GBPAUD", base: "GBP", quote: "AUD" },
  { pair: "GBPCAD", base: "GBP", quote: "CAD" }, { pair: "GBPNZD", base: "GBP", quote: "NZD" },
  { pair: "AUDCAD", base: "AUD", quote: "CAD" }, { pair: "AUDJPY", base: "AUD", quote: "JPY" },
  { pair: "AUDNZD", base: "AUD", quote: "NZD" }, { pair: "AUDCHF", base: "AUD", quote: "CHF" },
  { pair: "NZDCAD", base: "NZD", quote: "CAD" }, { pair: "NZDJPY", base: "NZD", quote: "JPY" },
  { pair: "NZDCHF", base: "NZD", quote: "CHF" }, { pair: "CADJPY", base: "CAD", quote: "JPY" },
  { pair: "CADCHF", base: "CAD", quote: "CHF" }, { pair: "CHFJPY", base: "CHF", quote: "JPY" },
];
const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
const HORIZONS = [1, 3, 5, 10];
const BANDS = [[0, 2, "slabý <2"], [2, 3, "sweetspot 2–3"], [3, 99, "silný 3+"]];
const EMBARGO_DAYS = 10;

function aggregate(trades) {
  const n = trades.length;
  if (!n) return { n: 0, wr: null, pf: null, avg: null };
  const wins = trades.filter((t) => t.ret > 0).length;
  const gp = trades.filter((t) => t.ret > 0).reduce((a, b) => a + b.ret, 0);
  const gl = Math.abs(trades.filter((t) => t.ret < 0).reduce((a, b) => a + b.ret, 0));
  return { n, wr: +(wins / n * 100).toFixed(1), pf: gl > 0 ? +(gp / gl).toFixed(3) : null, avg: +(trades.reduce((a, b) => a + b.ret, 0) / n).toFixed(4) };
}
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function pearson(xs, ys) {
  const n = xs.length; if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx <= 0 || syy <= 0) return null;
  return +(sxy / Math.sqrt(sxx * syy)).toFixed(3);
}

(async () => {
  const cal = JSON.parse(fs.readFileSync(path.join(ROOT, "data/calibration_replay.json"), "utf8"));
  const days = cal.dailyScores; // [{d, sc:{ccy:total}, comp:{ccy:{fund_data,policy,yield,cot,sent,season,oil,risk,...}}}]
  const pxDays = cal.prices.days, pxRates = cal.prices.rates;
  const pairPrice = (p, i) => { const rr = pxRates[i]; const b = rr[p.base], q = rr[p.quote]; return (b && q) ? q / b : null; };
  const pxIdxOnOrAfter = (iso) => pxDays.findIndex((dd) => dd >= iso);

  console.log("Zdroj:", cal.window.from, "→", cal.window.to, "(", days.length, "dní )");
  console.log("entryRule:", cal.entryRule);

  // ── 1) KOLIK JE YIELD/POLICY VZÁJEMNĚ KORELOVANÉ — přímo na datech téhle appky ──
  const corr = {};
  for (const c of CURRENCIES) {
    const ys = days.map((d) => d.comp[c]?.yield ?? 0);
    const ps = days.map((d) => d.comp[c]?.policy ?? 0);
    const fs_ = days.map((d) => d.comp[c]?.fund_data ?? 0);
    corr[c] = {
      yield_policy: pearson(ys, ps),
      yield_fund: pearson(ys, fs_),
      policy_fund: pearson(ps, fs_),
      meanAbsYield: +mean(ys.map(Math.abs)).toFixed(3),
      meanAbsPolicy: +mean(ps.map(Math.abs)).toFixed(3),
      meanAbsFund: +mean(fs_.map(Math.abs)).toFixed(3),
    };
  }

  // ── 2) VARIANTY SKÓRE ──────────────────────────────────────────────────
  // delta(comp) se PŘIČÍTÁ ke starému total (starý total = Σ komponent, viz
  // engine.js scoreCurrency — "Σ zobrazených hodnot sedí na total přesně").
  // POZOR: nereplikuje clamp(±10) po odečtení — u extrémních dní (score blízko
  // ±10) může nová hodnota být nepatrně jiná, než kdyby scoreCurrency běžel
  // znovu od nuly. Stejná zjednodušující aproximace jako simulate-proposed-score.js.
  const variants = {
    baseline: () => 0,
    drop_yield_and_policy: (c) => -(c.yield ?? 0) - (c.policy ?? 0),
    drop_yield_only: (c) => -(c.yield ?? 0),
    drop_policy_only: (c) => -(c.policy ?? 0),
    merge_half_both: (c) => -0.5 * ((c.yield ?? 0) + (c.policy ?? 0)), // = nahradit dvojici jedním průměrným faktorem se stejnou celkovou vahou jako JEDEN kanál
  };

  function scoreForVariant(day, deltaFn) {
    const out = {};
    for (const c of CURRENCIES) out[c] = (day.sc[c] ?? 0) + deltaFn(day.comp[c] || {});
    return out;
  }

  const splitAt = cal.window.splitAt;
  const splitMs = Date.parse(splitAt + "T00:00:00Z");

  function buildTrades(scArr) {
    const trades = [];
    for (let di = 0; di < days.length; di++) {
      const day = days[di];
      const entryIdx = pxIdxOnOrAfter(new Date(Date.parse(day.d) + 86400000).toISOString().slice(0, 10));
      if (entryIdx < 0) continue;
      const sc = scArr[di];
      for (const p of STANDARD_PAIRS) {
        const diff = (sc[p.base] ?? 0) - (sc[p.quote] ?? 0);
        const p0 = pairPrice(p, entryIdx); if (p0 == null) continue;
        for (const H of HORIZONS) {
          if (entryIdx + H >= pxRates.length) continue;
          const p1 = pairPrice(p, entryIdx + H); if (p1 == null) continue;
          const ret = (p1 / p0 - 1) * (diff > 0 ? 1 : -1) * 100;
          trades.push({ d: day.d, h: H, diff: +Math.abs(diff).toFixed(3), sign: diff > 0 ? 1 : -1, pair: p.pair, base: p.base, quote: p.quote, ret });
        }
      }
    }
    return trades;
  }

  const baselineScArr = days.map((d) => d.sc);
  const baselineTrades = buildTrades(baselineScArr);
  const signByKey = new Map(baselineTrades.map((t) => [t.d + "|" + t.pair + "|" + t.h, t.sign]));

  const results = {};
  for (const [name, fn] of Object.entries(variants)) {
    const scArr = days.map((d) => scoreForVariant(d, fn));
    const trades = buildTrades(scArr);

    // kolik obchodů obrátilo směr vs. baseline (re-ranking, ne jen posun v pásmu)
    let flips = 0;
    for (const t of trades) {
      const key = t.d + "|" + t.pair + "|" + t.h;
      const base = signByKey.get(key);
      if (base != null && base !== t.sign) flips++;
    }

    const train = trades.filter((t) => Date.parse(t.d + "T00:00:00Z") < splitMs - EMBARGO_DAYS * 86400000);
    const test = trades.filter((t) => Date.parse(t.d + "T00:00:00Z") > splitMs + EMBARGO_DAYS * 86400000);

    const grid = [];
    for (const [lo, hi, label] of BANDS) {
      for (const H of HORIZONS) {
        const sel = (arr) => arr.filter((t) => t.diff >= lo && t.diff < hi && t.h === H);
        const a = aggregate(sel(trades)), tr = aggregate(sel(train)), te = aggregate(sel(test));
        grid.push({ band: label, horizon: H, all: a, train: tr, test: te, robust: tr.n >= 30 && te.n >= 30 && tr.pf != null && te.pf != null && tr.pf > 1 && te.pf > 1 });
      }
    }

    const perCcy = {};
    for (const c of CURRENCIES) {
      const sel = (arr) => arr.filter((t) => (t.base === c || t.quote === c) && t.h === 1);
      perCcy[c] = { all: aggregate(sel(trades)), test: aggregate(sel(test)) };
    }

    results[name] = {
      flipsVsBaseline: flips,
      flipsPct: +(flips / trades.length * 100).toFixed(2),
      overallAll: aggregate(trades),
      overallTrain: aggregate(train),
      overallTest: aggregate(test),
      // h=1, bez pásmového filtru — nejhrubší/nejrobustnější jediné číslo na variantu
      h1All: aggregate(trades.filter((t) => t.h === 1)),
      h1Train: aggregate(train.filter((t) => t.h === 1)),
      h1Test: aggregate(test.filter((t) => t.h === 1)),
      grid,
      perCcy,
    };
  }

  // ── výpis ──────────────────────────────────────────────────────────────
  console.log("\n=== Korelace yield×policy (přímo na replay datech, ne z cizího panelu) ===");
  console.log("Měna | corr(yield,policy) | corr(yield,fund) | corr(policy,fund) | |yield| | |policy| | |fund_data|");
  for (const c of CURRENCIES) {
    const x = corr[c];
    console.log(`${c}   | ${String(x.yield_policy).padStart(6)}             | ${String(x.yield_fund).padStart(6)}          | ${String(x.policy_fund).padStart(6)}           | ${x.meanAbsYield}  | ${x.meanAbsPolicy}   | ${x.meanAbsFund}`);
  }

  console.log("\n=== h=1, VŠECHNY diffy (nejhrubší srovnání) — ALL / TRAIN / TEST(OOS) ===");
  console.log(`splitAt=${splitAt}, embargo=±${EMBARGO_DAYS}d`);
  for (const [name, r] of Object.entries(results)) {
    console.log(`${name.padEnd(22)} | ALL n=${String(r.h1All.n).padStart(5)} PF=${String(r.h1All.pf).padStart(6)} | TRAIN n=${String(r.h1Train.n).padStart(5)} PF=${String(r.h1Train.pf).padStart(6)} | TEST n=${String(r.h1Test.n).padStart(5)} PF=${String(r.h1Test.pf).padStart(6)} | flips vs baseline: ${r.flipsPct}%`);
  }

  console.log("\n=== Pásmo 'silný 3+', h=1 — kde crowding brzda i tak dovolí obchod (nejrizikovější skupina) ===");
  for (const [name, r] of Object.entries(results)) {
    const g = r.grid.find((x) => x.band === "silný 3+" && x.horizon === 1);
    console.log(`${name.padEnd(22)} | ALL n=${String(g.all.n).padStart(5)} PF=${String(g.all.pf).padStart(6)} | TRAIN PF=${String(g.train.pf).padStart(6)} | TEST PF=${String(g.test.pf).padStart(6)} ${g.robust ? "✅ROBUST" : ""}`);
  }

  console.log("\n=== Per měna, h=1, TEST (OOS) — kde de-duplikace pomáhá/škodí nejvíc ===");
  console.log("Měna | baseline PF | drop_yield_policy PF | Δ");
  for (const c of CURRENCIES) {
    const b = results.baseline.perCcy[c].test.pf;
    const d = results.drop_yield_and_policy.perCcy[c].test.pf;
    const delta = (b != null && d != null) ? +(d - b).toFixed(3) : null;
    console.log(`${c}   | ${String(b).padStart(6)}      | ${String(d).padStart(6)}                | ${delta != null ? (delta >= 0 ? "+" : "") + delta : "?"}`);
  }

  const out = {
    updated: new Date().toISOString(),
    hypothesis: "CB rozhodnutí se počítá 3× (fund_data Interest Rates kategorie + yieldAdj + policyAdj) — viz docs/ENGINE_ARCHITECTURE_MAP.md §6.1. Test de-duplikace pouze pro (2) yieldAdj a (3) policyAdj — (1) fund_data Interest Rates kategorii nelze izolovat bez re-instrumentace enginu, viz limitations.",
    source: "data/calibration_replay.json (skutečný point-in-time replay engine.js, žádný look-ahead)",
    window: cal.window,
    splitAt, embargoDays: EMBARGO_DAYS,
    method: "delta-simulace: staré total ± komponenta yield/policy, zbytek komponent beze změny (stejná technika jako scripts/simulate-proposed-score.js). Neopakuje clamp(±10) po úpravě — aproximace u extrémních skóre.",
    correlations: corr,
    results,
    limitations: [
      "fund_data (kanál 1, beat/miss kalendářních Interest Rate eventů) NENÍ v tomto testu izolován — comp.fund_data v calibration_replay.json je souhrn VŠECH kategorií (Interest Rates, Inflation, Labor, GDP, PMI, Retail Sales, External Balance, Confidence), ne jen sazeb. Izolace by vyžadovala nový plný replay s nástrojovaným engine.js (capturing category_scores['Interest Rates'] per den) — dražší (síťové fetche FRED/Frankfurter, stovky git show), neuděláno v tomto kroku.",
      "Delta-simulace nereplikuje clamp(±10) po odečtení komponent — u dní blízko extrému (score ±9 a víc) může nová hodnota mírně odchýlit od toho, co by scoreCurrency() spočítal od nuly.",
      "28 párů sdílí 8 měn → obchody v gridu jsou silně korelované, efektivní n je výrazně menší než uvedené n (stejné omezení jako v backtest-replay.js).",
      "Jedno train/test dělení na jednom historickém okně (799 dní) je jeden vzorek, ne rozdělení přes víc period — viz COUNTER_AUDIT_2026-07.md §3 'Co NEBYLO uděláno'.",
      "Žádné nové váhy se v tomhle testu NEFITUJÍ na datech (jen odečet/průměr existujících komponent) — riziko in-sample přeplácání je nižší než u kalibrace nových faktorů, ale train/test split je zachován pro konzistenci s existující metodikou repozitáře.",
    ],
  };
  fs.mkdirSync(path.join(ROOT, "data/research"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data/research/double_counting_test.json"), JSON.stringify(out, null, 2));
  console.log("\nOK · zapsáno data/research/double_counting_test.json");
})().catch((e) => { console.error("FATAL", e.stack); process.exit(1); });

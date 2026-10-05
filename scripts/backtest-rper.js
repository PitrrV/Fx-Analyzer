// RP+ER exhaustion signál — server-side backtest/kalibrace (měřicí nástroj,
// appka ho nečte, engine se tímto skriptem NEMĚNÍ — stejný princip jako
// scripts/backtest-cot.js). Stahuje si VLASTNÍ delší historii cen (Frankfurter
// pro FX, Yahoo pro zlato/US100) — appčina vlastní data/prices.json je jen
// krátké přírůstkové okno (desítky dní, roste teprve od nedávna), zatímco
// tenhle skript chce roky zpět, ať má na čem měřit.
//
// Metodika (point-in-time, bez look-aheadu): pro každý nástroj se den po dni
// počítá STEJNÉ RP(10)/ER(10) jako engine.js (getRangePosition/
// getEfficiencyRatio/getGoldRangePosition/…), ale nad libovolným historickým
// okamžikem, ne jen "posledních 10 dní". Epizoda signálu = první den, kdy RP
// vstoupí do extrému (≥80 % nebo ≤20 %) SOUČASNĚ s ER v pásmu (stejné prahy
// jako getRPERSignal v index.html) — BEZ fundamentálního filtru, protože appka
// ho od 2026-10-02 už sama nepoužívá (viz getRPERSignal v index.html — čestné
// přeměření ukázalo, že filtr kvalitu zhoršoval, ne zlepšoval). fundGate níž
// zůstává jen jako volitelný DIAGNOSTICKÝ nástroj pro zpětné srovnání, appka
// ho při živém rozhodování nepoužívá.
// Epizoda končí (= "vyřešena"), když RP opustí ZÓNU, ve které vznikla — bez
// ohledu na to, jestli ER mezitím na chvíli vypadlo z pásma.
//
// Výstup: data/backtest_rper.json — epizody + agregované statistiky (win
// rate, PF, průměr dní do vyřešení) po nástrojích i celkově.
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
const CUR = ["EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];
const YEARS_BACK = 2;
const MIN_MOVE_PCT = 0.05; // pod tímhle % je "CHOP" (šum), ne CORRECT/WRONG

async function fetchFrankfurterHist(startDate, endDate) {
  const url = `https://api.frankfurter.app/${startDate}..${endDate}?from=USD&to=${CUR.join(",")}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("Frankfurter HTTP " + r.status);
  const j = await r.json();
  if (!j || !j.rates) throw new Error("Frankfurter: prázdná odpověď");
  return j.rates; // { "2024-11-05": {EUR:.., GBP:..}, ... }
}

async function fetchYahooDaily(symbol, range) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`, {
    signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!r.ok) throw new Error("Yahoo " + symbol + " HTTP " + r.status);
  const j = await r.json();
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  const ts = res && res.timestamp, closes = res && res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close;
  if (!Array.isArray(ts) || !Array.isArray(closes)) throw new Error("Yahoo " + symbol + ": neplatná struktura");
  return ts.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
    .filter((r) => r.close != null && !isNaN(r.close));
}

// ── RP+ER point-in-time (STEJNÁ matematika jako engine.js getRangePosition/
// getEfficiencyRatio/getGoldRangePosition/getGoldEfficiencyRatio, jen
// parametrizovaná libovolným koncovým indexem místo "posledních N") ────────
function rangePositionAt(prices, endIdx, days = 10) {
  const start = Math.max(0, endIdx - days + 1);
  let mn = Infinity, mx = -Infinity, last = null;
  for (let i = start; i <= endIdx; i++) {
    const px = prices[i]; if (px == null || !isFinite(px)) continue;
    if (px < mn) mn = px; if (px > mx) mx = px; last = px;
  }
  if (last == null || !(mx > mn)) return null;
  const rp = (last - mn) / (mx - mn);
  return { rp, zone: rp <= 0.33 ? "low" : rp >= 0.67 ? "high" : "mid" };
}
function efficiencyRatioAt(prices, endIdx, days = 10) {
  const startIdx = endIdx - days; if (startIdx < 0) return null;
  const p0 = prices[startIdx], p1 = prices[endIdx];
  if (p0 == null || p1 == null || !isFinite(p0) || !isFinite(p1)) return null;
  let sumAbs = 0;
  for (let i = startIdx + 1; i <= endIdx; i++) {
    const a = prices[i - 1], b = prices[i];
    if (a == null || b == null || !isFinite(a) || !isFinite(b)) continue;
    sumAbs += Math.abs(b - a);
  }
  if (sumAbs === 0) return null;
  return { er: Math.abs(p1 - p0) / sumAbs };
}
// Denní trend v okamžiku vzniku signálu — cena vs 50denní SMA (point-in-time,
// jen z dat PŘED/VČETNĚ onsetIdx, žádný look-ahead). Vrací null, pokud na to
// ještě není dost historie (prvních ~50 dní série).
function smaAt(prices, endIdx, days = 50) {
  const start = endIdx - days + 1; if (start < 0) return null;
  let sum = 0, n = 0;
  for (let i = start; i <= endIdx; i++) {
    const px = prices[i]; if (px == null || !isFinite(px)) return null;
    sum += px; n++;
  }
  return n === days ? sum / days : null;
}

// ── Epizody: RP≥80%+ER>0.5 → SHORT / RP≤20%+ER 0.20-0.65 → LONG (stejné
// prahy jako getRPERSignal v index.html). Epizoda běží, dokud RP neopustí
// zónu, ve které vznikla (viz komentář v hlavičce souboru).
//
// fundGate(date) — volitelný: vrátí fundamentální diff (base−quote) pro dané
// datum, nebo null když pro něj appka žádnou historii nemá. Když je zadaný,
// nová epizoda se otevře jen když navíc projde STEJNOU podmínkou jako
// getRPERSignal (fundament nesmí silně SOUHLASIT se směrem chase) — a jen
// v datech, kde fundGate vůbec vrací číslo (jinak žádný verdikt, žádná
// epizoda — ne "předpokládat neutrální"). Rozlišení epizody (kdy RP opustí
// zónu) se NEMĚNÍ — filtr ovlivňuje jen to, co se POČÍTÁ za spuštění, ne jak
// se měří výsledek, ať jde filtrovaná a nefiltrovaná varianta čestně srovnat.
function findEpisodes(dates, prices, fundGate) {
  const NEUTRAL = 0.3;
  const episodes = [];
  let open = null;
  for (let i = 0; i < prices.length; i++) {
    const rp = rangePositionAt(prices, i, 10);
    const er = efficiencyRatioAt(prices, i, 10);
    const zone = rp ? (rp.rp >= 0.8 ? "high" : rp.rp <= 0.2 ? "low" : null) : null;

    if (open && zone !== open.zone) {
      open.resolvedIdx = i; open.resolvedDate = dates[i]; open.resolvedPrice = prices[i];
      episodes.push(open); open = null;
    }
    if (!open && rp && er) {
      let diff = null;
      if (fundGate) { diff = fundGate(dates[i]); if (diff == null) continue; }
      if (zone === "high" && er.er > 0.5 && !(fundGate && diff < -NEUTRAL)) {
        open = { type: "SHORT", zone: "high", onsetIdx: i, onsetDate: dates[i], onsetPrice: prices[i], onsetRP: +rp.rp.toFixed(3), onsetER: +er.er.toFixed(3) };
      } else if (zone === "low" && er.er >= 0.2 && er.er < 0.65 && !(fundGate && diff > NEUTRAL)) {
        open = { type: "LONG", zone: "low", onsetIdx: i, onsetDate: dates[i], onsetPrice: prices[i], onsetRP: +rp.rp.toFixed(3), onsetER: +er.er.toFixed(3) };
      }
    }
  }
  if (open) { open.ongoing = true; episodes.push(open); }

  for (const ep of episodes) {
    [5, 10, 20].forEach((h) => {
      const idx = ep.onsetIdx + h;
      if (idx < prices.length) ep["ret" + h + "d"] = +(((prices[idx] - ep.onsetPrice) / ep.onsetPrice) * 100).toFixed(3);
    });
    const sma50 = smaAt(prices, ep.onsetIdx, 50);
    if (sma50 != null) {
      ep.trendAtOnset = ep.onsetPrice > sma50 ? "UP" : ep.onsetPrice < sma50 ? "DOWN" : "FLAT";
      // "aligned" = signál sází na směr, který SOUHLASÍ s denním trendem (SHORT
      // v downtrendu, LONG v uptrendu — pullback ve směru trendu); "counter" =
      // sází PROTI dennímu trendu (SHORT v uptrendu, LONG v downtrendu — čistá
      // sázka na vyčerpání/zvrat). FLAT (cena == SMA50) se nezapočítává nikam.
      ep.trendAligned = ep.trendAtOnset === "FLAT" ? null : (ep.type === "SHORT" ? ep.trendAtOnset === "DOWN" : ep.trendAtOnset === "UP");
    } else {
      ep.trendAtOnset = null; ep.trendAligned = null;
    }
    if (ep.ongoing) continue;
    const pctChange = ((ep.resolvedPrice - ep.onsetPrice) / ep.onsetPrice) * 100;
    ep.daysToResolution = ep.resolvedIdx - ep.onsetIdx;
    ep.pctChange = +pctChange.toFixed(3);
    const predictedDown = ep.type === "SHORT";
    const moved = Math.abs(pctChange) > MIN_MOVE_PCT;
    const correct = moved && ((predictedDown && pctChange < 0) || (!predictedDown && pctChange > 0));
    ep.outcome = !moved ? "CHOP" : correct ? "CORRECT" : "WRONG";
  }
  return episodes;
}

function summarize(episodes) {
  const resolved = episodes.filter((e) => !e.ongoing);
  const correct = resolved.filter((e) => e.outcome === "CORRECT");
  const wrong = resolved.filter((e) => e.outcome === "WRONG");
  const chop = resolved.filter((e) => e.outcome === "CHOP");
  const decided = correct.length + wrong.length;
  const gp = correct.reduce((s, e) => s + Math.abs(e.pctChange), 0);
  const gl = wrong.reduce((s, e) => s + Math.abs(e.pctChange), 0);
  return {
    total: episodes.length, resolved: resolved.length, ongoing: episodes.length - resolved.length,
    correct: correct.length, wrong: wrong.length, chop: chop.length,
    winRate: decided ? +((correct.length / decided) * 100).toFixed(1) : null,
    pf: gl > 0 ? +(gp / gl).toFixed(2) : (gp > 0 ? null : null),
    avgDaysToResolution: resolved.length ? +(resolved.reduce((s, e) => s + e.daysToResolution, 0) / resolved.length).toFixed(1) : null,
  };
}

(async () => {
  const today = new Date();
  const startDate = new Date(today.getTime() - YEARS_BACK * 365 * 86400000).toISOString().slice(0, 10);
  const endDate = today.toISOString().slice(0, 10);

  console.log(`Stahuji historické FX kurzy ${startDate} → ${endDate}…`);
  const ratesByDate = await fetchFrankfurterHist(startDate, endDate);
  const fxDates = Object.keys(ratesByDate).sort();
  console.log(`FX: ${fxDates.length} obchodních dní`);

  const results = {};
  const fxSeries = {}; // pair -> {dates, prices} — znovu použito níž pro fundamentálně filtrovanou variantu
  for (const { pair, base, quote } of STANDARD_PAIRS) {
    const dates = [], prices = [];
    for (const d of fxDates) {
      const row = ratesByDate[d];
      const b = base === "USD" ? 1 : row[base], q = quote === "USD" ? 1 : row[quote];
      if (b == null || q == null) continue;
      dates.push(d); prices.push(q / b);
    }
    if (prices.length < 30) { console.log(`${pair}: málo dat (${prices.length}), přeskakuji`); continue; }
    fxSeries[pair] = { dates, prices, base, quote };
    const episodes = findEpisodes(dates, prices);
    results[pair] = { episodes, stats: summarize(episodes) };
    console.log(`${pair}: ${prices.length} dní, ${episodes.length} epizod, win rate ${results[pair].stats.winRate}%`);
  }

  console.log("Stahuji historii zlata (Yahoo GC=F, 2y)…");
  try {
    const goldRows = await fetchYahooDaily("GC=F", "2y");
    const dates = goldRows.map((r) => r.date), prices = goldRows.map((r) => r.close);
    const episodes = findEpisodes(dates, prices);
    results.XAUUSD = { episodes, stats: summarize(episodes) };
    console.log(`XAUUSD: ${prices.length} dní, ${episodes.length} epizod, win rate ${results.XAUUSD.stats.winRate}%`);
  } catch (e) { console.log("Zlato ERR", e.message); }

  console.log("Stahuji historii US100 (Yahoo ^NDX, 1y — 2y na tomhle indexu vrací 404, viz scripts/fetch-us100-price.js)…");
  try {
    // fetchYahooDaily() si symbol sama URL-enkóduje — "^NDX" SUROVĚ, ne
    // předem enkódované "%5ENDX" (to by se enkódovalo podruhé na neplatné
    // "%255ENDX" → Yahoo 404, živě odchyceno v prvních dvou bězích workflow).
    const us100Rows = await fetchYahooDaily("^NDX", "1y");
    const dates = us100Rows.map((r) => r.date), prices = us100Rows.map((r) => r.close);
    const episodes = findEpisodes(dates, prices);
    results.US100 = { episodes, stats: summarize(episodes) };
    console.log(`US100: ${prices.length} dní, ${episodes.length} epizod, win rate ${results.US100.stats.winRate}%`);
  } catch (e) { console.log("US100 ERR", e.message); }

  const allEpisodes = Object.values(results).flatMap((r) => r.episodes);
  const overall = summarize(allEpisodes);
  const byType = { SHORT: summarize(allEpisodes.filter((e) => e.type === "SHORT")), LONG: summarize(allEpisodes.filter((e) => e.type === "LONG")) };

  // ── Fundamentální filtr — DIAGNOSTICKÉ srovnání (appka ho při živém
  // rozhodování od 2026-10-02 už nepoužívá, viz getRPERSignal v index.html —
  // čestné přeměření ukázalo 70.1 %/PF1.28 bez filtru vs 63.2 %/PF1.03 s ním,
  // tedy filtr kvalitu zhoršoval). Necháno tu jen pro budoucí zpětnou kontrolu.
  // Jen pro FX páry, jen v okně, kde appka reálně má historii denního
  // fundamentálního skóre (data/engine_hist.json — ~2 měsíce, zlato/US100
  // tuhle historii vůbec nemají). Srovnání je čestné: nefiltrovaná varianta
  // se počítá ZNOVU, omezená na STEJNÉ okno a STEJNÉ páry, ať rozdíl ve
  // výsledku ukazuje efekt filtru, ne jen víc dat. ──────
  let fundamentalComparison = null;
  try {
    const engineHist = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "engine_hist.json"), "utf8"));
    const fundDates = Object.keys(engineHist.days || {}).sort();
    if (fundDates.length >= 10) {
      const fundStart = fundDates[0], fundEnd = fundDates[fundDates.length - 1];
      console.log(`\nFundamentální filtr: historie skóre ${fundStart} → ${fundEnd} (${fundDates.length} dní) — počítám srovnání pro FX…`);
      const TOLERANCE_DAYS = 3;
      function scoreOnOrBefore(cur, targetDate) {
        const tMs = new Date(targetDate + "T00:00:00Z").getTime();
        let best = null, bestDiff = Infinity;
        for (const d of fundDates) {
          const dMs = new Date(d + "T00:00:00Z").getTime();
          const delta = tMs - dMs;
          if (delta >= 0 && delta <= TOLERANCE_DAYS * 86400000 && delta < bestDiff) {
            // engineHist.days[d].cur[cur] je OBJEKT {score,comp,cot_pct} (viz
            // snapshot-engine.js), ne holé číslo — .score vytáhnout, jinak
            // typeof v==="number" nikdy neprojde a fundGate vrací null pro
            // úplně všechno (živě odchyceno v prvním běhu tohohle srovnání).
            const rec = engineHist.days[d].cur[cur]; const v = rec && rec.score;
            if (typeof v === "number") { best = v; bestDiff = delta; }
          }
        }
        return best;
      }

      const filteredByPair = {}, unfilteredByPair = {};
      let allFilteredEp = [], allWindowUnfilteredEp = [];
      for (const { pair, base, quote } of STANDARD_PAIRS) {
        const s = fxSeries[pair]; if (!s) continue;
        const fundGate = (date) => {
          const b = scoreOnOrBefore(base, date), q = scoreOnOrBefore(quote, date);
          return (b == null || q == null) ? null : +(b - q).toFixed(2);
        };
        const filteredEp = findEpisodes(s.dates, s.prices, fundGate);
        filteredEp.forEach((e) => { e.pair = pair; });
        const unfilteredInWindow = results[pair].episodes.filter((e) => e.onsetDate >= fundStart && e.onsetDate <= fundEnd);
        filteredByPair[pair] = summarize(filteredEp);
        unfilteredByPair[pair] = summarize(unfilteredInWindow);
        allFilteredEp = allFilteredEp.concat(filteredEp);
        allWindowUnfilteredEp = allWindowUnfilteredEp.concat(unfilteredInWindow);
        console.log(`  ${pair}: bez filtru (okno) ${unfilteredByPair[pair].winRate}% (n=${unfilteredByPair[pair].total}) → s filtrem ${filteredByPair[pair].winRate}% (n=${filteredByPair[pair].total})`);
      }
      fundamentalComparison = {
        window: { start: fundStart, end: fundEnd, days: fundDates.length },
        note: "Jen FX (zlato/US100 nemají historii denního fundamentálního skóre). 'unfiltered' = STEJNÉ okno/páry jako 'filtered', ne celé 2leté okno nahoře — čestné srovnání efektu filtru samotného. 'filteredEpisodes' = syrové epizody (s onsetDate/resolvedDate) PŘESNĚ v tom tvaru, co by appka před 2026-10-02 reálně ukázala/poslala na Telegram — pro zpětnou rekonstrukci toho, co appka skutečně alertovala v libovolném dílčím okně.",
        unfiltered: summarize(allWindowUnfilteredEp),
        filtered: summarize(allFilteredEp),
        filteredEpisodes: allFilteredEp,
        perPair: Object.fromEntries(STANDARD_PAIRS.filter((p) => filteredByPair[p.pair]).map((p) => [p.pair, { unfiltered: unfilteredByPair[p.pair], filtered: filteredByPair[p.pair] }])),
      };
      console.log(`\nCelkem (okno ${fundStart}→${fundEnd}): bez filtru ${fundamentalComparison.unfiltered.winRate}% (n=${fundamentalComparison.unfiltered.total}) → s filtrem ${fundamentalComparison.filtered.winRate}% (n=${fundamentalComparison.filtered.total})`);
    } else {
      console.log("Fundamentální historie příliš krátká (data/engine_hist.json), přeskakuji srovnání.");
    }
  } catch (e) { console.log("Fundamentální srovnání ERR", e.message); }

  // ── COT pozicování vs. RP+ER — stejná myšlenka jako fundamentální filtr
  // výš, ale COT týdenní historie (data/cot_hist.json) pokrývá CELÉ 2leté
  // okno (na rozdíl od denního kalendářního skóre, co appka trackuje jen
  // ~3 měsíce) — tohle srovnání je proto na mnohem větším a spolehlivějším
  // vzorku. Pro každou (nefiltrovanou, VYŘEŠENOU — ongoing vynechány, u nich
  // není co počítat do win rate) technickou epizodu najde COT skóre base/
  // quote k datu vzniku (nejbližší PŘEDCHOZÍ týdenní report, tolerance 10
  // dní — COT vychází jednou týdně, ne denně) a rozdělí do stejných tří
  // košů jako kalendářní fundament (souhlasí/nesouhlasí/neutrál se směrem
  // chase, stejný práh NEUTRAL=0.3) — čistě diagnostické, appka COT jako
  // filtr RP+ER signálu nepoužívá, dokud se tady neukáže, že to fakt pomáhá.
  let cotComparison = null;
  try {
    const cotHist = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "cot_hist.json"), "utf8"));
    const cotDates = Object.keys(cotHist.weeks || {}).sort();
    if (cotDates.length >= 12) {
      const COT_TOLERANCE_DAYS = 10;
      function cotScoreOnOrBefore(cur, targetDate) {
        const tMs = new Date(targetDate + "T00:00:00Z").getTime();
        let best = null, bestDiff = Infinity;
        for (const d of cotDates) {
          const dMs = new Date(d + "T00:00:00Z").getTime();
          const delta = tMs - dMs;
          if (delta >= 0 && delta <= COT_TOLERANCE_DAYS * 86400000 && delta < bestDiff) {
            const v = cotHist.weeks[d].scores && cotHist.weeks[d].scores[cur];
            if (typeof v === "number") { best = v; bestDiff = delta; }
          }
        }
        return best;
      }
      const NEUTRAL = 0.3;
      const byBucket = { souhlas: [], proti: [], neutral: [] };
      const perPairCot = {};
      for (const { pair, base, quote } of STANDARD_PAIRS) {
        const r = results[pair]; if (!r) continue;
        const tagged = [];
        for (const ep of r.episodes) {
          if (ep.ongoing) continue;
          const b = cotScoreOnOrBefore(base, ep.onsetDate), q = cotScoreOnOrBefore(quote, ep.onsetDate);
          if (b == null || q == null) continue;
          const diff = +(b - q).toFixed(2);
          const bucket = ep.type === "SHORT"
            ? (diff > NEUTRAL ? "proti" : diff < -NEUTRAL ? "souhlas" : "neutral")
            : (diff < -NEUTRAL ? "proti" : diff > NEUTRAL ? "souhlas" : "neutral");
          const taggedEp = Object.assign({}, ep, { pair, cotDiff: diff, cotBucket: bucket });
          byBucket[bucket].push(taggedEp);
          tagged.push(taggedEp);
        }
        if (tagged.length) perPairCot[pair] = {
          souhlas: summarize(tagged.filter((e) => e.cotBucket === "souhlas")),
          proti: summarize(tagged.filter((e) => e.cotBucket === "proti")),
          neutral: summarize(tagged.filter((e) => e.cotBucket === "neutral")),
        };
      }
      const allTagged = [].concat(byBucket.souhlas, byBucket.proti, byBucket.neutral);
      cotComparison = {
        window: { start: cotDates[0], end: cotDates[cotDates.length - 1], weeks: cotDates.length },
        note: "COT (týdenní, scores[] = stejné blendované skóre jako COT percentil v appce) spárované s onsetDate KAŽDÉ vyřešené nefiltrované technické epizody za celé 2leté okno — tolerance 10 dní (týdenní cadence COT reportu). 'souhlas'/'proti'/'neutral' = stejná konvence jako fundBucket u kalendářního fundamentu (getRPERSignal), jen jiný zdroj skóre. 'filteredOutSouhlas' = co by appka ukázala, kdyby filtrovala COT stejně jako dřív kalendářní fundament — pro přímé srovnání, jestli by COT filtr pomohl tam, kde kalendářní fundament nepomohl.",
        byBucket: { souhlas: summarize(byBucket.souhlas), proti: summarize(byBucket.proti), neutral: summarize(byBucket.neutral) },
        filteredOutSouhlas: summarize([].concat(byBucket.proti, byBucket.neutral)),
        unfiltered: summarize(allTagged),
        perPair: perPairCot,
      };
      console.log(`\nCOT srovnání (${cotComparison.window.start}→${cotComparison.window.end}, ${allTagged.length} spárovaných epizod): souhlas ${cotComparison.byBucket.souhlas.winRate}% (n=${cotComparison.byBucket.souhlas.total}) · neutral ${cotComparison.byBucket.neutral.winRate}% (n=${cotComparison.byBucket.neutral.total}) · proti ${cotComparison.byBucket.proti.winRate}% (n=${cotComparison.byBucket.proti.total})`);
    } else {
      console.log("COT historie příliš krátká (data/cot_hist.json), přeskakuji COT srovnání.");
    }
  } catch (e) { console.log("COT srovnání ERR", e.message); }

  // ── Denní trend vs. signál — sází RP+ER vždy PROTI dennímu trendu, nebo
  // jen "pullback" ve směru trendu? trendAligned je spočítaný už ve
  // findEpisodes (cena vs 50denní SMA v den vzniku, point-in-time, bez
  // look-aheadu) — tady se jen agreguje přes VŠECHNY nástroje (FX+zlato+
  // US100) a VYŘEŠENÉ epizody (ongoing vynechány, u nich není co počítat do
  // win rate). Jen Daily — appka ani backtest zatím nemají žádný zdroj
  // intradenních (4H) cen, viz diskuze s uživatelem 2026-10-05.
  const trendTagged = allEpisodes.filter((e) => !e.ongoing && e.trendAligned !== null);
  const trendAligned = trendTagged.filter((e) => e.trendAligned === true);
  const trendCounter = trendTagged.filter((e) => e.trendAligned === false);
  const trendComparison = {
    note: "Denní trend = cena vs 50denní SMA v den vzniku signálu (point-in-time). 'aligned' = signál souhlasí se směrem denního trendu (SHORT v downtrendu / LONG v uptrendu — pullback). 'counter' = signál sází PROTI dennímu trendu (SHORT v uptrendu / LONG v downtrendu — čistý fade/vyčerpání). Přes všechny nástroje (FX+zlato+US100), jen vyřešené epizody. Žádná 4H data v pipeline nejsou (appka ani backtest žádný zdroj intradenních cen nemá) — toto je jen Daily.",
    aligned: summarize(trendAligned),
    counter: summarize(trendCounter),
    byTypeAligned: { SHORT: summarize(trendAligned.filter((e) => e.type === "SHORT")), LONG: summarize(trendAligned.filter((e) => e.type === "LONG")) },
    byTypeCounter: { SHORT: summarize(trendCounter.filter((e) => e.type === "SHORT")), LONG: summarize(trendCounter.filter((e) => e.type === "LONG")) },
  };
  console.log(`\nDenní trend vs. signál (n=${trendTagged.length}): ALIGNED (ve směru trendu) ${trendComparison.aligned.winRate}% (n=${trendComparison.aligned.total}) · COUNTER (proti trendu) ${trendComparison.counter.winRate}% (n=${trendComparison.counter.total})`);

  const out = {
    generated: new Date().toISOString(),
    methodology: "Point-in-time RP(10)/ER(10), STEJNÉ prahy jako getRPERSignal (index.html), BEZ fundamentálního filtru — appka od 2026-10-02 filtr sama nepoužívá (čestné přeměření ukázalo, že kvalitu zhoršoval, ne zlepšoval), takže tohle číslo teď odpovídá PŘESNĚ tomu, co appka živě posílá. Epizoda = od prvního dne v extrému+ER pásmu do dne, kdy RP opustí tu zónu. MIN_MOVE_PCT=" + MIN_MOVE_PCT + "% (pod tím je CHOP). fundamentalComparison = diagnostické srovnání JEN pro FX v okně, kde appka má historii denního fundamentálního skóre — ukazuje, že filtr by kvalitu NEzlepšil, proto appka filtr nepoužívá.",
    range: { startDate, endDate, years: YEARS_BACK },
    overall, byType,
    fundamentalComparison,
    cotComparison,
    trendComparison,
    perInstrument: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.stats])),
    episodes: results,
  };

  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "backtest_rper.json"), JSON.stringify(out));
  console.log("\n=== CELKEM ===");
  console.log(JSON.stringify({ overall, byType }, null, 2));
  console.log("Zapsáno data/backtest_rper.json");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });

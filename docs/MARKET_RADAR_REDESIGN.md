# Market Radar → Fundamental Data Engine — audit & redesign

> Cíl: přestavět Market Radar z news-agregátoru na **datovou vrstvu Forex Analyzeru**,
> která poskytuje per-měnu fundamentální obraz (8 majorů: USD, EUR, GBP, JPY, CHF, AUD, NZD, CAD).
> Bez akcií, bez krypta, bez jednotlivých firem. Vše zaměřené na měny.
>
> Status: NÁVRH (nic z toho zatím není implementováno). Slouží pro budoucí nasazení.

## 0. Verdikt

Současný `radar.html` je **kvalitativní agregátor titulků** (RSS + LLM tón).
Požadavek (Fundamental Score, Rate/Inflation Bias…) je **kvantitativní makro engine**.
Z titulků spolehlivý bias spočítat nelze — k tomu jsou potřeba čísla (actual vs forecast
vs trend, výnosy, COT), a ta už z ~80 % existují v repu:

- `data/calendar.json` — ekonomický kalendář (ForexFactory), ~857 událostí s **actual/forecast/previous**, cron `calendar.yml` každých 15 min.
- `data/prices.json` — FX kurzy (frankfurter) + historie, cron `prices.yml` hodinově.
- `data/retail_hist.json` — retail sentiment (long/short %) per pár, cron `retail.yml` každých 30 min.
- Vzor: GitHub Actions → `scripts/fetch-*.js` → commit JSON → frontend čte. „Backend-less backend".

**Market Radar tato data vůbec nečte.** To je hlavní nález.

➡️ Doporučení: NErebuild na zelené louce. Evolvovat na **data-first engine** nad existujícími
`data/*.json` + nové free zdroje (FRED, DBnomics, CFTC COT) → per-měnu bias → sdílený JSON
kontrakt (`data/fundamentals.json`), který čte Radar i Analyzer. News/AI = kvalitativní vrstva navrch.

## 1. Audit současného Radaru

### Ponechat
- Backend-less ETL vzor (Actions → commit JSON) — správná architektura, neobjevovat kolo.
- News pipeline: clustering (entity+Jaccard), source-tiering, credibility (rumor/confirmed),
  crypto-filtr, Gemini/OpenRouter fallback + cooldown, per-měnu `affects`.

### Slabá místa
1. Radar nečte `data/calendar.json/prices/retail` → ignoruje **surprise** (actual−forecast), nejcennější signál.
2. „Score" = LLM odhad důležitosti → nereprodukovatelné, nekalibrované, drahé, šumí.
3. Heat-mapa = počet pos/neg titulků → proxy nálady, ne fundament; zmanipulovatelná objemem.
4. Dva odpojené systémy (radar.html vs engine.js) → duplicita, žádný sdílený kontrakt, dvojí údržba.
5. Klientský běh → „po seanci automaticky" nefunguje bez otevřeného prohlížeče; CORS závislost (rss2json/allorigins) = SPOF.
6. Nevyužité API/data: COT (rozpracované v engine.js), FRED/DBnomics vůbec, yields nikde.
7. AI jen hodnotí tón → nehodnotí horizont, změnu režimu, posun očekávání sazeb, confidence.
8. localStorage per-zařízení → stav se nesdílí PC↔mobil↔Analyzer, skóre se nedá backtestovat.

### Odstranit / degradovat
- MOCK data → jen offline fallback.
- Squawk / scrolling ticker → volitelné UI, Low.
- Indexy (US100/500/30) jako samostatné objekty → jen „risk sentiment driver".
- Media-image heat jako fundament → nahradit reálným bias z dat.

## 2. Cílová architektura

```
L0 INGESTION (GitHub Actions cron, server) — rozšířit scripts/
   adaptéry: FRED · DBnomics · CFTC-COT · calendar.json · prices.json · retail.json · CB weby · RSS
   (každý zdroj izolovaný, s fallbackem)
L1 NORMALIZACE → {currency, indicator, actual, forecast, previous, datetime, unit, freq, source}
L2 SCORING ENGINE (server, čistá matematika)
   surprise z-score → pilíře → per-měnu bias → data/fundamentals.json
L3 AI OVERLAY (LLM jako rozhodčí, ne zdroj čísel) — importance, horizont, regime/rate-shift, confidence
L4 PREZENTACE — radar.html (per-měnu dashboard) + Forex Analyzer čtou STEJNÝ JSON
```

Princip: čísla počítá deterministický engine (auditovatelné), AI jen kvalifikuje a vysvětluje.

## 3. Model každé měny (pilíře)

| Pilíř | Vstup | Poznámka |
|------|-------|----------|
| Rate Bias | policy rate path, CPI překvapení, CB tón (calendar+FRED+AI minutes) | jádro |
| Inflation Bias | CPI/Core/PPI actual vs forecast vs trend | hawkish/dovish |
| Growth Bias | GDP/PMI/Retail/IndProd překvapení | cyklus |
| Employment | NFP/unemployment/claims překvapení | |
| External | trade balance/current account, terms-of-trade | |
| Yields / Real Yield | nominál − inflace (FRED/DBnomics) | carry, hlavní FX driver |
| Positioning | COT (CFTC) + retail (kontrariánsky) | extrémy = riziko obratu |
| Fiscal/Credit | deficit, dluh, rating, aukce | nízká freq |
| Risk Sentiment | VIX/SPX/safe-haven | globální režim |
| Seasonality | historický měsíční bias | overlay |

Vzorec: `surprise = (actual − forecast) / σ(historická překvapení)`, znaménko dle polarity
(vyšší CPI = krátkodobě hawkish = + pro měnu). Pilíř = vážený průměr z-skóre →
Fundamental Score, Overall Strength, Confidence (= svěžest dat × shoda pilířů).

## 4. Zdroje dat (prioritně)

| Zdroj | Co | Klíč/cena | CORS | Priorita |
|------|----|-----------|------|----------|
| FRED | sazby, výnosy, CPI, GDP, unemployment, real yield | free klíč | server | HIGH |
| DBnomics | 1 API nad FRED/Eurostat/OECD/IMF/BIS (všech 8 zemí) | free, bez klíče | server | HIGH |
| CFTC COT | institucionální pozice | free | server | HIGH |
| calendar.json (FF) | actual/forecast/previous = překvapení | máte | hotovo | HIGH (reuse) |
| CB weby/RSS (Fed,ECB,BoE,BoJ,SNB,RBA,RBNZ,BoC) | rozhodnutí, minutes, projevy → AI tón | free | server | HIGH |
| prices.json + retail_hist.json | rel. síla, kontrariánské pozice | máte | hotovo | MED (reuse) |
| BLS / BEA (US) | granularita US | free klíč | server | MED |
| OECD / IMF / World Bank | strukturální, prognózy | free | server | LOW-MED |
| TradingEconomics | cross-country konsenzy | placené (free limit) | server | optional |
| Ratingy (S&P/Moody's/Fitch) | rating, výhled | bez free API | scrape/manual | LOW |

Doporučené free jádro: FRED + DBnomics + CFTC + calendar.json + CB RSS. Vše přes server (Actions) kvůli CORS.

## 5. AI analýza (strukturovaná)

```
{ currency, event, importance:0-100, confidence:0-1,
  direction:"bull|bear|neutral",
  horizon:{short,medium,long}, magnitude,
  regimeChange:bool, rateExpectationShift:bool, rationale, sources:[...] }
```
AI nesahá na číselné jádro (to počítá engine ze surprise). U high-impact adversariální verifikace (2–3 hlasy) → confidence.
Parsování minutes/projevů → hawkish/dovish (−1…+1) do Rate Bias.

## 6. Filtrace & skórování

- `ImportanceScore = w1·indikátor_tier + w2·|surprise| + w3·měnová_relevance + w4·source_tier`
- `Confidence = shoda_pilířů × spolehlivost_zdroje × svěžest_dat`
- Zobrazí se jen nad prahem; vše ostatní tiše vstupuje do skóre. Položka: Importance / Confidence / Dopad / Kategorie / Priorita.

## 7. Výstupní kontrakt pro Analyzer — `data/fundamentals.json`

```json
{ "updated":"…",
  "currencies":{
    "USD":{ "fundamentalScore":0.62, "strength":78,
      "biases":{"rate":0.7,"inflation":0.5,"growth":0.3,"employment":0.4,
                "yields":0.8,"liquidity":-0.2,"external":-0.1,"fiscal":-0.3},
      "riskSentiment":"risk-off", "positioning":{"cot":0.4,"retail":-0.6},
      "confidence":0.81, "regime":"late-cycle", "drivers":[], "asOf":"…" } },
  "matrix":{ "EURUSD":{"bias":-0.55,"conf":0.7} }
}
```
Analyzer i Radar ho jen `fetch`nou (stejný origin). To je ta „datová vrstva".

## 8. Nové profi funkce

Economic Surprise Index (per měna) · Rate-expectations tracker · 8×8 relativní síla ·
Regime detector · Real-yield/carry monitor · COT extrémy + retail kontrarián ·
Event radar (odpočet k releasům) · Divergence alert (cena vs fundament) ·
Snapshot historie skóre (backtest kalibrace).

## 9. Optimalizace

| Oblast | Teď | Návrh |
|------|-----|-------|
| DB | localStorage per-zařízení | verzované data/*.json → časem SQLite/Cloudflare D1 |
| Cache | ad-hoc | ETag/If-Modified + TTL per série |
| API arch. | klient volá vše | server adaptéry, klient čte hotový JSON |
| Scheduler | „když je otevřeno" | Actions cron per třída dat + workflow_dispatch |
| AI workflow | per-refresh | server batch po releasu, cache dle hash, judge u high-impact |
| Scraping | rss2json/allorigins z klienta | server-side fetch v Actions, víc fallbacků |
| Logging | console | run-log JSON (co/odkud/kolik/chyby) committed |
| Monitoring | žádné | „data freshness" alert (stará série → badge/notifikace) |
| Chyby | tiché try/catch | per-zdroj izolace, degradace, „poslední dobrá hodnota", viditelný stav |
| Výkon | OK | předpočítané skóre na serveru, klient jen renderuje |

## 10. + / − vs současný Radar

**+** Reálný fundament z čísel; reprodukovatelné/backtestovatelné skóre; jeden sdílený kontrakt
Radar↔Analyzer; levné a odolné; AI dělá to, v čem je dobrá; „po seanci automaticky" doopravdy.

**−** Výrazně větší rozsah (týdny); údržba zdrojů/scraping; GitHub Actions limity; kalibrace vah/σ;
rostoucí AI náklady; riziko over-engineeringu → jít fázovaně.

## 11. Fázový roadmap

1. **Fáze 1 (HIGH, nízká náročnost, velký dopad):** Radar čte `calendar.json` → počítá surprise; napojit COT+retail do pozičního pilíře.
2. **Fáze 2 (HIGH, střední):** `scripts/fetch-fundamentals.js` → `data/fundamentals.json`; Analyzer ho začne číst.
3. **Fáze 3 (HIGH/MED, střední):** FRED + DBnomics (yields/real yield/CPI/GDP all-8); CB RSS + AI tón na minutes → Rate Bias.
4. **Fáze 4 (MED):** Surprise Index, 8×8 matice, regime detector, event radar, snapshot historie.
5. **Fáze 5 (MED/LOW):** monitoring freshness, run-logy, per-zdroj fallbacky, cache TTL.

Degradovat/odstranit: media-image heat jako fundament, squawk/ticker → volitelné, mock z hlavní cesty, indexy jako samostatné objekty.

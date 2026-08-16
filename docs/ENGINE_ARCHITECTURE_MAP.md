# Mapa architektury FX Analyzer enginu — referenční dokument pro AI agenta

*Vytvořeno: 2026-08-16 · Zdroj: `engine.js` (živý kód, ne návrh) + `docs/RESEARCH_AUDIT_2026-07.md`,
`docs/ARCHITECTURE_AUDIT_2026-07.md`, `docs/COUNTER_AUDIT_2026-07.md` (tři nezávislé statistické
audity), `data/calibration.json` (běžící backtest kalibrace).*

**Účel dokumentu:** popsat přesně, JAK engine dnes počítá skóre, ranking a forecast — ne jak by
počítat MĚL. Kde existuje návrh na zlepšení (V3 architektura v auditech), je to výslovně
označeno jako **neimplementováno**. Cílem je, aby AI agent uměl číst výstup Analyzeru správně:
znal jednotky, věděl co je nezávislý signál a co přepočítané totéž, a uměl rozpoznat, kdy je
číslo orientační heuristika a kdy ověřený edge.

**Toto NENÍ implementační plán.** Žádná ze zmíněných změn (V3 architektura, per-měnové COT
subskupiny, VIX gate...) není v tomto kroku prováděna.

---

## 0. Rychlá orientace — co je co

| Otázka | Odpověď |
|---|---|
| Jedno skóre = jedna měna, nebo jeden pár? | **Měna.** `scoreCurrency()` počítá skóre pro 8 měn (`CURRENCIES`), rozsah **−10..+10**. Pár nemá vlastní skóre — má `diff = score(base) − score(quote)`. |
| Kde skóre vzniká? | `scoreCurrency(events, currency, cotData, sentData)` — engine.js:2359 |
| Kde vzniká ranking párů? | `rankPairs(scores, aiAnalyses)` — engine.js:2629, řadí 28 párů (`STANDARD_PAIRS`) podle `|diff|` |
| Kde vzniká "kolik tomu věřit"? | `calcConvictionScore(pair, scores, aiAnalyses)` — engine.js:2294, 0–5 hvězd |
| Kde vzniká 14denní forecast? | `buildForecastV5(pair, scores, calData, upcoming)` — engine.js:2135, pravděpodobnost 35–75 % |
| Je něco z toho ověřený edge? | **Jen timing vrstva RP+ER** (engine.js:2817–2853) — a ta se do skóre/ranku/conviction vůbec nepromítá. Samotné skóre/diff v aktuální podobě NEMÁ potvrzený edge (viz §6). |
| Jak se agent má dozvědět detail konkrétního páru? | `buildPairDossier(pairSym, scores, calData, upcoming, aiAnalyses)` — engine.js:3279. Appka to už dělá pro vlastního AI Coache; agent by měl číst STEJNOU funkci, ne přepočítávat vlastní verzi. |

---

## 1. Datový tok od surových dat po forecast

```
                     ┌─────────────────────────────────────────────┐
                     │  SERVEROVÉ CRONY (.github/workflows/*.yml)   │
                     │  scripts/fetch-{calendar,cot,prices,retail,  │
                     │  oil,vix}.js → data/*.json, commit [skip ci] │
                     └────────────────────┬──────────────────────┘
                                          │ fetchAction*() — čtou data/*.json přímo
                                          ▼
    ┌───────────────────────────────────────────────────────────────────┐
    │ KALENDÁŘ         COT              RETAIL           CENY  VIX  OIL  │
    │ calendar.json    cot_hist.json    retail_hist.json prices.json     │
    │ (15 měs. hist.   (týdenní CFTC    (30min, per pár   .json .json    │
    │  + 14d dopředu)   TFF pozice)      long %)                         │
    └──────┬───────────────┬────────────────┬────────────────┬────┬────┘
           │               │                │                │    │
           ▼               ▼                ▼                ▼    ▼
     mergeFFHistory   getLatestCOTScores  getCanonicalSent  _PRICES _VIX_LATEST
     (dedup+merge      (poslední týden     (poslední bod            │
      s lokální hist.)  ze SDÍLENÉ hist.)   .ccy pole)               │
           │               │                │                       │
           └───────┬───────┴────────┬───────┘                       │
                    ▼                ▼                               │
            calScoring        cot / sent                             │
        (capEventsWindow,     (currency-level)                       │
         80 týdnů okno)              │                               │
                    │                │                               ▼
                    └───────┬────────┴──────► scoreCurrency() ◄── CB_POLICY_DATA
                             per měnu (×8)      │                CENTRAL_BANK_RATES
                                                 │                REAL_CPI_DATA
                                                 │                (auto z kalendáře
                                                 │                 + manuální override)
                             ┌───────────────────┴────────────────────┐
                             ▼                                        ▼
                        rankPairs()                          buildForecastV5()
                     (diff, korelační dedup)                (14denní pravděp.)
                             │
                             ▼
                    calcConvictionScore()
                       (0–5 hvězd)
                             │
                             ▼
                    buildPairDossier()  ── jediný zdroj pravdy pro AI Coache
```

**Klíčové pravidlo:** `calData` (15měsíční historie) a `upcoming` (příštích 14 dní) NEJSOU dva
nezávislé zdroje — `upcoming` se v aktuálním kódu odvozuje z `calData` filtrem na budoucí datum
(`deriveUpcomingFromEvents(cal)`, engine.js:1735). `mergeEvents(calData, upcoming)` (engine.js:2455)
je pak jen dedup podle klíče `event|country|den` — pole se slévají (ne přepisují), aby záznam
s `actual` nezmizel pod záznamem bez něj.

---

## 2. Datové zdroje — priorita, frekvence, co dělat při výpadku

### 2.1 Ekonomický kalendář

Priorita zdrojů (viz `index.html:121-128`, identicky v `m.html`/`classic.html`):

1. **`data/calendar.json`** (`fetchActionCalendar()`, engine.js:2733) — server cron, zdroj
   `forexfactory-web`, 15 měsíců historie + 14 dní dopředu. **Kanonický zdroj.**
   `g_fundConfidence = 1` (plná váha fundamentů).
2. **FMP API** (`fetchFMPCalendar()`, jen pokud uživatel zadal vlastní klíč) — fallback č. 2,
   taky `g_fundConfidence = 1`.
3. **Živý ForexFactory feed** (`fetchFFEventsCached()`) — jen ~3 týdny dat, sléváno do lokální
   historie (`v5_ff_hist`, `mergeFFHistory`). `g_fundConfidence = ffConfidence(cal)`, což je
   **plynulá rampa 0.4 → 1.0 podle toho, kolik měsíců historie se LOKÁLNĚ nasbíralo** (viz
   `ffConfidence`, engine.js:1587 — `FF_FUND_DAMP=0.4`, plné důvěry dosáhne po `FF_CONF_MONTHS=15`
   měsících sbírání).
4. Bez sítě: `loadFFHistory()` — co je v `localStorage`.

**Co to znamená pro agenta:** `g_fundConfidence` NENÍ signál o kvalitě dat obecně — je to násobič,
kterým se tlumí JEN `fundScoreRaw` (data-tilt z kalendáře), ne `yieldAdj`/`policyAdj` (ty jedou
naplno vždy, protože vycházejí z CB sazeb, ne z kalendáře). Hodnotu lze přečíst přes
`getEngineDiagnostics().fundConf` (0–100 %) a zdroj přes `.calSource` (`action`/`fmp`/`ff`).

**Skórovací okno je oříznuté:** `capEventsWindow(cal, FUND_HIST_WINDOW_WEEKS=80)` — i když appka
má nasbíráno víc historie, do `scoreCurrency`/`buildForecastV5` jde vždy jen posledních 80 týdnů,
STEJNĚ na každém zařízení (jinak by dvě zařízení s různě starou lokální historií počítala jiný
fundament pro STEJNÝ den — reálně nalezený bug, viz komentář u `FUND_HIST_WINDOW_WEEKS`).

### 2.2 COT (CFTC TFF pozicování)

- **Kanonický vstup do `scoreCurrency`:** `getLatestCOTScores()` (engine.js:773) — poslední týden
  ze **sdílené** historie `cot_hist` (server cron `data/cot_hist.json` + merge). Explicitně NE
  `loadCOT()`/`cot_data`, což je per-zařízení live snapshot — dřív to způsobovalo, že PC a mobil
  ukazovaly jiné COT skóre pro stejný den.
- **Formule skóre měny** (`parseCOTFinancialText`/`fetchCOTViaAPI`, identické v obou cestách):
  ```
  ratio(long, short) = (long − short) / (long + short)
  score(long, short)  = clamp(ratio × 6, −3, +3)
  cot_score = 0.70 × score(Leveraged Funds) + 0.30 × score(Asset Managers)
  ```
  USD se čte přímo z řádku „USD INDEX — ICE FUTURES U.S.", fallback je syntetický opačný
  průměr ostatních 7 měn (jen když řádek USD chybí).
- **JPY má jedinou per-měnovou výjimku implementovanou v produkčním kódu:**
  `getCOTScore()` (engine.js:1277) pro JPY NEBERE blend výše, ale
  `−clamp(assetRatio × 6, −3, +3)` — tj. **faduje** (invertuje) Asset Manager ratio. Tohle je
  jediné místo, kde engine reaguje na nález výzkumného auditu ("asset manažeři jsou u JPY
  kontrariánský signál", IC −0.147) — zbytek 7 měn pořád jede plošný follow-blend.
- **Percentil** (`getCOTPercentile`, engine.js:1781): kde je DNEŠNÍ COT skóre v posledních
  `COT_PCT_WINDOW=104` týdnech (2 roky), 0–100. **Percentil dnes NEMĚNÍ váhy skóre** — sweep
  2010–2026 ukázal, že dřívější "zesil COT váhu na extrému" škodilo (PF 0.74–0.91 na extrémech
  vs 0.91–1.06 mimo, viz komentář u `getDynamicWeights`). Percentil se používá jen ve forecastu
  (penalizace crowded strany) a v UI/conviction (crowding brzda).

### 2.3 Retail sentiment

- **Kanonický vstup:** `getCanonicalSent()` → `_RETAIL_LATEST.ccy` z **`data/retail_hist.json`**
  (server cron, 30min). Primární zdroj crownu je **Myfxbook REST API** (~140 párů), fallback
  **FXSSI Current Ratio** (10 brokerů agregovaně), fallback **CFTC Non-reportable positions**
  (týdenní, per měna, ne per pár).
- **Kontrariánská interpretace** (`getSentimentScore`, engine.js:1292):
  ```
  pct ≥ 80 → −1.0   pct ≥ 70 → −0.5   pct ≤ 20 → +1.0   pct ≤ 30 → +0.5   jinak → 0
  ```
  Rozsah výstupu je jen **−1..+1** (nejmenší komponenta skóre svým rozsahem).
- **Fallback, pokud i CFTC selže:** `deriveRetailFromCOTData()` (engine.js:581) — retail se
  **matematicky dopočítá z COT dat** (silně long instituce → odhad retail 72% long, atd.).
  **Riziko pro agenta:** v tomto vzácném fallback-only případě COT a retail signál PŘESTÁVAJÍ
  být nezávislé — přestože ve skóre vypadají jako dvě oddělené váhy (`cot 45 % + sent 11 %`).
  Agent nemá přímý indikátor "retail je odvozený", jen nepřímo přes `getEngineDiagnostics().sentSrc`
  (`"cron"` vs `"local"`).
- **Klíčové upozornění pro agenta:** `sentData`/`retail` v datech je **% retailu LONG (0–100)**,
  NE skóre −10..+10. `sent_score` (výstup `getSentimentScore`) je už převedené na −1..+1.
  Neplést `retail` (surové %) s `sent`/`sent_score` (kontrariánsky převedené skóre) — appka na
  tuhle záměnu sama upozorňuje uživatele v `COACH_GROUNDING_RULES` (viz §7).

### 2.4 Ceny, VIX, ropa — čistě informační / risk-regime vstupy

| Zdroj | Soubor | Frekvence | Použití |
|---|---|---|---|
| FX ceny | `data/prices.json` | denní (ECB/Frankfurter) | `getPriceMomentum`, `getRangePosition`, `getEfficiencyRatio` — **timing, ne skóre** |
| VIX | `data/vix.json` | ~15 min | primární zdroj risk-regime (`computeAutoRiskSentiment`) |
| Ropa (WTI) | `data/oil.json` | ~15 min (+ volitelný Alpha Vantage) | jen `CAD`/`USD` korekce (`getOilMomentumScore`) |

**Risk regime** (`computeAutoRiskSentiment`, engine.js:2876): primárně VIX regime z
`data/vix.json`, pokud starší než 96 h → fallback na cenové momentum AUDJPY/NZDJPY (5denní).
**Vlastnost k zapamatování:** ve fallback cestě je risk_adj pro AUD částečně odvozen z ceny páru,
který AUD sám obsahuje (AUDJPY) — mírná kruhovost, jen ve fallback větvi, ne v primární (VIX).

### 2.5 CB sazby / CPI / Policy stance — hybridní auto+manuál

`CENTRAL_BANK_RATES`, `REAL_CPI_DATA`, `CB_POLICY_DATA` jsou **hardcoded defaulty přepsané
`localStorage` override** (`v5_cb_rates`, `v5_real_cpi`, `v5_cb_policy`). Auto-update
(`autoUpdateFromCalendar`, engine.js:1953) extrahuje z KAŽDÉHO načtení kalendáře:

- **Sazby** — z eventů kategorie "Interest Rates" s `actual`, jen minulé (`evDate(ev) <= now`).
  U EUR se bere výhradně depozitní sazba (ne main refinancing). Filtr `votes?` vyřazuje "MPC
  Official Bank Rate Votes" (matchuje keyword, ale není to sazba).
- **CPI** — preferuje YoY eventy, fallback na cokoli neM/M s hodnotou v rozsahu −2..20 %.
- **Policy stance** (`autoDetectCBPolicy`, engine.js:1898) — z historie posledních skutečných
  změn sazby (≥0.10 bps) odvodí stance −2..+2 (agresivní cut … agresivní hike) pravidly na
  počtu hike/cut/hold rozhodnutí za posledních 6 změn + roční změnu.

**Riziko pro agenta:** je to **poslední-zápis-vyhrává** systém — manuální úprava v UI a auto-detekce
z kalendáře zapisují do STEJNÉHO klíče, bez validace proti sobě navzájem. Pokud uživatel ručně
opraví `CB_POLICY_DATA.EUR`, další refresh kalendáře to může tiše přepsat zpátky (pokud auto-detekce
usoudí jinak), nebo naopak zůstane ruční hodnota, pokud auto-detekce nenajde dost dat. Agent by
při interpretaci `policy_adj`/`cb` labelu měl brát v potaz, že nejde o auditovaný "jediný zdroj
pravdy", ale o hybrid.

---

## 3. `scoreCurrency()` — přesný výpočet (engine.js:2359)

### 3.1 Fundamentální data-tilt (`fundScoreRaw`)

Pro každý event relevantní k měně (`eventRelevance`, přímý faktor 1.0 / nepřímý 0.45 —
viz `CURRENCY_COUNTRIES`/`INDIRECT_COUNTRIES`, např. CAD nepřímo reaguje na US data):

```
dir        = eventDirection(ev)          // −1/0/+1, podle EVENT_RULES (viz §3.4)
w          = category_weight × rel.factor × surpriseStrength(ev)
contribution = dir × w
score += contribution ;  weight += w × recency(ev.time)
```

`recency()`: eventy ≤90 dní váha ×1.8, ≤180 dní ×1.4, ≤365 dní ×1.0, starší ×0.7.
`surpriseStrength()`: `1 + min(0.6, |actual−estimate|/max(|estimate|,1) × 8)`.

**Shrinkage** (n/(n+k), k=3) — s JEDNÍM beat eventem by `fundScoreRaw` saturoval na ±10:

```
fundScoreRaw = clamp( (score/weight) × 10 × n/(n+3), −10, +10 )
```
1 event → 25 % tiltu, 5 → 63 %, 10 → 77 %, 30+ → >91 % (typický počet eventů v 80t okně tenhle
efekt prakticky nemění).

### 3.2 Kompletní vzorec fundamentálního skóre

```
fundScore = clamp( fundScoreRaw × g_fundConfidence + yieldAdj + policyAdj, −10, +10 )
```

kde `yieldAdj = getRealYieldScore(currency)` a `policyAdj = getCBPolicyScore(currency)` —
**viz §6.1, toto je hlavní zdroj trojitého počítání CB rozhodnutí.**

### 3.3 Finální skóre měny

```
wt = getDynamicWeights(cotPct)   // FIXNÍ: {fund:0.42, cot:0.45, sent:0.11, sea:0.02}

rawTotal = fundScore × wt.fund
         + cotScore  × wt.cot
         + sentScore × wt.sent
         + seasonScore × wt.sea
         + momentumAdj × (MOMENTUM_ENABLED ? 0.3 : 0)   // MOMENTUM_ENABLED = false (viz §6.3)
         + riskAdj                                       // ADITIVNÍ, mimo váhový systém, strop ±1.2
         + oilAdj                                         // ADITIVNÍ, jen CAD/USD, strop ±2.0/±0.5

total = clamp(rawTotal, −10, +10)
```

**`wt` je od poslední revize FIXNÍ konstanta, ne dynamická** — komentář v kódu (engine.js:2037)
výslovně říká, že dřívější adaptivní větev podle `v5_regime` byla mrtvý kód (klíč nikdy neměl
zapisovač) a byla odstraněna. `cotPct` v signatuře `getDynamicWeights` zůstává jen kvůli volajícím,
fakticky se nepoužívá.

### 3.4 `EVENT_RULES` — kategorie a jejich směr (engine.js:28-46)

| Kategorie | Váha | Směr | Poznámka |
|---|---|---|---|
| Interest Rates | 3.5 | vyšší = bullish | nejvyšší váha v celém enginu |
| Inflation (CPI/PCE/PPI) | 3.0 | vyšší = bullish | |
| Labor −Unemployment | 3.0 | **nižší** = bullish | musí být PŘED "Labor +Jobs" v poli (substring kolize `unemployment` ⊃ `employment`) |
| Labor +Jobs (NFP, ADP, wages) | 3.0 | vyšší = bullish | |
| GDP | 2.2 | vyšší = bullish | |
| PMI | 1.8 | beat/miss + hranice 50 | speciální logika, viz `eventDirection` |
| Retail Sales | 1.7 | vyšší = bullish | |
| External Balance (trade/current acct) | 1.0 | vyšší = bullish | |
| Confidence (ZEW/IFO/consumer) | 1.0 | vyšší = bullish | |

Pole `cap` (strop eventů na kategorii) bylo v kódu dřív, nikde se nečetlo, odstraněno — komentář
v kódu výslovně říká, že případný strop je třeba ověřit na `data/engine_hist.json`, ne domýšlet.

---

## 4. Vedlejší korekce skóre (mimo hlavní váhový systém)

Tyto tři složky **NEJSOU normalizované váhy** — jsou to aditivní situační přirážky s vlastními
tvrdými stropy:

| Složka | Funkce | Strop | Zdroj |
|---|---|---|---|
| `riskAdj` | `getRiskSentimentAdj` (engine.js:2285) | ±1.2 (AUD/JPY), menší pro ostatní | risk regime (VIX/momentum fallback) |
| `oilAdj` | `getOilMomentumScore` (engine.js:2221) | ±2.0 (CAD), ±0.5 (USD) | jen CAD a USD, WTI 4t/13t momentum |
| `momentumAdj` | `getCurrencyMomentum` (engine.js:1801) | ±1, ale × 0.3 jen pokud `MOMENTUM_ENABLED` | **vypnuto** — počítá se a loguje, ale nepřispívá |

`riskAdj` hodnoty per měnu (engine.js:2285-2291, založené na vlastním 20letém auditu appky —
**pozor, znaménka jsou EMPIRICKY OPAČNÁ než konvenční intuice** u AUD a CHF):

```
risk-off (VIX vysoké):  AUD +1.0  GBP −0.65  NZD −1.0  CAD −0.6  JPY +1.2  CHF −0.5
risk-on  (VIX nízké):   AUD −0.8  GBP +0.5   NZD +0.7  CAD +0.5  JPY −0.5  CHF +0.4
```

AUD posiluje při risk-off (risk premium/rebound), CHF slábne při risk-off (unwind haven flows PO
stresu) — obojí je NÁLEZ AUDITU (IC +0,200 pro AUD, −0,098 pro CHF), ne konvenční předpoklad.

---

## 5. `rankPairs()`, `calcConvictionScore()`, `buildForecastV5()`

### 5.1 rankPairs (engine.js:2629)

```
diff(pair) = score(base) − score(quote)
dir        = diff > 0 ? "BUY" : "SELL"
```

Seřazeno podle `|diff|` sestupně. `corrDuplicate` flag: v TOP 5 párech se druhý pár ze stejné
`FX_CORRELATION_GROUPS` skupiny označí jako duplicitní (appka nechce ukazovat EURUSD+GBPUSD jako
dvě "nezávislé" příležitosti, pokud jsou obě v top 5).

### 5.2 calcConvictionScore (engine.js:2294) — 0–5 hvězd

Šest testovaných faktorů, clamp na 5 (6. souhlasný faktor funguje jako pojistka):

1. **CB Policy divergence** — souhlasí `CB_POLICY_DATA[base].score > CB_POLICY_DATA[quote].score` se směrem?
2. **Real yield differential** — `(rate−CPI)` rozdíl ≥0.3 % ve směru obchodu?
3. **Fundamentální síla** — `pair.diff >= 2.0`?
4. **COT není crowded proti směru** — `cotPct` báze není ≥88/≤12 proti obchodu, A `diff >= 1`
5. **AI graf konfluence** — pokud existuje `aiAnalyses[pair]` s bias souhlasícím se směrem
6. **Ropa** (jen páry s CAD) — WTI momentum souhlasí se směrem

**Crowding brzda** (odečte 1 hvězdu, floor 0): `diff >= BAND_THRESHOLDS.strong(3)` **A** COT
extrém stejným směrem na jedné noze **A** `g_riskSentiment > 0` (risk-on) → "možný pozdní/
přeplněný trade". Tohle je přímá implementace nálezu z `ARCHITECTURE_AUDIT_2026-07.md` §10
(extrémní diff měl v replayi HORŠÍ PF, ne lepší).

**⚠️ Kritické pro interpretaci — hvězdy NEJSOU 5 nezávislých hlasů:**
- Star #1 (CB policy) a star #2 (real yield) používají **stejná syrová data** (`CB_POLICY_DATA`,
  `CENTRAL_BANK_RATES`, `REAL_CPI_DATA`) jako `policyAdj`/`yieldAdj`, které jsou **už uvnitř**
  `fund_score`, který je **už uvnitř** `total`/`diff` použitého pro star #3 a pro samotný `dir`.
- To znamená: star #1, #2, #3 z velké části opakují TENTÝŽ podkladový signál (stav CB politiky)
  třikrát pod jinými jmény. Agent by "3+/5 hvězd" neměl interpretovat jako "tři nezávislé zdroje
  souhlasí" — spíš jako "CB politika + fundamentální síla + (případně COT/AI/ropa) souhlasí",
  s vědomím že první tři jsou korelované.
- Nezávislé faktory jsou fakticky jen: {CB/yield/fund-síla (jeden blok)} × {COT} × {AI graf} × {ropa}.

### 5.3 buildForecastV5 (engine.js:2135) — 14denní pravděpodobnostní forecast

```
fwdBase  = Σ getEventHistoryTrend(event, base, calData).score × weight(event)   // přes nadcházející eventy
fwdQuote = totéž pro quote
curDiff  = score(base) − score(quote)     // DNEŠNÍ skóre, stejné jako rankPairs.diff
fwdDiff  = fwdBase − fwdQuote              // OČEKÁVANÝ posun na základě historie eventů
combined = curDiff × 0.70 + fwdDiff × 3.0 × 0.30

prob = 50 + (logistic(combined × 0.5) − 0.5) × 60      // vždy ⊂ (20, 80) před dalšími úpravami
prob += momentumAdj      // 0, MOMENTUM_ENABLED=false
prob += newsDiscount     // −12/−8/−4/0 podle blízkosti high-impact news (<12h/<24h/<48h)
prob += cotAdj           // ±7/±3 podle COT percentilu báze i quote (SYMETRICKY, viz níže)
prob = round(clamp(prob, 35, 75))    // TVRDÝ strop 35–75 %, záměrně konzervativní
```

**COT korekce je symetrická** (engine.js:2154-2162, komentář explicitně říká "bez důkazu žádná
asymetrie") — dřívější verze penalizovala jen jednu nohu páru bez zdůvodnění, opraveno.

**⚠️ `curDiff` v `combined` je STEJNÉ číslo jako `rankPairs().diff`** — 70 % váhy forecastu je
tedy opět jen znovupoužité dnešní skóre (které samo obsahuje CB/yield/fund/COT/sent/season).
Jen 30 % váhy (`fwdDiff`) je skutečně nová informace (historický trend nadcházejících event-typů).

---

## 6. Známá omezení a rizika — co engine sám dokumentuje

### 6.1 Trojité počítání CB rozhodnutí (potvrzeno auditem, NEOPRAVENO)

`RESEARCH_AUDIT_2026-07.md`: *"CB sazba se počítá 3× (beat/miss + yield + policy — kolineární)"*.
V kódu (engine.js:2397-2400) je to komentářem přiznáno jako **záměrný, ale neověřený design**:

1. **beat/miss** — Interest Rate Decision eventy v kategorii "Interest Rates" (`fundScoreRaw`)
2. **úroveň sazby** — `yieldAdj` = `(nominální sazba − CPI)` relativně k průměru koše
3. **trend cyklu** — `policyAdj` = `CB_POLICY_DATA.score` relativně k průměru koše

Všechny tři měří **jiný aspekt téhož podkladového jevu** (rozhodnutí centrální banky), a
`COUNTER_AUDIT_2026-07.md` §9 měří přímou korelaci mezi příbuznými faktory: `carry3m × real yield
+0.72`, `carry3m × y10 diff +0.67` — jedna sazbová rodina vydávaná za víc signálů.

**Dopad na conviction:** viz §5.2 výše — stars #1/#2/#3 sdílejí tenhle kanál.

### 6.2 Look-ahead bias — status: v LIVE enginu neidentifikován, v BACKTESTECH historicky
existoval a byl opraven

- **Live scoring** (`scoreCurrency`, `buildForecastV5`) používá vždy jen aktuálně publikovaná
  data — `extractCBRatesFromCalendar`/`extractCPIFromCalendar` explicitně filtrují
  `evDate(ev) <= new Date()`. Nenašel jsem v `engine.js` místo, kde by live skóre četlo budoucí
  hodnotu.
- **Backtest metodologie MĚLA look-ahead bug a byl opraven:** `scripts/backtest-cot.js:97`
  komentář: *"report_date+6 dní. Dřívější t0=report_date byl 3–6denní look-ahead bias"* — CFTC
  COT report je "as of úterý", ale publikuje se až následující pátek; použití data reportu jako
  vstupního datumu obchodu byl skutečný look-ahead, dnes opraveno na `report_date + ENTRY_LAG_DAYS`.
  `scripts/backtest-replay.js` explicitně skóruje "z dat známých k X (žádný look-ahead)" a vstup
  je X+1.
- **`data/calibration.json`** (aktuální běžící kalibrace) potvrzuje opravenou metodiku:
  `"entryLag":"publication+nextFix (report_date+6d) — bez look-ahead biasu"`.
- **Zbytkové riziko pro agenta:** `SEASONALITY` tabulka (engine.js:83-92, "historické průměrné
  výnosy za posledních 20 let") je **statická konstanta v kódu**, ne živě přepočítávaná — jestli
  byla sama tabulka sestavena bez publikačních lagů, nelze z `engine.js` ověřit. Její dopad na
  skóre je ale malý (`wt.sea = 0.02`) a auditem je stejně doporučeno ji ze skóre odstranit (§6.4).

### 6.3 Momentum — vypnuto, ale kdyby se zapnulo, je to potenciální zpětná vazba

`getCurrencyMomentum()` (engine.js:1801) počítá průměrnou denní změnu **CELKOVÉHO skóre** za
posledních 5 dní z `loadScoreHistory()` — což je uložený výstup TÉTO SAMÉ funkce (`scoreCurrency`)
z minulých dní. `MOMENTUM_ENABLED = false` (engine.js:1817), takže dnes do `total` nepřispívá —
ale počítá se a loguje se pro budoucí validaci v Backtest tabu. **Pokud by se zapnulo:** šlo by o
autokorelovanou zpětnou vazbu (výstup dneška používá jako vstup včerejší výstup téže funkce) —
ne look-ahead (žádná budoucí data), ale metodologicky křehké zesilování trendu. Výzkumný audit
navíc přímo změřil, že týdenní FX momentum je **mean-reverting** (záporné IC u JPY/CAD/CHF/NZD) —
další důvod, proč zůstává vypnuté.

### 6.4 Sezónnost — dokumentovaně škodlivá, pořád aktivní

`RESEARCH_AUDIT_2026-07.md`: walk-forward IC záporné u 5 z 8 měn (−0.08 až −0.14). Doporučení
"odstranit ze skóre" **NENÍ implementováno** — `seasonScore × wt.sea` (váha 2 %) je pořád součástí
`rawTotal`. Dopad je malý (2% váha), ale je to vědomě ponechaná, auditem vyvrácená komponenta.

### 6.5 COT subskupina/znaménko — plošné pro 7 z 8 měn

Výzkumný audit: non-commercial/leveraged-follow logika je robustní jen pro `EURUSD` (jediný pár,
kde `cot_nc` funguje, PF 1.20); pro JPY a CHF je správně **kontrariánská** (fade asset managers),
pro GBP je robustní jen `cot_dealer` (engine ho vůbec nepoužívá). Engine implementuje **jedinou**
výjimku — JPY fade (viz §2.2). Zbylých 6 měn (EUR, GBP, AUD, CAD, CHF, NZD) používá stejný
70/30 leveraged/asset blend bez ohledu na to, že audit u některých najde slabší nebo opačnou
evidenci.

### 6.6 Diff-síla pásma jsou explicitně neověřená heuristika

`BAND_THRESHOLDS = {weak:2, strong:3}` (engine.js:370) má vlastní `BAND_DISCLAIMER`: *"Orientační
pásmo síly rozdílu skóre — neověřená heuristika, kalibrace probíhá."* Replay backtest ukázal
OPAK intuice: `diff >= 3` (pásmo "silný") mělo PF 0.64–0.87, HORŠÍ než slabší pásma — proto
existuje crowding brzda (§5.2), ale samotné pásmo se používá dál v UI beze změny.

### 6.7 Aktuální kalibrace: samotný diff nemá prokázaný edge

`data/calibration.json` (2026-08-15, 121 týdnů, 28 párů, half-split validace): u horizontu 1
týden, `diff=0` (žádný filtr) PF **0.907**, `diff=1` PF **0.871**, `diff=1.5` PF **0.858** — všechny
pod 1.0 (ztrátové) a `robust:false`. **Samotný diff skóre bez dalších filtrů dnes NEMÁ prokázaný
edge na tomto backtestu.** `ARCHITECTURE_AUDIT_2026-07.md`/`COUNTER_AUDIT_2026-07.md` navrhují
sadu úprav (VIX gate, per-měnové COT subskupiny, CPI akcelerace pro CAD, sloučení sazbových
kanálů), které v simulaci zlepšily PF na skutečně nedotčených OOS datech z 0.875 na 1.029 —
**ale tyto úpravy NEJSOU v `engine.js` implementované.** Jsou to návrhy ve `ARCHITECTURE_V3_2026-07.md`.

### 6.8 Jediná komponenta s potvrzeným, dosud platným edge: RP+ER timing

`getRangePosition()` + `getEfficiencyRatio()` (engine.js:2817-2853) — **čistě informační**,
explicitně "žádný vliv na skóre/diff/bias". Backtest (2024-05→2026-07, 28 párů, point-in-time,
half-split ověřeno): `RP≥80 % + ER>0.5 → fade SHORT`, PF **1.45**; `RP≤20 % + ER 0.20–0.65 → fade
LONG`, PF **1.55**. Tohle je jediná složka celého enginu s doloženým, dosud nevyvráceným edge —
a nepromítá se do `total`/`diff`/conviction/forecast vůbec, jen do samostatného timing signálu.

---

## 7. Kontrakt "appka ↔ AI" — už existuje, agent by ho měl respektovat

Appka má **vlastní, hotový AI Coach kontrakt** (engine.js:3279-3450+, konstanty
`COACH_GLOSSARY`, `COACH_GROUNDING_RULES`, `COACH_TEACHING_PRINCIPLES`, `COACH_PERSONA`) — psaný
pro LLM, který appku vysvětluje uživateli. Nový AI agent by měl **znovupoužít stejná pravidla**,
ne vymýšlet vlastní interpretaci:

1. **`buildPairDossier(pairSym, ...)` je jediný zdroj pravdy pro konkrétní pár** — vrací
   `components` (fund/policy/yield/cot/sent/season pro base i quote), `pairCBDI` (párová CB
   divergence, JINÉ číslo než globální `calcCBDI()`), `cotPercentile`, `conviction`, `forecast`,
   `dailyBrief`, `biasFlip`, `oilCorrection`. Agent nemá tato čísla přepočítávat vlastní logikou.
2. **Jednotky se pletou snadno** (`COACH_GROUNDING_RULES`, engine.js:3327):
   - `cot`/`cot_score` = −3..+3 (institucionální skóre), **NENÍ procento**
   - `cotPct`/`cotPercentile` = 0–100 (percentil v historii)
   - `inst` (jen v UI datovém objektu `D[c]`) = `cot_score × 12`, škálováno na −100..+100 jen pro
     vizuální bary — **neplést s cotPct**
   - `retail`/`sent` = 0–100 (% retailu LONG), zatímco `sent_score` = −1..+1 (kontrariánsky
     převedené)
   - `score`/`fund`/`policy`/`yield`/`season` = typicky −10..+10
3. **Nikdy nedávat pokyn koupit/prodat** — appka to má jako tvrdé pravidlo
   (`COACH_TEACHING_PRINCIPLES`, bod 2): popisuje faktory a jejich vztahy, rozhodnutí je vždy na
   uživateli. Zakázané formulace: "kup", "prodej", "vstup teď", "měl bys jít long/short".
4. **Vždy zmínit nejistotu, invalidaci a alternativní scénář** (bod 3 tamtéž) — konkrétně u
   `getDiffBand()` pásem SLABÝ/SWEETSPOT/SILNÝ vždy uvést, že jde o **neověřenou heuristiku**
   (`BAND_DISCLAIMER`), ne o appkou potvrzený nález.
5. Když číslo v datech chybí — appka instruuje LLM říct "nemám ho", ne si ho vymyslet
   (`COACH_GROUNDING_RULES`).

**Doporučení pro budoucí implementaci nástroje `fx_analyzer.*`:** kdykoli agent bude interpretovat
konkrétní pár, měl by volat (respektive replikovat 1:1 chování) `buildPairDossier()`, ne
`scoreCurrency()`/`rankPairs()`/`calcConvictionScore()` zvlášť — dossier už řeší přesně ty
záměny jednotek a strukturu odpovědi, které appka sama zjistila, že model bez něj plete.

---

## 8. Rychlá referenční tabulka konstant

| Konstanta | Hodnota | Umístění | Účel |
|---|---|---|---|
| `wt` (dynamické váhy) | `{fund:0.42, cot:0.45, sent:0.11, sea:0.02}` | `getDynamicWeights`, engine.js:2058 | FIXNÍ, ne dynamické — navzdory názvu funkce |
| shrinkage k | 3 | `scoreCurrency`, engine.js:2380 | tlumí fundScoreRaw při málo eventech |
| `FUND_HIST_WINDOW_WEEKS` | 80 | engine.js:1602 | skórovací okno kalendáře, stejné na všech zařízeních |
| `COT_PCT_WINDOW` | 104 (2 roky) | engine.js:1761 | okno pro COT percentil |
| `FF_CONF_MONTHS` | 15 | engine.js:1534 | za kolik měsíců lokální FF historie dosáhne plné důvěry |
| `FF_FUND_DAMP` | 0.4 | engine.js:157 | minimální důvěra fundamentů při čerstvé FF historii |
| `BAND_THRESHOLDS` | `{weak:2, strong:3}` | engine.js:370 | NEOVĚŘENÁ heuristika síly diffu |
| `DAY_WINDOW` | 1 den | engine.js:2450 | okno "už vyšlo dnes" (Daily Brief) |
| `MOMENTUM_ENABLED` | `false` | engine.js:1817 | momentum se počítá, ale nepřispívá do total |
| forecast prob strop | 35–75 % | `buildForecastV5`, engine.js:2163 | záměrně konzervativní rozsah |
| conviction strop | 0–5 hvězd | `calcConvictionScore`, engine.js:2356 | interně 6 faktorů, clampnuto |
| crowding brzda práh | `diff >= 3` + COT extrém + risk-on | engine.js:2346 | odečte 1 hvězdu |
| RP+ER edge (fade SHORT) | RP≥80% & ER>0.5 → PF 1.45 | engine.js:2837 komentář | jediný ověřený edge, mimo skóre |
| RP+ER edge (fade LONG) | RP≤20% & ER 0.20–0.65 → PF 1.55 | engine.js:2837 komentář | tamtéž |

---

## 9. Otevřené otázky, které dokument NEŘEŠÍ (vědomě mimo rozsah)

- Přesný obsah/zdroj `SEASONALITY` tabulky (je hardcoded, publikační lagy nelze z kódu ověřit).
- US100 (Nasdaq-100) scoring (`scoreUS100`, engine.js:3569) — samostatný nástroj, jiná datová
  vrstva (`us100_*`), mimo rozsah "FX Analyzer" v tomto zadání.
- TradingView / technická analýza — v repozitáři neexistuje (viz `jarvis/server/tools/tradingview/README.md`).
- Konkrétní implementace V3 architektury z auditů — jde o návrh, ne o stav kódu; pokud se bude
  implementovat, tenhle dokument bude potřeba přepsat, ne jen doplnit.

# Economic Calendar Data Layer — technická analýza a architektura

> Cíl: provider-nezávislá vrstva pro ekonomický kalendář, 15+ měsíců historie,
> odolnost vůči výpadku API, zachování stávajícího score enginu, minimální náklady.
> Kontext: Finnhub Economic Calendar je nově placený (403 na free), FMP free vrací
> 402 (Restricted Endpoint). ForexFactory dává jen ~3 týdny živě.

---

## 0. TL;DR — doporučení

**Vlastní databáze v `localStorage`, jednorázově naseedovaná stažitelným ForexFactory
datasetem, za adaptérovou vrstvou.** Žádný placený poskytovatel, žádný vendor lock-in,
funguje i offline. Externí API už nikdy nesmí být tvrdá závislost — jen jeden z
vyměnitelných adaptérů.

Cesta „nový externí zdroj" se **nedoporučuje** jako primární: všechny spolehlivé
historické zdroje s konsensem/actual jsou dnes placené (Finnhub, FMP, Trading
Economics, FXStreet, Finnworlds). To by jen přesunulo stejný problém k jinému
poskytovateli.

---

## 1. Současný stav (grounded v kódu, `index.html`)

### 1.1 De-facto normalizace už existuje
Všechny tři zdroje se mapují na shodný tvar:
`{event, country, time, impact, actual, estimate, prev}`

- `mapFFEvent` (1036–1047): `title→event`, `forecast→estimate`, `previous→prev`,
  `FF_CCY_COUNTRY` převod kódu země.
- `mapFMPEvent` (966–976): `date→time`, `consensus/forecast→estimate`, `previous→prev`.
- Finnhub vrací nativně už v tomto tvaru (`economicCalendar` pole).

To je dobrá zpráva — **score engine už dnes nečte „Finnhub strukturu", čte normalizovaný
tvar.** Chybí jen formalizace (jednotný kontrakt + pole `forecast/previous/datetime/
currency/source`, které požaduješ).

### 1.2 Dvě časové dimenze (nesmí se slít)
- `calData` — ~15 měsíců historie (trendy, extrakce CB sazeb/CPI).
- `upcoming` — 14 dní dopředu (forecast, daily brief).

### 1.3 Sběrač FF historie (už hotový)
`v5_ff_hist` v localStorage, `mergeFFHistory` (1067–1085), `ffConfidence` (1092–1096):
confidence roste `0.4 → 1.0` podle rozpětí nasbírané historie (15 měs = 1.0).

---

## 2. Co je DNES ještě závislé na Finnhubu (požadavek #6)

| Místo | Řádek | Závažnost | Pozn. |
|---|---|---|---|
| **Vstupní brána** `if(!fhKey) return <Setup/>` | 4585 | 🔴 KRITICKÁ | Appka **nenaběhne bez Finnhub klíče**, i když Finnhub fakticky nefunguje. |
| `fhKey` init z `localStorage["fh"]` | 4476 | 🔴 | Klíč je „povinný" jen formálně. |
| `fetchUpcoming14` (jen Finnhub) | 949–958 | 🟠 střední | Při ne-Finnhub zdroji se používá `deriveUpcomingFromEvents` — funguje, ale upcoming je slabší. |
| `FH` konstanta + `economicCalendar` shape | 940, 947, 955 | 🟢 nízká | Jen uvnitř `fetchCalendar`. |

**Závěr:** Strukturně je na Finnhubu závislá už jen **vstupní brána** a **upcoming 14d**.
Score engine ani komponenty na Finnhub strukturu nesahají.

---

## 3. Nejlepší zdroj historických dat (požadavek #1)

**Stažitelné ForexFactory datasety** — ideální, protože jsou ze **stejného zdroje** jako
živý sběr → konzistentní názvy událostí i taxonomie impactu → engine nepozná šev.

| Zdroj | Rozsah | Formát | Sloupce |
|---|---|---|---|
| HF `Ehsanrs2/Forex_Factory_Calendar` | 2007 – 2025-04 | CSV/parquet | Date, Time, Currency, Event, Impact, Actual, Forecast, Previous |
| Kaggle `randelltsen/forex-factory-entire-dataset-till-2024-08-16` | … 2024-08 | CSV | tytéž |
| Kaggle `devorvant/economic-calendar`, `youneseloiarm/global-economic-calendar` | víceleté | CSV | tytéž |

Model: **jednorázový seed (15+ měsíců, klidně roky) → od té chvíle si appka dopisuje
živá data sama** (FF sběrač). Přesně to, co chceš.

> Pozn.: datasety se stahují z Kaggle/HF (vyžadují účet/anon download). Z tohoto cloud
> prostředí jsou kvůli allowlistu nedostupné → seed proběhne přes **Import CSV v appce**
> (uživatel stáhne CSV a naimportuje), nebo se předpřipravený `economic_history.json`
> commitne do repa.

---

## 4. Univerzální Economic Calendar Data Layer — architektura

### 4.1 Normalizovaný formát `EconomicEvent`

```js
{
  date,      // "2025-03-07"            (YYYY-MM-DD)
  time,      // "13:30"                 (HH:MM, lokální zdroje bez TZ = "")
  datetime,  // "2025-03-07T13:30:00Z"  ← AUTORITATIVNÍ timestamp (sort, new Date)
  country,   // "US"                    (ISO-2 / "EU")
  currency,  // "USD"
  event,     // "Non-Farm Payrolls"
  impact,    // "high" | "medium" | "low"
  actual,    // "151K"   (string, "" = pending)
  forecast,  // "160K"   (string)
  previous,  // "143K"   (string)
  source     // "forexfactory" | "finnhub" | "fmp" | "csv" | "manual" | "seed"
}
```

**Kompatibilita s enginem:** engine dnes čte `e.time` (celý timestamp), `e.estimate`,
`e.prev`. Řešení (viz §5): engine se přepne na `datetime/forecast/previous`, NEBO
normalizátor doplní zpětné aliasy (`estimate=forecast`, `prev=previous`, `time=datetime`).
Doporučeno: **canonical pole + tenké aliasy** během přechodu, ať se nic nerozbije.

### 4.2 Adaptéry (každý: `raw → EconomicEvent[]`)

```js
const Adapters = {
  FinnhubAdapter,       // res.economicCalendar → normalize  (volitelný, placený)
  ForexFactoryAdapter,  // nfs.faireconomy feeds → normalize (živý sběr, FREE)
  FMPAdapter,           // /economic_calendar → normalize    (volitelný, placený)
  LocalJsonAdapter,     // economic_history.json / localStorage → EconomicEvent[]
  CsvImportAdapter,     // CSV (Kaggle/HF/FF export) → normalize  ← SEED 15+ měsíců
  ManualImportAdapter,  // formulář / vložený JSON → EconomicEvent[]
}
```

`CsvImportAdapter` musí být tolerantní k hlavičkám (mapování sloupců):
`Date|date`, `Time|time`, `Currency|currency|country`, `Event|event|title`,
`Impact|impact|importance`, `Actual|actual`, `Forecast|forecast|estimate|consensus`,
`Previous|previous|prev`.

### 4.3 `EconomicCalendarService` (orchestrátor)

```js
class EconomicCalendarService {
  load()        // seed(LocalJsonAdapter) ⊕ localStorage → sjednocená historie
  refreshLive() // ForexFactoryAdapter (+ volit. FMP/Finnhub) → merge → persist
  getCalendar() // EconomicEvent[] (15+ měs)   → calData
  getUpcoming() // EconomicEvent[] (14 d)       → upcoming
  importJSON(text) / importCSV(text)            // merge do DB
  exportJSON() / exportCSV()                    // download zálohy
  confidence()  // = ffConfidence(history) → g_fundConfidence
}
```

Merge = dedup podle `country|event|datetime`, novější `actual` přepíše prázdné,
strop velikosti, ořez staré historie (dnes 18 měs / 8000 — lze zvednout).

### 4.4 `economic_history.json` — hlavní databáze

**Realita browser-only appky (žádný backend):** prohlížeč **neumí sám zapisovat soubor**
na disk. Takže:

- **Auto-ukládání živých dat = `localStorage`** (klíč `v5_ff_hist`, resp. nový
  `econ_history_v1`). Tohle běží automaticky při každém refreshi (už funguje).
- **`economic_history.json`** plní dvě role:
  1. **Bundled seed** committed v repu vedle `index.html` → appka ho na startu
     `fetch("./economic_history.json")` (same-origin, bez klíče, bez CORS) a slije do DB.
  2. **Export/záloha** — uživatel si přes „Export JSON" stáhne aktuální stav DB
     (pro backup nebo re-commit do repa).

Tok: `seed JSON (repo)  ⊕  localStorage (živě)  → merged history → engine`.

### 4.5 Persistence model

```
┌── economic_history.json (repo, seed 15+ měs) ──┐
│                                                 │  fetch on load
└──────────────┬──────────────────────────────────┘
               ▼
        EconomicCalendarService.load()  ──►  merged DB  ──►  localStorage (econ_history_v1)
               ▲                                   │
   ForexFactoryAdapter (každý refresh) ────────────┘  (auto-append živá data)
   Import CSV/JSON (jednorázově/ručně) ────────────┘
```

---

## 5. Zachování score enginu (požadavek #3)

Engine logika (`scoreCurrency` 1586–1628, `getEventHistoryTrend` 1744–1761, `recency`,
`surpriseStrength`, `eventDirection`, `eventRelevance`, váhy) **zůstává beze změny**.
Mění se jen **vstupní kontrakt**:

1. Vše prochází `normalize()` → `EconomicEvent` (canonical pole).
2. Engine čte `datetime` místo `time`, `forecast` místo `estimate`, `previous` místo
   `prev`. (≈ 18 míst časových čtení + pár surprise výpočtů; viz §7.)
3. `g_fundConfidence` zůstává (FMP/Finnhub = 1.0, FF = `ffConfidence(history)`).
   **Se seedem 15 měsíců skočí confidence rovnou na 1.0** → výsledky jako za Finnhubu.

Po naseedování se tedy skóre vrátí k „dlouhé historii" chování — bez zásahu do vzorců.

---

## 6. Prevence vendor lock-in (požadavek #4)

- **Engine i komponenty čtou JEN `EconomicEvent`.** Nikde žádné `economicCalendar`,
  `token=`, ani předpoklad tvaru konkrétního poskytovatele.
- **Přidání nového zdroje = nový adaptér** (`normalize(raw) → EconomicEvent[]`),
  **nula zásahů** do enginu a UI.
- **Primární data = vlastní DB**, externí API je jen „doplňovač". Výpadek poskytovatele
  = appka jede dál z DB.

---

## 7. Seznam potřebných úprav (požadavek #5)

**Fáze 1 — Seed + Import/Export (největší hodnota, ~3–4 h)**
1. `CsvImportAdapter` + `parseCsvFlexible(headerMap)` → `EconomicEvent[]`.
2. Import/Export UI v Nastavení: Import JSON, Import CSV, Export JSON, Export CSV.
3. Napojit import na `mergeFFHistory`/novou DB (`econ_history_v1`).
4. Po importu přepočítat `g_fundConfidence` z rozpětí (skočí na 1.0).

**Fáze 2 — Formalizace normalizace (~1 den)**
5. `normalizeEvent(raw, source)` → canonical `EconomicEvent` (date/time/datetime/
   currency/source). Sjednotit `mapFFEvent`/`mapFMPEvent`/Finnhub přes něj.
6. Engine: přepsat čtení `e.time→e.datetime`, `e.estimate→e.forecast`, `e.prev→e.previous`
   (řádky dle mapy: time ~208–218, 1041, 1065, 1077, 1089, 1102, 1595, 1642, 1655, 1684,
   2507, 2518; estimate ~973, 1592, 1659, 1754, 2504; prev ~974, 1045, 2505). Bezpečně:
   ponechat dočasné aliasy.

**Fáze 3 — Service + odstranění Finnhub brány (~půl dne)**
7. `EconomicCalendarService` jako jediný vstup do `loadData`.
8. **Zrušit Finnhub bránu** `if(!fhKey)` (4585) → appka naběhne i bez Finnhub klíče
   (stačí seed nebo FF). Finnhub/FMP klíč = volitelný „placený doplněk".
9. `fetchUpcoming14` zobecnit (z DB / adaptérů), ne jen Finnhub.

**Fáze 4 — Bundled seed (volitelné, ~2–3 h)**
10. Commitnout `economic_history.json` (15+ měs, normalizovaný) do repa.
11. Na startu `fetch("./economic_history.json")` → merge (idempotentně).

---

## 8. Rizika

| Riziko | Dopad | Mitigace |
|---|---|---|
| `localStorage` limit ~5 MB | Velká historie se nevejde | Ukládat jen `getWeight>0` události; strop + ořez; měřit velikost; nabídnout Export. |
| Nekonzistentní názvy událostí mezi zdroji | Trendy se „rozpadnou" | Seedovat z **FF datasetu** (stejný zdroj jako živě); fuzzy match přes `getWeight`/keyword. |
| Smazání dat prohlížeče | Ztráta nasbírané historie | Bundled seed v repu + tlačítko Export (záloha). |
| Časové zóny (datasety lokální vs UTC) | Posun událostí | `datetime` vždy v UTC; normalizátor sjednotí. |
| CSV s rozdílnou hlavičkou | Import selže | Tolerantní `headerMap`, náhled + počet importovaných řádků. |
| Refaktor časových polí v enginu | Regrese skóre | Dočasné aliasy + transpile check + porovnání skóre před/po. |
| Kvalita free datasetu (chybějící forecast u starých) | Slabší surprise u staré historie | Recency už staré události tlumí; engine počítá i bez forecastu (dir z prev). |

---

## 9. Doporučená finální architektura

```
        DATA SOURCES (vyměnitelné adaptéry)
  Finnhub*  FMP*  ForexFactory(free)  CSV/JSON import  Manual
     │       │          │                   │            │
     └───────┴────┬─────┴───────────────────┴────────────┘
                  ▼  normalize() → EconomicEvent
        ┌──────────────────────────────────────┐
        │  EconomicCalendarService              │
        │   • load (seed ⊕ localStorage)        │
        │   • refreshLive (FF append)           │
        │   • import/export JSON+CSV            │
        │   • confidence()                      │
        └───────┬───────────────┬───────────────┘
         calData(15+ měs)   upcoming(14 d)
                └───────┬───────┘
                        ▼
        SCORE ENGINE (beze změny logiky)
   scoreCurrency · getEventHistoryTrend · g_fundConfidence
                        ▼
        REACT UI (Calendar, DailyBrief, BiasFlip, Forecast)

  * placené, volitelné. Bez nich appka jede z vlastní DB.
```

---

## 10. Odhad náročnosti

| Fáze | Co | Náročnost | Hodnota |
|---|---|---|---|
| 1 | CSV/JSON import+export, seed 15+ měs | **3–4 h** | 🟢🟢🟢 (vrací dlouhou historii HNED) |
| 2 | Formalizace `EconomicEvent` + refactor enginu | ~1 den | 🟢🟢 (čistota, anti-lock-in) |
| 3 | Service + zrušení Finnhub brány | ~půl dne | 🟢🟢 (nezávislost, naběhne bez Finnhubu) |
| 4 | Bundled `economic_history.json` v repu | 2–3 h | 🟢 (out-of-the-box seed) |

**Celkem ~2–3 dny.** Ale **Fáze 1 dá ~80 % hodnoty za pár hodin** (naimportuješ dataset,
historie i confidence skočí nahoru).

---

## 11. Verdikt: vlastní DB vs nový externí zdroj

**Jednoznačně vlastní DB** (seed dataset + self-accumulation), z těchto důvodů:
- Free a bez recurring nákladů (vs. ~$50/měs Finnhub / placené FMP).
- Nezávislost na poskytovateli — výpadek/zdražení už appku nepoloží.
- Konzistence: seed i živá data z FF → engine nepozná přechod.
- Splňuje přesně tvůj model: *jednorázově nahrát historii → appka si dál dopisuje sama*.

Placené API (Finnhub/FMP) zůstává jako **volitelný adaptér** pro toho, kdo chce
„instantní" plnou historii bez seedu — ale není to nutné.

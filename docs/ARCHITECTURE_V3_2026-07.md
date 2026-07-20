# FX Analyzer V3 — architektura od nuly

*2026-07-20 · Čistý návrh, nevázaný na dnešní `scoreCurrency()`. Každá krabička v diagramu níže cituje přesně to číslo/test z `RESEARCH_AUDIT_2026-07.md`, `ARCHITECTURE_AUDIT_2026-07.md` a `COUNTER_AUDIT_2026-07.md`, co ji ospravedlňuje — žádná krabička není "protože to dává intuitivně smysl". Co neprošlo protiauditem, tu není, i kdyby to znělo dobře.*

---

## Diagram

```
                    ┌──────────────────────────┐
                    │   0. VSTUPNÍ DATA (PIT)   │   ← beze změny, silná stránka
                    │  git snapshoty, +1M/+1t   │
                    │  publikační lagy, FX ceny │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │     1. MAKRO REŽIM        │   informační, NE váhový gate
                    │  CB cyklus (hike/cut šíře)│   (jediná výjimka: CAD real
                    │  Inflace G8 (medián Δ CPI)│   yield slábne v cutting —
                    └────────────┬─────────────┘   viz krabička 4)
                                 │
                    ┌────────────▼─────────────┐
                    │     2. RISK REŽIM         │   ★ NEJSILNĚJŠÍ gate v celém
                    │  VIX tercil, hystereze    │   modelu — AUD/CHF/GBP i
                    │  ±5 percentilů (netiká    │   carry na něm přímo visí
                    │  každý týden)             │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  3. AKTIVNÍ FAKTORY       │   3 gates, každý zvlášť
                    │  (zapnuto/vypnuto/váha)   │   měřený (ne odhadnutý)
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  4. SÍLA MĚN (8×)         │   Model A — potvrzeno OOS
                    │  per-měnová lin. kombinace│   proti Modelu B (per-pár)
                    │  jen z faktorů co přežily │   IC +0.022 vs −0.005
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  5. VÝBĚR PÁRŮ            │   diff + crowding brzda
                    │  diff(base,quote)         │   (extrémní diff byl v
                    │  − crowding penalizace    │   replayi HORŠÍ, ne lepší)
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  6. CONFIDENCE SCORE      │   síla × shoda komponent
                    │  magnitude × breadth      │   × jistota faktoru (FDR
                    │  × jistota − crowding     │   tier) − crowding
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  7. SWING RATING          │   pásma z confidence,
                    │  slabý/střední/silný      │   NE ze surového diffu
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  8. TRADE SETUP           │   RP+ER fade timing —
                    │  (timing vstupu)          │   BEZE ZMĚNY, vlastní
                    │                           │   ověřený edge, na skóre
                    └───────────────────────────┘   nezávislý
```

---

## Krabička po krabičce

### 0 — Vstupní data (beze změny)
Point-in-time git snapshoty (kalendář, COT, ceny), publikační lagy (+1 měsíc makro, +1 týden COT). Toto je jediná vrstva, kterou žádný ze tří auditů nezpochybnil — zůstává základ.

### 1 — Makro režim (informační, ne řídící)
- **CB cyklus** (existující `getCBCycleStage()`): šíře hiking/cutting napříč G8. Ponechat jako **kontext v UI**, ne jako plošný multiplikátor — žádný audit neprokázal, že by CB cyklus měl řídit VÁHY jiných faktorů, s jedinou konkrétní výjimkou (CAD real yield, viz krabička 4).
- **Inflační směr** (medián Δ CPI G8): zobrazovat, nepoužívat jako gate — testováno jen pro CAD samostatně (jako vlastní faktor, ne jako režim), zobecnění na "makro inflační režim pro všechny měny" by bylo přesně to overfitting, před kterým varuje protiaudit.

### 2 — Risk režim ★ (jediný skutečně prokázaný režimový vypínač)
```
VIX tercil s hysterezí (přepočet jen když VIX překročí pásmo o >5 percentilů,
ať se gate nepřepíná každý týden):
  Risk-Off (VIX nad 66. percentil):
    → AUD, CHF: VIX komponenta ZESÍLENA (IC 0.184/0.096 AUD, silnější high-VIX; CHF podobně)
    → Carry (všechny měny): VÁHA → 0 (carry-crash, IC obrací znaménko ve vysokém VIX u 6/8 měn)
  Risk-On (VIX pod 33. percentil):
    → GBP: VIX komponenta ZESÍLENA (POZOR: opačně než AUD/CHF — GBP efekt je silnější
      v LOW-VIX, ne high — ekonomicky: GBP jako "risk barometer" reaguje na uklidnění,
      ne na paniku, zatímco AUD/CHF na paniku samu)
    → Carry: plná váha
  Střed:
    → základní (neregimová) váha všech komponent
```
Ekonomické zdůvodnění: AUD/CHF jsou klasické proti-směrné risk-proxy měny (AUD prodává se v panice, CHF/JPY kupují), carry-crash je zdokumentovaný jev (Brunnermeier 2008) — obojí sedí s teorií i s daty. GBP efekt je translatable jako "GBP je citlivé na normalizaci rizika", méně klasický, ale opakovaně měřený.

### 3 — Výběr aktivních faktorů (3 měřené gates)
| Gate | Podmínka | Akce | Zdroj |
|---|---|---|---|
| Carry-crash | VIX vysoký | carry váha → 0 | §2 counter-audit, 6/8 měn obrácené IC |
| COT extrém | \|z(pozice, 3y)\| > 1.28 | COT váha ×1.5, jinak ×0.5 | §2 counter-audit, extrém silnější než střed u USD/EUR/CHF/CAD/JPY |
| Momentum | — | **VŽDY vypnuto** | mean-reverting v trendu i mimo něj (vyvrácená hypotéza "funguje v trendu") |

### 4 — Síla měn: per-měnová konfigurace (Model A)

Jen faktory, co přežily FDR + režimovou stabilitu (`COUNTER_AUDIT §1, §4`):

| Měna | Aktivní faktor(y) | Jistota | Poznámka |
|---|---|---|---|
| **AUD** | VIX úroveň (+, risk-off zesílen) | vysoká (FDR q=0.05, 8/8 režimů) | nejsilnější nález celého auditu |
| **JPY** | COT asset-manager (fade, −) | vysoká (FDR q=0.05, 8/8 režimů) | |
| **CAD** | CPI akcelerace (+) · real yield (−, slábne v cutting) | vysoká / střední | dva nezávislé faktory |
| **CHF** | COT commercials (+) · VIX (−, risk-off zesílen) | střední (6/8 režimů) | COT dealer/AM vyřazeny (nestabilní) |
| **GBP** | VIX úroveň (−, risk-on zesílen) | střední (6/8 režimů) | COT dealer vyřazen (nepřežil FDR) |
| **USD** | DXY momentum h1 (+) | střední (6/8 režimů) | krátký horizont |
| **EUR** | ŽÁDNÝ prokázaný samostatný faktor | **nízká** | real-yield-flip nepřežil FDR — EUR skóre zůstává na obecném (fundamenty+COT) základu s nízkou vahou v conviction |
| **NZD** | ŽÁDNÝ prokázaný faktor | **nízká** | ani jeden NZD faktor nepřežil ani volnou FDR (q=0.20) — NZD dostává jen obecný základ, appka by měla NZD signály zobrazovat s explicitním "nízká spolehlivost" štítkem |

Výpočet: `score(ccy) = Σ aktivní_faktory · gate(§3) · z-skóre` — lineární, žádné ML (Model A > Model B > RF/XGB, `COUNTER_AUDIT §6, §8`, přímo měřeno). EUR a NZD běží s obecným základem (fundamenty z kalendáře, COT baseline), ale APLIKACE conviction (krabička 6) je u nich strukturálně tlumená, protože pro ně žádný faktor neprošel.

### 5 — Výběr párů
```
pair_diff = score(base) − score(quote)
crowding_brzda = pokud |pair_diff| extrémní A COT extrém stejným směrem A VIX nízký
                 → penalizace (replay: pásmo diff 3+ mělo PF 0.64-0.87,
                   HORŠÍ než slabé pásmo — extrémní shoda = pozdní/crowded trade)
```
Ekonomicky: silný diff, kde ho navíc podporuje extrémní spekulativní pozicování a nikdo se nebojí (nízký VIX) = pravděpodobně pozdní fáze pohybu, ne začátek.

### 6 — Confidence Score
```
confidence = magnitude(pair_diff)
           × breadth(kolik AKTIVNÍCH komponent páru souhlasí směrem)
           × jistota(FDR tier komponent zapojených — vysoká/střední/nízká z krabičky 4)
           − crowding_brzda(krabička 5)
```
Páry postavené na EUR/NZD (kde krabička 4 nemá prokázaný faktor) dostanou automaticky nižší `jistota` multiplikátor — ne proto že by EUR/NZD byly "špatné" měny, ale proto že model o nich upřímně míň ví.

### 7 — Swing Rating
Pásma z **confidence score**, ne ze surového diffu (na rozdíl od dnešního enginu) — protože surový diff extrémů byl v replayi prokazatelně horší, ne lepší signál.
```
Silný   = confidence v top kvantilu A crowding_brzda neaktivní
Střední = confidence střední, nebo silný diff s crowding_brzda (downgrade)
Slabý   = confidence nízká, nebo EUR/NZD-vedený pár bez podpory jiné komponenty
```

### 8 — Trade Setup (beze změny)
RP+ER exhaustion/fade — jediná komponenta s vlastním, nezávisle ověřeným edge (validováno mimo tento audit). Pracuje na cenové akci, ne na fundamentálním skóre — je to časování VSTUPU v rámci směru, který určily krabičky 1-7, ne náhrada za ně. **Nesahat.**

---

## Co v téhle architektuře záměrně NENÍ (a proč)

| Vynecháno | Důvod |
|---|---|
| Sezónnost ve skóre | anti-prediktivní / bez prokázané hodnoty (§1 counter-audit) |
| EUR real-yield-flip | nepřežilo FDR ani při q=0.20 |
| GBP COT dealer | nepřežilo FDR (p=0.096 na 304 testech) |
| CHF COT dealer/AM samostatně | nestabilní napříč režimy (5/8) |
| Per-párové váhy (Model B/D) | prokazatelně horší OOS než per-měna (IC −0.005 vs +0.022, vyšší rozptyl) |
| Random Forest / XGBoost / neural nets | lineární model vyhrál v purged CV (IC 0.024 vs 0.007/0.020) |
| HMM/Markov-switching pro makro režim | nedost dat na stabilní odhad skrytých stavů (~1100 týdnů, 8 korelovaných měn) |
| MOVE, OIS, cross-currency basis, risk reversals, dealer gamma, CTA positioning | proprietární/bez volné historie — nebylo možné otestovat se stejnou disciplínou jako zbytek, tudíž nejsou v modelu (ne proto, že by nefungovaly — protože to nejde ověřit) |
| Plošný "makro režim" jako váhový multiplikátor | jediný prokázaný režimový gate je VIX (krabička 2); makro/inflace zůstávají informační, ne řídicí, aby se nezaváděly neměřené parametry |

## Co by muselo přibýt, aby model rostl dál
1. **In-house Macro Surprise Index** (z vlastních kalendářních dat, potřebuje ≥12 měsíců first-print historie — běží od 2026-06, dřív ne).
2. **Delší replay okno** (dnes 784 dní pro OOS validaci celého enginu) — rozšířit `calendar_hist.json` backfill dál do minulosti, aby train/test split z counter-auditu mohl mít víc než jedno dělení.
3. **EUR a NZD zůstávají otevřený problém** — žádný z testovaných ~20 faktorů pro ně neprošel. Buď existuje jiný, netestovaný faktor (kandidáti: cross-currency basis pro EUR jako funding měnu, mléčné/agro komodity pro NZD — obojí nedostupné zdarma), nebo tyhle dvě měny jsou v tomhle rámci genuinně těžší predikovat a model by to měl přiznávat, ne skrývat za nezaslouženou jistotou.

# Architektonický audit FX Analyzeru — nezávislé posouzení

*2026-07-20 · Navazuje na `RESEARCH_AUDIT_2026-07.md` (per-měnová studie). Nová evidence: `data/research/conditional_tests.json` (režimové testy), reprodukce `scripts/research-conditional.py`. Role: nezávislý auditor — cílem bylo architekturu vyvrátit, ne potvrdit.*

---

## Verdikt úvodem

**Není potřeba přepsat 80 %. Je potřeba přepsat ~40–50 % SKÓROVACÍ logiky a zachovat ~90 % infrastruktury.** Datová vrstva analyzeru (point-in-time git snapshoty, replay backtest, kalibrační pipeline) je nadstandardní — to je přesně to, co většina retail nástrojů nemá a co umožnilo tento audit vůbec provést. Slabé je jádro výpočtu skóre: plošné váhy, špatné COT subskupiny, šumový risk_adj, sezónnost, trojité počítání sazeb. Timing vrstva (RP+ER fade signál) je jediná komponenta s vlastním validovaným edge — zachovat beze změny.

### Re-verifikace závěrů minulého auditu (nebral jsem je jako pravdu)

| Závěr | Nový test | Verdikt |
|---|---|---|
| Jednotné váhy nevhodné | podmíněné testy per měna | **POTVRZENO, zesíleno** — liší se i podmíněnost, ne jen váhy |
| COT skupiny fungují jinak per měna | extrém vs. střed split | **POTVRZENO + zpřesněno**: extrémy (|z|>1.28) zesilují per-měnové znaménko — USD/EUR extrém follow (IC +0.10/+0.14), CHF/CAD/JPY extrém fade (−0.19/−0.11/−0.10) |
| VIX > risk_adj | VIX v high/low režimu | **POTVRZENO + zpřesněno**: AUD efekt žije hlavně ve high-VIX (0.184 vs 0.096), CHF ve high-VIX (−0.13), GBP naopak v low-VIX (−0.102) |
| CAD ← CPI acceleration | subperiody již dříve | **POTVRZENO** (4/5 subperiod shodné znaménko) |
| Některé faktory opačné znaménko | — | **POTVRZENO** (realyield EUR/CAD −, mom4 − plošně) |
| Sezónnost nepřidává hodnotu | walk-forward | **POTVRZENO** — IC záporné u 5/8 měn; ani kontrariánské použití nedoporučuji (nestabilní napříč měnami) |

---

## Odpovědi na 12 otázek

### 1. Jedno skóre per měna — správně?

**Ano jako STŘEDNÍ vrstva, ne jako celý model.** 8 měnových skóre je správná parsimonie: 28 párů sdílí 8 měn, nezávislé modelování 28 párů by násobilo parametry na ~1 100 týdenních pozorováních → jistý overfit. ALE samotné skóre nestačí — chybí vrstva NAD ním (režim trhu, viz Q4) a POD ním (párové výjimky s vlastní evidencí: EURUSD cot_nc+, EURCAD/AUDCAD cpi_accel+, JPY-křížové cot_am−). Doporučená struktura: **režim → 8 měnových skóre (per-měnová konfigurace) → párový diff + max 3 párové korekce → conviction → timing.**

### 2. Lineární skóre — správně?

**Lineární jádro ano, ale s malým počtem podmíněných bran.** Data podporují právě 3 gates (víc by byl overfit):

- **Carry gate (nejsilnější nový nález):** carry má kladné IC JEN při VIX < expandní medián (6/8 měn, IC +0.03 až +0.10); při vysokém VIX se **obrací** (JPY −0.16, NZD −0.12, USD −0.10). To je učebnicový carry-crash (Brunnermeier et al. 2008) změřený na vlastních datech. → Carry složku při vysokém VIX vypnout, nebo otočit.
- **COT extrém gate:** COT vážit ×1.5 při |z|>1.28 (a s per-měnovým znaménkem), ×0.5 jindy — extrémy nesou informaci, střed pásma je šum.
- **VIX gate:** AUD/CHF VIX složku aktivovat hlavně ve high-VIX režimu; GBP v low-VIX.

Hypotéza "momentum funguje jen v trendu" — **VYVRÁCENA**: mom4 je mean-reverting v OBOU režimech (trend: CHF −0.17, NZD −0.16; range: JPY −0.17). Týdenní FX momentum nemá být zapnuté v žádném režimu. Správně je dnes vypnuté; nezapínat.

### 3. Váhy: A/B/C/D?

**B + omezené D.** Per měna různé (B) — evidence jednoznačná. Dynamika podle režimu (D) jen přes 3 gates z Q2, ne plošné převažování. **C (per pár) NE** — 28×8 parametrů na 1 100 pozorováních je overfit z definice; párová vrstva jen jako diff + 3 evidencí podložené výjimky. Plošné stejné váhy (A, dnešní stav) jsou datově vyvrácené.

### 4. Jak určovat Market Regime?

**Jednoduše, observabilně, s hysterezí. NE skrytý model.** HMM/Markov-switching na 1 100 týdnech s 8 kandidátskými stavy nelze stabilně odhadnout out-of-sample; produkční režim musí být triviálně auditovatelný:

1. **Risk režim** = VIX vs. expandní medián (příp. terciny s hysterezí ±5 percentil, aby nepřepínal každý týden). Jediný režim s prokázanými interakcemi v datech.
2. **CB cyklus** = existující `getCBCycleStage()` (hiking/cutting breadth) — ponechat, informační.
3. **Inflační směr** = medián CPI-akcelerace G8 — zatím jen zobrazovat, interakce neprokázány.

Trend/MR/carry environment NEdetekovat zvlášť — v datech je MR režim implicitní (mom4 záporné) a carry režim je funkce VIXu (bod 1 to pokrývá).

### 5. Vypínání faktorů podle režimu?

Ano, přesně 3 pravidla z Q2 — každé prošlo subperiodovým testem. Vše ostatní ("fundamenty jen při vysoké vol" apod.) v datech oporu nemá, netestované vypínače nezavádět. Pozn.: sentiment (retail) má ~1 měsíc dat — žádné režimové pravidlo pro něj nelze poctivě postavit.

### 6. Hierarchický model?

**Ano — a analyzer už z 60 % hierarchický JE** (skóre → rank párů → conviction → RP+ER timing). Chybí vrstva 1 (režim) a formalizace. Doporučený tok: **(1) režim → (2) 8 skóre per-měnovou konfigurací → (3) rank párů + crowding filtr → (4) conviction → (5) RP+ER timing.** Není to revoluce, je to dostavba.

### 7. Statické vs. adaptivní skóre?

**Statické per-měnové konfigurace + POMALÁ řízená rekalibrace. Automatické samo-učení NE.** "AI sníží váhu, když faktor 24 měsíců nefunguje" = přesně mechanismus, kterým se model přeučí na poslední režim a selže při jeho otočce (24měsíční okno by v r. 2021 vypnulo carry těsně před jeho nejlepším obdobím 2022–24). Správný postup: (a) čtvrtletní IC monitoring per faktor (dashboard, ne zásah), (b) rekalibrace max 1× ročně, výhradně přes walk-forward bránu: změna se přijme jen když zlepší OOS metriku na datech, která kalibrace neviděla, (c) James-Stein shrinkage nových vah k dlouhodobému průměru (nová_váha = 0.7×stará + 0.3×odhad), (d) každá změna verzovaná v gitu s kalibračním reportem. Overfitting brání disciplína procesu, ne algoritmus.

### 8. Nové faktory — jen ty se statistickou hodnotou

**Otestované a doporučené:** VIX úroveň (nejsilnější IC auditu), COT TFF subskupiny (dealer/AM), CPI akcelerace (CAD), DXY momentum (USD). **Otestované a zamítnuté:** měď/železo jako China proxy (robustní jen u 1 páru z 28), zlato (slabé), sezónnost. **Netestovatelné zdarma → neslibovat:** MOVE, cross-currency basis, OIS očekávání, risk reversals/vol smile, dealer gamma, CTA positioning — bez placených dat je nelze validovat, a nevalidovaný faktor do skóre nepatří. **Jedna výjimka k postavení in-house: Macro Surprise Index** — analyzer už sbírá actual vs. forecast z kalendáře; agregovaný vážený surprise index per měna je postavitelný z vlastních dat a je to nejcennější chybějící faktor (Citi CESI ekvivalent zdarma). Nejdřív ale nasbírat ≥12 měsíců first-print historie (běží od 2026-06).

### 9. Redundantní faktory (změřené korelace)

| Dvojice | Korelace | Důsledek |
|---|---|---|
| commercials × non-commercials | **−0.97** | zrcadlo TÉHOŽ čísla — nikdy nepoužívat obě jako dva signály |
| non-commercials × leveraged funds | +0.82 | totéž v jiném datasetu — vybrat jeden |
| carry3m × real yield | +0.72 | jedna sazbová rodina |
| carry3m × y10 diff | +0.67 | jedna sazbová rodina |
| dealer × asset manager | −0.65 | částečné zrcadlo — používat jeden jako primární |

→ **Sloučit na 2 faktory tam, kde jich dnes engine počítá 5+:** jeden SAZBOVÝ faktor per měna (úroveň/směr dle měny; dnešní beat/miss + yieldAdj + policyAdj počítají jedno rozhodnutí CB třikrát) a jeden POZIČNÍ faktor per měna (zvolená subskupina + znaménko + extrém gate).

### 10. Chybějící logika (extrémní diff)

"USD extrémně silný + JPY extrémně slabý → zvýhodnit USDJPY?" **NE — replay ukázal opak:** pásmo diff 3+ mělo PF 0.64–0.87, HORŠÍ než slabé diff. Extrémní rozdíl skóre = často crowded/pozdní trade. Chybí opačný filtr: **crowding brzda** (extrémní diff + COT extrém stejným směrem + nízký VIX → conviction snížit, ne zvýšit) a **breadth filtr** (bias potvrzený víc složkami > extrém jedné složky).

### 11. Nový výpočet skóre

**Zůstat u lineárního, z-skórovaného, shrinkovaného modelu s 3 gates — ML modely zamítám s odůvodněním:** RF/GBM/HMM potřebují řádově víc pozorování, než FX G8 poskytuje (1 100 týdnů × 8 silně korelovaných měn; Gu–Kelly–Xiu fungují na tisících akcií). Vlastní RF test (permutation importance, purged CV) nepřinesl OOS zlepšení proti lineárnímu IC výběru. Bayesovské přeučování = řízená rekalibrace z Q7 (lidský krok, ne online učení). Vzorec:

```
score(ccy) = Σ_f  w(ccy,f) · sign(ccy,f) · gate(f, režim) · z(faktor_f)
pair_bias  = score(base) − score(quote) + párové_korekce(≤3) − crowding_brzda
```

Škálování ±10 pro UI zachovat.

### 12. Nejlepší FX Analyzer na světě (cílová architektura)

```
VRSTVA 0  DATA (PIT)      git snapshoty, publikační lagy, first-print — MÁTE, rozšířit o VIX/TFF cron
VRSTVA 1  REŽIM           VIX tercil s hysterezí + CB cyklus (observabilní, auditovatelné)
VRSTVA 2  FAKTORY         ~6 ortogonálních rodin: sazby | pozice | inflace | risk | USD-beta | surprise (in-house)
                          každý faktor má "validační kartu": IC, subperiody, p, poslední re-test
VRSTVA 3  SKÓRE           lineární, per-měnová konfigurace {váha, znaménko, gate}, shrinkage
VRSTVA 4  PÁRY            diff + ≤3 evidencí podložené korekce + crowding/breadth filtry
VRSTVA 5  CONVICTION      sázka dle síly A shody složek, penalizace crowded
VRSTVA 6  TIMING          RP+ER (validované, beze změny)
VRSTVA 7  VALIDACE        replay backtest jako CI brána: žádná změna vah bez OOS zlepšení
VRSTVA 8  MONITORING      čtvrtletní IC dashboard, roční řízená rekalibrace
```

Od dnešního stavu to není přepis — vrstvy 0, 6, 7 existují a jsou silné; vrstva 3–5 se přestavuje; 1, 2 (částečně), 8 se přidávají.

---

## Priority a odhad přínosu

Kotva: simulace návrhů 1–4 nad replayem zlepšila PF 0.83 → 1.07 (všech 8 měn kladně; síla komponent ale škálována in-sample — brát jako horní odhad, walk-forward split nutný před nasazením).

| # | Změna | Odhad přínosu (PF na replayi) | Jistota |
|---|---|---|---|
| 1 | Sezónnost pryč ze skóre | +0.01–0.02 | vysoká |
| 2 | COT per měna (subskupina+znaménko+extrém gate) | +0.10–0.20 (JPY/CHF nejvíc) | vysoká (20 let, subperiody) |
| 3 | risk_adj → VIX s per-měnovým směrem a režimem | +0.05–0.10 | vysoká |
| 4 | Carry/VIX gate | +0.03–0.08 | střední-vysoká |
| 5 | CPI akcelerace CAD | +0.02–0.04 | střední |
| 6 | Sloučení sazbových kanálů + per-měnová znaménka | +0.05–0.15 | střední (invazivní, poslední) |
| 7 | Crowding/breadth filtr do conviction | nepřímý (méně špatných silných signálů) | střední |
| 8 | In-house surprise index | neznámý (nutno ≥12 m dat) | — |

Realistický souhrn po walk-forward validaci: **PF celku z 0.83 na ~0.95–1.10.** Upřímně: i horní hranice je "mírný edge", ne stroj na peníze — hodnota analyzeru je v kombinaci bias + conviction + timing + deník, ne v samotném skóre.

## Rizika

Vše výše je jedna historická epocha (2000–2026) s dominancí post-2008 režimů; VIX interakce táhnou krize; multiple-testing riziko trvá i po subperiodových filtrech; retail sentiment prakticky netestován (1 měsíc dat); JPY real-yield po 2021 netestovatelný z FRED. Proto: každý krok zvlášť, přes replay bránu, žádné hromadné nasazení.

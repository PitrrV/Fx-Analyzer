# Statistický audit FX Analyzeru — per-měnová a per-párová studie

*Datum: 2026-07-20 · Reprodukce: `node scripts/fetch-research-data.js` (Actions) → `python3 scripts/research-audit.py` · Výsledky: `data/research/audit_results.json`*

> **Oprava 2026-08-15**: nález "vysoký VIX → AUD **následný** rebound" (řádek níže) byl formulovaný správně — je to DOPŘEDNÝ vztah (VIX týdne T → return AUD týdne T+1..T+4), ne kontemporální. Problém byl v aplikaci: `getRiskSentimentAdj` v `engine.js` se volá s KONTEMPORÁLNÍM vstupem (`computeAutoRiskSentiment`/`classifyRegime` = "jaké je VIX teď/za posledních 5 dní"), ne dopředným — a AUD/CHF znaménko z tohodle auditu tam bylo použité, jako by šlo o kontemporální vztah. Nezávislé přepočítání (appčiny vlastní ceny 2006–2026) i nezávislá revize sesterské appky Fundamet-app shodně potvrzují: kontemporálně AUD risk-off SLÁBNE (IC −0,39), CHF risk-off POSILUJE (IC +0,27) — konvenční směr. `getRiskSentimentAdj` vrácen na konvenční znaménko pro AUD/CHF, viz komentář u funkce v `engine.js`. GBP beze změny (souhlasí oběma způsoby).

---

## 1. Executive Summary

Audit **nepotvrdil** současnou architekturu skóre. Hlavní zjištění:

1. **Jedno plošné nastavení vah pro všech 8 měn je datově neobhajitelné.** Každá měna má jinou množinu faktorů, které za ~20–26 let prošly robustnostním filtrem — a u několika faktorů se **liší i znaménko** mezi měnami.
2. **Sezónnost je při poctivém (walk-forward) testu konzistentně ANTI-prediktivní** — u 5 z 8 měn a u řady párů vychází záporné IC (−0.08 až −0.14). Aktuální váha 2 % je malá, ale jde špatným směrem. Doporučení: odstranit ze skóre (ponechat jen jako informační tab).
3. **COT je používán špatně.** Engine používá non-commercial pozice se stejným znaménkem pro všechny měny. Data říkají: **asset manažeři jsou kontrariánský signál** (JPY IC −0.147, CHF −0.114, přenáší se do AUDJPY −0.172, NZDJPY −0.139, CHFJPY −0.152), **dealeři jsou follow signál** (druhá strana), commercials fungují u CHF. Non-commercial (co engine používá) není robustní skoro nikde — u CHF je dokonce robustně záporný.
4. **VIX (úroveň) je nejsilnější jednotlivý prediktor v celém auditu** — ale s opačným znaménkem, než jak o riziku uvažuje engine: vysoký VIX **predikuje následné posílení** AUD (IC +0.20, nejvyšší v auditu) a oslabení GBP (−0.127). Engine místo toho počítá `risk_adj` z momenta AUDJPY/NZDJPY, které flipuje každých ~16 dní (šum) a robustní není.
5. **Real yield diferenciál na týdenním horizontu funguje u EUR a CAD OBRÁCENĚ** (IC −0.117 / −0.145): relativně rostoucí reálný výnos předpovídá oslabení měny (value/mean-reversion efekt, ne carry). Pozor: to není spor s dřívějším replay nálezem "yield funguje pro JPY" — tam šlo o jiný signál (statická úroveň sazba−CPI) na 2letém okně BoJ normalizace; v tomto 20letém panelu realyield pro JPY robustní není.
6. **Týdenní FX momentum je mean-reverting**: `mom4` má záporné IC u JPY, CAD, CHF, NZD i řady párů. Engine má momentum vypnuté (`MOMENTUM_ENABLED=false`) — správně; nezapínat.
7. **Inflační akcelerace (Δ CPI YoY za ~3 měsíce) je skutečný driver CAD** (IC +0.144, přenáší se do EURCAD, AUDCAD, CADCHF s PF 1.2–1.38). Engine nic takového nepočítá — CPI používá jen staticky v real yieldu a jako beat/miss eventy.
8. **NZD je nejslabší měna auditu** — jen 3 slabé robustní faktory. Souhlasí s replay backtestem (žádná komponenta PF>1). Skóre NZD by mělo mít nižší váhu v conviction/doporučeních, dokud se nenajde funkční signál.

**Souhrn kritiky enginu:** CB sazba se počítá 3× (beat/miss + yield + policy — kolineární), risk_adj je šumová náhražka VIXu, sezónnost škodí, COT má špatnou subskupinu i znaménko, chybí per-měnové váhy, chybí inflační akcelerace, momentum správně vypnuté, oil pro CAD na týdenním horizontu robustní není (jen situační).

---

## 2. Metodologie

- **Panel:** týdenní (pátek), ~1 100–1 380 týdnů dle měny (2000/2003→2026). Cena měny = **basket index**: průměr sign-adjusted log-returnů všech 7 párů s danou měnou (z `data/fx_daily/`, ~5 900 obchodních dní/pár).
- **Faktory (21):** carry 3M diff, 10Y yield diff, real yield diff (3M − CPI YoY), inflační akcelerace (Δ13w CPI YoY), COT legacy non-commercial a commercial net/OI, TFF dealer/asset-manager/leveraged net/OI, momentum 4w/12w, realizovaná vol 4w, VIX úroveň a Δ4w, returny ropy/zlata/mědi/DXY 4w, walk-forward sezónnost (expanding průměr měsíce, min. 5 let historie).
- **Anti-look-ahead:** měsíční makro posunuto +1 měsíc (publikační lag), COT +1 týden, sezónnost jen z let PŘED testovaným rokem. Cíl: forward return t+1…t+h, h ∈ {1, 4} týdny.
- **Testy:** Spearman IC; p-hodnota přes moving-block bootstrap (500 vzorků, blok 8 týdnů, zachovává autokorelaci); sign-trading PF; **subperiody** 2008–12 / 12–16 / 16–20 / 20–23 / 23–dnes.
- **Robustní faktor** = |IC| ≥ 0.03 ∧ bootstrap p < 0.10 ∧ shoda znaménka IC v ≥3 ze 4 posledních subperiod. Tento filtr je hlavní obrana proti overfittingu při 21 × 2 × 36 = 1 512 testech (při α=0.10 čekáme ~150 falešných "hitů" — proto subperiodová shoda; přesto ber jednotlivé slabé IC s rezervou).

### Použité zdroje
FRED (US 2Y/10Y/FF/VIX/WTI/DXY denně; 3M interbank, 10Y, CPI pro 8 zemí měsíčně; měď/železná ruda IMF) · CFTC Socrata (legacy COT od 1986, TFF od 2006, NZD od 1998) · Yahoo (zlato GC=F od 2000) · vlastní `data/fx_daily` (Stooq/Yahoo, 28 párů, ~22 let).

### Co NEŠLO otestovat (proprietární / bez volné historie)
PMI (S&P Global), MOVE index, Citi Economic Surprise Index, OIS/forward očekávané sazby, iron ore spot, intradenní data. Japonské CPI na FRED končí 2021 → real yield JPY je po 2021 stale (nižší důvěra v JPY yield závěry z tohoto panelu; JPY-specifická otázka viz §1 bod 5.)

---

## 3. Výsledky per měna (robustní faktory, řazeno dle |IC|, horizont 4w pokud neuvedeno)

| Měna | Robustní faktory (IC) | Interpretace |
|---|---|---|
| **USD** | dxy_r4 +0.097 (h1) · seasonal −0.095 · vol4 +0.082 · vix_chg +0.070 (h1) | USD: krátkodobá kontinuace DXY trendu; sezónnost anti; roste-li vol/VIX, USD následně posiluje (safe haven premium). Sazbové faktory pro USD samostatně robustní NEJSOU. |
| **EUR** | realyield **−0.117** | Jediný robustní faktor, a obráceně než čekáš: relativně vyšší reálný výnos EA → EUR následně slábne (mean-reversion/value). |
| **GBP** | vix_lvl −0.127 · cot_dealer +0.091 · dxy_r4 −0.054 (h1) | GBP = risk-on měna: vysoký VIX predikuje oslabení. Dealer pozice follow. |
| **JPY** | cot_am **−0.147** · seasonal −0.100 · cot_dealer +0.092 · mom4 −0.078 · vol4 −0.064 (h1) | Nejčistší kontrariánský profil: fade asset manažery, follow dealery, mean-reversion. |
| **AUD** | vix_lvl **+0.200** · mom12 −0.095 · seasonal −0.095 | Nejsilnější IC auditu: vysoký VIX → AUD následný rebound (risk premium). Dlouhé momentum anti. |
| **CAD** | realyield −0.145 · **cpi_accel +0.144** · mom4 −0.082 | Inflační akcelerace = skutečný CAD driver (BoC očekávání). Real yield obráceně (jako EUR). |
| **CHF** | cot_comm +0.129 · cot_dealer +0.120 · cot_am −0.114 · vix_lvl −0.098 · cot_nc −0.092 | Učebnicové COT: commercials/dealers mají pravdu, spekulanti (nc, am) se fadují. Pozn.: vix −0.098 = po stresu CHF sláblo (unwind haven flows). |
| **NZD** | mom4 −0.078 · seasonal −0.075 · vix_chg −0.050 (h1) | Nejslabší měna — žádný silný driver. |

## 4. Výsledky per pár (top robustní faktory)

Všech 28 párů má ≥1 robustní faktor. Výběr nejsilnějších (plná tabulka v `audit_results.json`):

| Pár | Top faktory (IC, sign-PF) |
|---|---|
| EURUSD | realyield −0.153 (PF 0.69 → kontrariánsky 1.44) · vol4 +0.119 · cot_nc +0.115 (PF 1.20 — jediný pár, kde nc funguje) |
| AUDUSD | vix_lvl +0.195 · cot_am +0.115 (PF 1.30) · seasonal −0.112 |
| USDCHF | vol4 +0.137 (PF 1.23) · vix_chg +0.111 (PF 1.31) · dxy_r4 +0.085 (PF 1.28, h1) |
| EURCAD | realyield −0.165 · **cpi_accel +0.147 (PF 1.28)** |
| AUDCAD | vix_lvl +0.150 · cpi_accel +0.113 (PF 1.38) |
| AUDJPY | cot_am −0.172 · vix_lvl +0.119 (PF 1.09) |
| CADJPY | cot_dealer +0.121 (PF 1.17) · cot_am −0.098 |
| CHFJPY | cot_am −0.152 · cot_dealer +0.088 (PF 1.22) |
| GBPAUD | vix_lvl −0.191 |
| EURAUD | vix_lvl −0.178 · mom12 −0.115 |
| GBPCAD | realyield −0.137 · carry3m −0.107 |
| NZDJPY | cot_am −0.139 · seasonal −0.103 · mom4 −0.099 |
| GBPJPY | seasonal −0.116 · mom4 −0.093 · copper_r4 +0.084 (PF 1.31) |

Vzorec je konzistentní s per-měnovými výsledky: **JPY křížové páry žijí z COT (fade AM / follow dealer), AUD páry z VIXu, CAD páry z inflační akcelerace a (obráceného) real yieldu.** To vysvětluje i JPY debakl v replay backtestu: engine pro JPY váží fund/COT-nc/policy, tedy přesně to, co pro JPY nefunguje.

## 5. Doporučené váhy (návrh k walk-forward validaci, NE finální pravda)

Odvozeno z |IC| robustních faktorů (h4), normalizováno; znaménko = směr signálu. "−" = **použít obráceně**, než by engine dnes předpokládal.

| Měna | Návrh složení skóre |
|---|---|
| USD | DXY momentum 35 % (+) · vol/VIX změna 30 % (+) · fund kalendář 25 % (jediná měna, kde v replayi fungoval, PF 1.04) · COT 10 % |
| EUR | real yield 45 % (**obráceně**) · policy 30 % (replay PF 1.10) · COT dealer 15 % · zbytek 10 % |
| GBP | VIX úroveň 35 % (**−**) · yield diff 30 % (+, replay 1.05) · COT dealer 20 % · DXY 15 % (−) |
| JPY | COT asset-mgr 35 % (**kontrariánsky**) · COT dealer 20 % (+) · real-yield/carry úroveň 30 % (+, z replaye — v panelu netestovatelné po 2021, viz limity) · mean-reversion mom4 15 % (−) |
| AUD | VIX úroveň 40 % (+ **rebound logika**) · COT 20 % (+) · yield 20 % (+) · mom12 20 % (−) |
| CAD | CPI akcelerace 35 % (+) · COT nc 30 % (+, replay 1.09, 0 flipů) · real yield 20 % (**−**) · mom4 15 % (−) |
| CHF | COT commercials 35 % (+) · COT dealer 25 % (+) · COT AM/nc 25 % (**−**) · VIX 15 % (−) |
| NZD | ŽÁDNÉ silné složení — držet nízkou váhu skóre v ranku párů; policy 40 % · mom4 30 % (−) · VIX změna 30 % (−), vše slabé |

Per-pár váhy: pro 28 párů doporučuji **neodvozovat samostatné váhy** (28 × ~10 parametrů = jistý overfit na 1 100 týdnech), ale skládat je z per-měnových vah + 3 párové výjimky s nejsilnější evidencí: EURUSD (cot_nc +), AUDCAD/EURCAD (cpi_accel +), JPY-křížové (cot_am −).

## 6. Co v analyzeru zrušit / sloučit / opravit

| Problém | Evidence | Doporučení |
|---|---|---|
| Sezónnost ve skóre | walk-forward IC záporné u 5/8 měn | **Odstranit ze skóre** (tab ponechat) |
| `risk_adj` z momenta AUDJPY/NZDJPY | 48 sign-flipů/2 roky, PF ~1.0 | Nahradit VIX úrovní s per-měnovým znaménkem (+AUD, −GBP/CHF) |
| COT non-commercial pro všechny měny | robustní jen EURUSD; CHF záporný | Per-měna: AM kontrariánsky (JPY/CHF), dealer follow, commercials CHF, nc jen CAD/EURUSD |
| CB sazba 3 kanály (beat/miss + yield + policy) | kolineární (carry3m/y10/realyield korelace >0.8) | Sloučit do 1 sazbového faktoru per měna s per-měnovým znaménkem |
| fund_data plošně | replay: nejhorší u 6/8 měn, funguje jen USD | Per-měna váhu ↓ (mimo USD), prošetřit EVENT_RULES mimo-US |
| oil pro CAD | týdenně nerobustní | Ponechat jen jako capped situační korekci, neškálovat |
| momentum | mom4 IC záporné široce | Nechat vypnuté; případně otočit jako mean-reversion |
| Chybí | cpi_accel (CAD!), VIX úroveň, COT subskupiny, DXY momentum (USD) | Přidat |

## 7. Rizika a limity

- **Multiple testing:** i po robustnostním filtru mohou být slabší IC (<0.06) šum. Nejvyšší důvěra: vix_lvl/AUD, cot_am/JPY, cpi_accel/CAD, seasonal anti, realyield−/EUR+CAD.
- **IC ≠ zisk:** IC 0.1–0.2 je na FX slušné, ale PF sign-tradingu se pohybuje 0.65–1.38 — žádný faktor není samospásný; kombinace a risk management rozhodují.
- **Režimy:** VIX efekty jsou tažené krizemi (2008/2020) — v klidných letech slabé. Subperiodový filtr to částečně ošetřuje.
- **Publikační lagy jsou konzervativní** (1 měsíc); reálně jsou data dřív — skutečné IC může být mírně vyšší.
- **JPY real yield po 2021 netestován** (FRED díra) — JPY yield doporučení stojí na 2letém replayi, ne na 20letém panelu.

## 8. Priority implementace (dle očekávaného přínosu / risku)

1. **Odstranit sezónnost ze skóre** — malý zásah, jasná evidence (i in-sample "zisk" byl artefakt).
2. **VIX úroveň místo risk_adj** — nejsilnější nový signál; vyžaduje denní VIX zdroj (FRED cron).
3. **Per-měnové COT subskupiny + znaménka** (TFF data už umí `fetch-cot.js` doplnit) — největší přínos pro JPY/CHF křížové páry, které jsou dnes nejhorší.
4. **CPI akcelerace pro CAD** (a test pro ostatní).
5. **Sloučení sazbových kanálů + per-měnové znaménko real yieldu** — největší zásah do architektury, dělat poslední a za walk-forward validace na `engine_hist.json`, který mezitím roste.

Každý krok validovat replay backtestem (`scripts/backtest-replay.js`) před merge — pipeline na to v repu už existuje.

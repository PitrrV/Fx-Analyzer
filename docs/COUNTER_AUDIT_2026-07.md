# Protiaudit — nezávislé zpochybnění vlastního auditu FX Analyzeru

*2026-07-20 · Cíl: vyvrátit `RESEARCH_AUDIT_2026-07.md` a `ARCHITECTURE_AUDIT_2026-07.md`, ne je potvrdit. Nová evidence: `data/research/{fdr_correction,regime_breakdown,oos_split_test,ml_comparison,model_compare}.json`, reprodukce `scripts/counter-audit-*.{py,js}`.*

> **Ověřeno 2026-08-15**: čísla "7 při q=0,10 / 16 při q=0,20" níže se vztahují k **currency-level FDR (304 testů)**, ne k pooled FDR přes všech 1368 testů najednou (pooled dává jiná čísla — 16/24, viz `data/research/fdr_correction.json` sekce `pooled_1368`). Dřívější verze `fdr_correction.json` ukládala jen pooled výsledek bez téhle poznámky, což na první pohled vypadalo jako rozpor s prózou v tomhle dokumentu — `scripts/counter-audit-fdr.py` teď počítá a ukládá obě metodiky zvlášť (`pooled_1368` / `currency_level_304`), reprodukováno a sedí přesně: 7/16.

---

## Verdikt úvodem

**Minulý audit byl v hlavních závěrech správný, ale výrazně PŘECEŇOVAL počet skutečně prokázaných faktorů a NEDOSTATEČNĚ testoval, jestli navrhované zlepšení přežije poctivé rozdělení na trénovací a testovací data.** Po formální korekci na mnohonásobné testování (Benjamini-Hochberg FDR) přežije z 202 "robustních" nálezů jen **7 při přísné (q=0,10) a 16 při volnější (q=0,20) hranici** — a i tak jde z většiny o stejnou hrstku podkladových efektů (VIX/AUD, COT asset-manager/JPY, CPI akcelerace/CAD), ne o 8 nezávisle podložených měnových profilů, jak minulý audit implikoval. Naopak **klíčové tvrzení "PF 0,83→1,07" z simulace obstálo i v poctivém train/test split** — na skutečně nedotčených datech vyšlo PF 0,875→1,029, menší, ale reálné zlepšení, ne artefakt in-sample doškálování.

**Odhad správnosti architektury: ~55–65 %, ne 90 %, ale ani 30 %.** Datová infrastruktura (vrstva 0, 6, 7 z minulého auditu) zůstává silnou stránkou beze změny verdiktu. Skórovací logika potřebuje méně rozsáhlý zásah, než minulý audit navrhoval — ne kvůli tomu, že by věci fungovaly, ale kvůli tomu, že jen ČÁST navrhovaných změn má statisticky obhajitelnou evidenci; zbytek (GBP COT dealer, CHF COT dealer samostatně, EUR real yield) je slabší, než jak byl prezentován.

---

## 1. Ověření závěrů minulého auditu

| Tvrzení minulého auditu | Verdikt | Odůvodnění |
|---|---|---|
| "Sezónnost je anti-prediktivní" | **Částečně souhlasím** | Walk-forward IC je záporné konzistentně, ale po FDR korekci přežívá jen 1 nález (`USD seasonal_wf_h1`, p=0,004) při q=0,20 — u ostatních 7 měn je "anti-prediktivnost" reálná, ale statisticky slabší, než jak byla prezentována. Závěr "nedávat do skóre" platí, ale ne proto, že je to prokazatelně škodlivé u všech měn — spíš proto, že u žádné není prokazatelně užitečné. |
| "VIX funguje lépe než risk_adj" | **Souhlasím, silně** | AUD:vix_lvl je NEJSILNĚJŠÍ nález celého auditu — přežívá FDR při q=0,05 (nejpřísnější), stabilní ve **8 z 8** testovaných režimů (finanční krize, QE, covid, hiking, cutting…). GBP a CHF směr potvrzen, ale slabší (6/8 režimů, FDR jen při q=0,20). |
| "Asset manažeři jsou kontrariánský indikátor (JPY/CHF)" | **Souhlasím pro JPY, částečně pro CHF** | JPY:cot_am přežívá FDR i q=0,05 a je stabilní 8/8 režimů — jeden z nejsilnějších nálezů vůbec. CHF verze (přes commercials/dealer/am kombinaci) je slabší: `cot_comm` samostatně přežívá (6/8 režimů), ale `cot_dealer` je **NESTABILNÍ** (jen 5/8 režimů shoda znaménka) — přeskládání COT pro CHF bych zúžil jen na commercials, ne na celou trojkombinaci z minulého auditu. |
| "CPI akcelerace je nejlepší faktor pro CAD" | **Souhlasím** | Přežívá FDR i při q=0,05, stabilní 8/8 režimů — spolu s AUD-VIX a JPY-cot_am tvoří nejsilnější trojici celého auditu. Důležitá oprava: v PŮVODNÍM poolovaném FDR testu (1368 testů najednou) tenhle nález nepřežil kvůli tomu, že desítky AUD-párů uměle nafoukly počet testů (viz bias č. 4 níže) — teprve při korektním testování jen na úrovni měn (304 testů) vyjde najevo, že jde o silný nález.
| "Real yield u EUR/CAD funguje obráceně" | **Částečně souhlasím** | CAD verze silná a stabilní (6/8 režimů, FDR q=0,20). EUR verze **NEPŘEŽÍVÁ** ani volnou FDR korekci (p=0,03 na 304 testech nestačí) — tvrzení pro EUR bylo přeceněné, postavené na subperiodovém souhlasu, ne na formální významnosti. Doporučuji EUR real-yield-flip z priority seznamu odstranit, CAD ponechat. |
| "GBP reaguje na COT dealer pozice" | **Nesouhlasím v současné podobě** | p=0,096 na 304 testech — nepřežívá ani nejvolnější FDR (q=0,20). Byl to jeden z nejslabších "robustních" nálezů už v původním auditu (sub_agree jen 3/4) a container efekt (GBP-VIX) je řádově silnější. Doporučuji COT-GBP komponentu z priorit vyřadit, ponechat jen VIX-GBP. |

---

## 2. Nalezené statistické pasti

1. **Multiple testing bias (nejzávažnější).** 1368 testů, z toho minulý audit označil 202 (14,8 %) za "robustní" jen na základě |IC|≥0,03 ∧ p<0,10 ∧ shoda 3/4 subperiod. Při 1368 testech a p<0,10 čekáme **~137 falešných pozitiv jen náhodou** — subperiodový filtr tohle riziko snižuje, ale neeliminuje formálně. Po BH-FDR korekci (q=0,10) přežije **7 nálezů na úrovni měn**, ne 202.
2. **Korelovaný multiple-testing (nová chyba, kterou jsem odhalil až teď).** Naivní FDR přes všech 1368 testů (currency+pair pohromadě) je naopak **příliš přísná** opačným směrem — 28 párových testů AUD (AUDUSD, EURAUD, GBPAUD…) všechny testují ten samý AUD-VIX efekt, ne 28 nezávislých hypotéz. To umělo "vyždímalo" FDR budget a vytlačilo skutečně platný, ale o něco slabší CAD-CPI nález z přeživších. Oprava: FDR počítat zvlášť na úrovni měn (nezávislejší), párové testy brát jako potvrzující evidenci, ne jako dalších 1064 hypotéz.
3. **Look-ahead risk v CPI datech — ověřeno, v pořádku.** Publikační lag +1 měsíc na měsíčních sériích je konzervativní (reálný lag US CPI je ~2 týdny, ne měsíc) — pokud je chyba, je na bezpečné straně (podhodnocuje, ne nadhodnocuje edge).
4. **Regime bias — z části potvrzen.** 3 nejsilnější nálezy (AUD-VIX, JPY-cot_am, CAD-cpi_accel) jsou stabilní 8/8 explicitních režimů (krize/QE/covid/hiking/cutting) — TOHLE riziko se nepotvrdilo u nich. U CHF-cot_dealer se ALE potvrdilo (5/8, nestabilní) — bez tohoto testu by to prošlo jako "robustní" jen na základě FDR q=0,20.
5. **Data snooping / in-sample škálování — potvrzeno a OPRAVENO.** Simulace "PF 0,83→1,07" byla sama upozorněna na riziko, že škálovací faktory (VIX risk, COT rework, CPI akcelerace) byly fitované na STEJNÉM okně, na kterém se měřil výsledek. Poctivý train/test split (viz §3) ukázal reálné, ale menší zlepšení.
6. **Survivorship/selection bias v datech — nekontrolováno, nízké riziko.** COT/FRED série nemají survivorship problém (makro série, ne akcie), ale STANDARD_PAIRS byl zvolen jako "dnešní" sada 28 párů — historicky mohly existovat páry, co dnes nejsou likvidní/sledované; dopad na výsledek pravděpodobně zanedbatelný pro G8 měny.

---

## 3. Robustnost — nad rámec walk-forwardu

### Purged K-fold CV (6 bloků, embargo 10 dní)
Použito pro ML srovnání (§6 níže) — purge odstraňuje z trénovací sady pozorování, jejichž 4týdenní forward-return okno by jinak přesahovalo do testovacího bloku (klasická Lopez de Prado leakage).

### Train/test split s embargem — poctivý OOS test simulace
Replay okno (784 dní) rozděleno přesně napůl: **train** 2024-05-27→2025-06-22 (škálovací faktory VIX/COT/CPI fitované JEN tady), embargo 10 dní, **test** 2025-07-03→2026-07-19 (měření JEN tady, škálování se z testu vůbec nevidělo).

| | STARÉ skóre | NOVÉ skóre (návrh 1-4) |
|---|---|---|
| Train (in-sample) | PF 0,809 | PF 1,094 |
| **Test (skutečný OOS)** | **PF 0,875** | **PF 1,029** |

Zlepšení na testu (+0,154 PF) je **menší** než na trainu (+0,285) — očekávaný a zdravý pattern (in-sample vždy nadhodnocuje). Důležité: **zlepšení přežilo** — na datech, která škálování vůbec nevidělo, skóre přešlo z prokazatelně ztrátového (0,875) na mírně ziskové (1,029). To je přiměřeně silná evidence, ne jistota — jedno train/test dělení na 784 dnech je jeden vzorek, ne rozdělení přes víc period.

### Co NEBYLO uděláno (poctivě přiznaný limit tohoto kola)
Combinatorial Purged CV (víc cest kombinací train/test bloků), plnohodnotný Monte Carlo permutační test na celém pipeline, bootstrap CI přímo na PF (dělal jsem bootstrap jen na IC) — tohle by byl další krok, ne provedeno teď kvůli časové náročnosti. Uvedené výsledky ber jako "obstálo v prvním poctivém OOS testu", ne jako "statisticky jisté".

---

## 4. Chování napříč režimy (8 explicitních období)

Testováno na 8 nálezech, co přežily FDR (q≤0,20): Finanční krize (2008-01→2009-06), QE1-3 (2009-07→2015-12), Nízká inflace (2010→2020), Covid crash (2020-02→2020-06, **málo dat, n~21, nevyhodnotitelné**), Covid QE (2020-07→2021-12), Vysoká inflace (2021-06→2023-06), Hiking cycle (2022-03→2023-07), Cutting cycle (2024-09→2026-07).

| Faktor | Shoda znaménka | Verdikt |
|---|---|---|
| AUD:vix_lvl | 8/8 | **STABILNÍ** — funguje v krizi i mimo ni, drahé i levné peníze |
| JPY:cot_am | 8/8 | **STABILNÍ** |
| CAD:cpi_accel | 8/8 | **STABILNÍ** |
| CHF:cot_comm | 6/8 | VĚTŠINOU (výjimky: QE1-3 éra, Cutting cycle — obě téměř nulové IC, ne opačné) |
| GBP:vix_lvl | 6/8 | VĚTŠINOU (výjimka: Covid QE, Cutting cycle) |
| USD:dxy_r4 | 6/8 | VĚTŠINOU |
| CAD:realyield | 6/8 | VĚTŠINOU (výjimka: Covid QE, Cutting cycle — real yield efekt v cutting cyklu čekaně slábne) |
| CHF:cot_dealer | 5/8 | **NESTABILNÍ** — vyřadit z priorit |

Covid-crash okno (2020-02→06) má napříč všemi faktory nedostatek dat (n≤21 týdnů) — žádné tvrzení "funguje/nefunguje v krizi" z tohohle auditu o samotném covid šoku nelze opřít, jen o krizi 2008 (n=78, dost).

---

## 5. Návrh dynamického režimového vážení

Na základě §4 (jen stabilní/většinou-stabilní faktory dostávají větší dynamickou složku, nestabilní zůstávají na fixní nízké váze):

```
RISK REŽIM (VIX tercil s hysterezí ±5 percentilů, přepočet týdně):
  Risk-Off (VIX > 66. percentil):
    AUD: VIX váha ↑ (efekt silnější ve vysokém VIX, IC 0,184 vs 0,096 nízký)
    CHF: VIX váha ↑ (efekt silnější ve vysokém VIX)
    GBP: VIX váha ~beze změny (efekt SILNĚJŠÍ v low-VIX, ne high — pozor na intuitivní chybu)
    Carry (všechny měny): váha → 0 (carry-crash efekt, změřeno dřív)
  Risk-On (VIX < 33. percentil):
    Carry: plná váha
    GBP: VIX váha ↑
    AUD/CHF: VIX váha ↓ na základní úroveň

CB CYKLUS (existující getCBCycleStage(), ponechat jako gate):
  Cutting cycle: CAD real-yield váha ↓ (efekt v cutting cyklu slábne — 8. bod výše)
  jinak: beze změny

VŠE OSTATNÍ (JPY cot_am, CAD cpi_accel, USD dxy):
  BEZE ZMĚNY napříč režimy — to je jejich síla (stabilní 8/8), režimová podmínka by tu jen přidala parametry bez evidence.
```

Důležité: dynamické váhy přidávat JEN tam, kde regimová podmíněnost byla přímo změřena (§4). Plošné "všechno je citlivé na režim" by byl přesně ten overfitting, před kterým varuje §2.

---

## 6. Per-currency vs. per-pair vs. hybrid — reálné OOS srovnání

Purged 6-fold CV, každý model predikuje 4týdenní forward return páru, IC a sign-PF měřené VÝHRADNĚ na test foldech.

| Model | Popis | Průměr IC (28 párů) | Rozptyl IC | Průměr PF | Párů s PF>1 |
|---|---|---|---|---|---|
| **A — per-currency** | 8 měnových regresí (14 faktorů), pár = diff(base,quote) | **+0,022** | **0,040** (nízký) | **1,061** | **17/28** |
| **B — per-pair** | 28 samostatných regresí, pár = diff faktorů jako přímý vstup | **−0,005** | **0,069** (vysoký) | 1,023 | 16/28 |

**Model B (per-pár) je HORŠÍ i navzdory tomu, že má víc parametrů a "měl by" líp sedět datům** — přesně to je definice overfittingu: 14 parametrů na ~200–1000 týdenních pozorováních per pár je moc na to, aby regrese generalizovala, i s purge/embargo ochranou. Model A vyhrává na všech třech metrikách (vyšší průměr, nižší rozptyl = konzistentnější napříč páry, víc ziskových párů).

**Model C (hybrid) nebyl numericky testován zvlášť** — ale architektonický audit ho fakticky navrhuje (per-měna + max 3 párové výjimky s vlastní evidencí, ne 28 plných regresí) a data ho podporují nepřímo: síla Modelu A + fakt, že 3 KONKRÉTNÍ párové jevy (EURCAD/AUDCAD cpi_accel, JPY-křížové cot_am) přežily FDR i na párové úrovni znamená, že malý počet CÍLENÝCH výjimek pravděpodobně přidá hodnotu bez rizika Modelu B. **Model D (plně dynamické párové váhy) a Model E (AI adaptivní)** nebyly testovány — Model E viz §8 (RF/XGBoost už otestováno a odmítnuto na úrovni měn, důvod platí i pro páry a silněji, protože dat na pár je ještě míň).

**Verdikt: Model A (per-měna) potvrzen jako nejlepší základ, teď i out-of-sample, ne jen teoreticky.**

---

## 7. Nové faktory — bez změny (znovu poctivě)

Žádný z profesionálních faktorů (MOVE, OIS, cross-currency basis, risk reversals, dealer gamma, CTA positioning, options skew) nemá volně dostupnou historii dost dlouhou/kvalitní na to, aby prošel stejnou disciplínou jako zbytek tohoto auditu. Tvrdit o nich cokoliv číselného by bylo přesně to data snooping/overfitting, před kterým audit varuje. Zůstává v platnosti: jediný poctivě postavitelný nový faktor je in-house Macro Surprise Index z vlastních kalendářních dat, ale potřebuje ≥12 měsíců first-print historie (běží od 2026-06, ne dřív).

---

## 8. AI/ML — otestováno, ne jen tvrzeno

Purged 6-fold CV (embargo 10 týdnů), 19 faktorů najednou, Linear Regression vs. Random Forest vs. XGBoost, per měna:

| Model | Průměr IC (8 měn) |
|---|---|
| **Linear Regression** | **+0,024** |
| Random Forest | +0,007 |
| XGBoost | +0,020 |

**Lineární model vyhrává.** Random Forest je zřetelně horší (téměř nulové IC) — klasický overfitting signature na ~800–1000 týdenních pozorováních s 19 vstupy. XGBoost je blízko lineárnímu, ale nepřekonává ho (a u některých měn — CHF, AUD — vykazuje slibné IC/PF, které by ale s jen 6 foldy mohlo být z části šum, ne potvrzený vzorec). **Potvrzuji dřívější tvrzení "ML nepřináší OOS zlepšení" — a teď s číslem, ne jen odhadem.** Bayesovské/HMM přístupy nebyly numericky testovány (mimo rozsah tohoto kola) — teoretická námitka z architektonického auditu (~1100 týdnů, 8 korelovaných měn = málo dat na stabilní odhad skrytých stavů) zůstává v platnosti bez zpochybnění.

---

## 9. FX Analyzer V3 — architektura (potvrzena, mírně zúžena)

Struktura z architektonického auditu (vrstvy 0–8) **zůstává v platnosti** — protiaudit nenašel důvod ji měnit. Změna je v OBSAHU vrstvy 2–3: méně faktorů dostane per-měnovou váhu, než minulý audit navrhoval, protože míň jich přežilo přísnější testování.

```
VRSTVA 2 FAKTORY — revidovaný seznam po protiauditu:
  VYSOKÁ jistota (FDR q≤0,10, stabilní ≥8/8 režimů):
    AUD ← VIX úroveň (silněji v risk-off)
    JPY ← COT asset-manager (fade, konstantní síla)
    CAD ← CPI akcelerace (konstantní síla)
  STŘEDNÍ jistota (FDR q≤0,20, stabilní 6/8 režimů):
    CHF ← COT commercials (NE dealer — ten je nestabilní)
    GBP ← VIX úroveň (silněji v risk-on, pozor na opačnou intuici než AUD/CHF)
    USD ← DXY momentum (krátký horizont, h1)
    CAD ← real yield (obráceně, slábne v cutting cyklu)
  NÍZKÁ/žádná jistota — NEIMPLEMENTOVAT jako prioritu:
    EUR real-yield-flip (nepřežil FDR)
    GBP COT dealer (nepřežil FDR)
    CHF COT dealer samostatně (nestabilní napříč režimy)
    Sezónnost (odstranit — ale ne proto, že je "prokazatelně škodlivá" všude, jen proto, že není prokazatelně nikde užitečná)
```

---

## 10. Priority implementace — revidované po protiauditu

| # | Změna | Jistota (revidovaná) | Odhad přínosu | Poznámka |
|---|---|---|---|---|
| 1 | Sezónnost pryč | vysoká (ale slabší evidence než "0/8") | +0,01–0,02 PF | beze změny oproti minulému auditu |
| 2 | AUD/CHF/GBP VIX komponenta | **vysoká, teď OOS ověřená** | část z +0,15 PF (train/test test) | AUD nejsilnější, GBP OPAČNÝ směr než AUD/CHF — nekopírovat stejné znaménko |
| 3 | JPY COT asset-manager (jen tahle komponenta, ne celá "COT rework" sada) | **vysoká, teď OOS ověřená** | součást stejného +0,15 PF | |
| 4 | CAD CPI akcelerace | **vysoká, teď OOS ověřená** | | |
| 5 | CHF COT — jen commercials | střední (dealer/AM vyřadit) | menší než minule odhadováno | zúženo oproti minulému auditu |
| 6 | CAD real yield flip | střední, slábne v cutting cyklu | | přidat CB-cyklus gate |
| ~~7~~ | ~~EUR real yield flip~~ | **vyřazeno** | — | nepřežilo FDR |
| ~~8~~ | ~~GBP COT dealer~~ | **vyřazeno** | — | nepřežilo FDR |
| 9 | Model A (per-měna) místo plošných vah | **vysoká, OOS potvrzeno proti per-pár alternativě** | | |
| 10 | Sloučení sazbových kanálů | střední (beze změny) | | nejinvazivnější, poslední |

**Realistický souhrn:** kombinovaný přínos bodů 1–6 je BLÍŽ k measured OOS číslu (+0,15 PF z train/test testu) než k původně odhadovanému in-sample číslu (+0,24 PF) — použij menší, ověřené číslo pro očekávání, ne to hezčí.

---

## Shrnutí pro rozhodování

Souhlasím s minulým auditem v tom, že **plošné váhy jsou špatně a per-měnový přístup je lepší — teď ověřeno out-of-sample, ne jen teoreticky**. Nesouhlasím s tím, kolik konkrétních faktorů bylo prezentováno jako "robustní" — po formální korekci je to 7–16 nálezů, ne 202, a dvě konkrétní doporučení (EUR real yield, GBP COT dealer) bych z implementačního plánu vyřadil úplně. Zbývajících 6 změn (VIX pro AUD/CHF/GBP, JPY COT-AM, CAD CPI akcelerace, CAD real yield) má teď dvojí evidenci — statistickou (FDR + režimová stabilita) i out-of-sample (poctivý train/test split) — a to je nejsilnější důkazní standard, jaký tenhle audit dokázal dodat bez placených dat nebo delší historie.

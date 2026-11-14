# ENTRY_MODEL_DISCOVERY — hledání entry modelů pro Reverzál

**Stav: dokončeno první kolo (2026-11-14). Výzkum, žádná změna produkce.** Navazuje na `REVERSAL_EDGE_RESEARCH.md` (data, metodika, validace rekonstrukce signálů 96 %).

## Odpověď na hlavní otázku

> *Jaký opakující se cenový model nejčastěji předchází ziskovému Reverzálu a jak přesně vypadá jeho průběh od prvního náznaku až po potvrzení vstupu?*

**Na dostupných datech (28 párů, H4, 2024-12 až 2026-11, 1 197 signálů) jsem takový model nenašel.** Algoritmicky jsem testoval 26 typů struktur před, při a po signálu (okna 8/12/24 svíček před, 1–12 po),
algoritmické zóny H4/D1/W1, PDH/PDL, cenovou sílu měn, COT a n-gramové sekvence struktur. Z asi 360 hypotéz **nepřežila korekci na vícenásobné testy žádná** a nominálně nejlepší se v nezávislém testu nepotvrdily.

Co je opakovaně vidět, ale nerozlišuje výhry od ztrát: Reverzálu předchází (v posledních 12 H4) kompresní/úzká svíčka NR7 (91 %), sweep (68 %), pin bar (67 %), engulfing (51 %); po signálu se do 12 svíček objeví sweep (60 %), pin bar (68 %),
engulfing (62 %), FVG (42 %), CHOCH (38 %), medián dosažení struktury 4–7 svíček (16–28 h). U výher i ztrát jsou časté stejně; rozdíly po signálu (např. CHOCH 53 % vs. 24 %) jsou
důsledek příznivého pohybu, ne jeho příčina.

Typický průběh bez ohledu na výsledek (všechny signály): +1 ATR dosáhne 65,7 % signálů za medián 4 svíček (16 h), maximální pohyb ve směru za medián 7 svíček (28 h), před impulsem pullback o medián 0,95 ATR;
průměrný MFE 1,87 a MAE 1,76 ATR za 48 h.

## Rozlišení: co je k dispozici při signálu a co vzniká až po něm

- **Dostupné v okamžiku signálu (00:00 UTC):** struktury před signálem, zóny, PDH/PDL, síla měn, COT. Testovány jako vlastnosti signálu. **Žádná nevykázala použitelný rozdíl** (kap. 6 výzkumu).
- **Vznikají až po signálu:** CHOCH, BOS, displacement, FVG a retest, engulfing/pin po signálu atd. Z nich jsem postavil entry modely, vstup až po potvrzení svíčkou, takže bez look-aheadu.

## Testované entry modely (všechny dostupné až po signálu)

Společné parametry: vstup na otevření svíčky po potvrzující svíčce; stop = extrém pohybu od 2 svíček před signálem po potvrzení ∓ 0,1 ATR (riziko musí být 0,3–2,5 ATR);
cíl 1,5 R; max. 24 svíček (4 dny); náklady 0,05 ATR; časový rámec H4; potvrzení = uzavření svíčky, která podmínku splní. Okno hledání potvrzení: 12 svíček od vstupu.
**Nulová kontrola:** stejný pár, směr a vzdálenost stopu, ale náhodná doba vstupu. Vývoj = signály do 2026-03-31, test = od 2026-04-01.

| Model | Pořadí událostí |
|---|---|
| M0 (kontrola) | Vstup hned při signálu, stop 1,5 ATR |
| M1 | Reverzál → první CHOCH ve směru signálu |
| M2 | Reverzál → první BOS ve směru signálu |
| M3 | Reverzál → první sweep ve směru signálu |
| M4 | Reverzál → displacement |
| M5 | Sweep (od −3 do +8 svíček) → CHOCH do 6 svíček |
| M6 | CHOCH → retest FVG do 8 svíček |
| M7 | Displacement → FVG (do 2 sv.) → retest FVG (do 10 sv.) |
| M8 | Engulfing nebo pin bar po signálu |
| M9 | BOS + displacement současně (do 2 sv.) |

### Entry modely po signálu

| model | část | n | win rate | očekávané R | 95% CI R | náhodný vstup R | edge vs. náhoda | p | MFE (ATR) | MAE (ATR) | průměrná doba (sv.) | vstup za (sv. po signálu) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| M0 hned při signálu (kontrola, stop 1,5 ATR) | vývoj | 785 | 43.2 % | 0.00 | -0.11 až +0.12 | -0.05 | 0.05 | 0.398 | 1.60 | 1.37 | 9.3 | 0.0 |
| M0 hned při signálu (kontrola, stop 1,5 ATR) | test | 404 | 42.3 % | 0.00 | -0.17 až +0.18 | -0.07 | 0.07 | 0.442 | 1.61 | 1.37 | 9.6 | 0.0 |
| M1 CHOCH po signálu | vývoj | 134 | 50.7 % | 0.08 | -0.10 až +0.25 | -0.08 | 0.15 | 0.078 | 1.94 | 1.59 | 15.5 | 6.1 |
| M1 CHOCH po signálu | test | 67 | 47.8 % | 0.06 | -0.22 až +0.33 | -0.06 | 0.12 | 0.394 | 1.81 | 1.55 | 16.1 | 6.3 |
| M2 BOS po signálu | vývoj | 15 | 33.3 % | -0.29 | -0.75 až +0.23 | 0.00 | -0.29 | 0.244 | 1.65 | 2.10 | 13.1 | 7.8 |
| M2 BOS po signálu | test | 13 | 61.5 % | 0.02 | -0.55 až +0.53 | 0.03 | -0.01 | 0.984 | 1.81 | 1.44 | 16.4 | 6.7 |
| M3 SWEEP po signálu | vývoj | 437 | 41.0 % | -0.06 | -0.17 až +0.05 | -0.14 | 0.08 | 0.133 | 1.18 | 1.05 | 5.6 | 4.4 |
| M3 SWEEP po signálu | test | 196 | 40.3 % | -0.06 | -0.25 až +0.14 | -0.12 | 0.06 | 0.554 | 1.27 | 1.17 | 6.5 | 4.7 |
| M4 DISPLACEMENT po signálu | vývoj | 33 | 57.6 % | 0.30 | -0.10 až +0.65 | -0.09 | 0.38 | 0.048 | 2.28 | 1.57 | 14.7 | 5.0 |
| M4 DISPLACEMENT po signálu | test | 18 | 38.9 % | -0.00 | -0.58 až +0.55 | -0.02 | 0.02 | 0.955 | 2.44 | 1.98 | 14.6 | 5.4 |
| M5 SWEEP → CHOCH (do 6 sv.) | vývoj | 46 | 56.5 % | 0.17 | -0.15 až +0.49 | -0.02 | 0.19 | 0.222 | 2.26 | 1.60 | 15.5 | 6.4 |
| M5 SWEEP → CHOCH (do 6 sv.) | test | 26 | 42.3 % | -0.01 | -0.42 až +0.39 | 0.04 | -0.05 | 0.830 | 1.76 | 1.72 | 15.0 | 5.3 |
| M6 CHOCH → retest FVG (do 8 sv.) | vývoj | 34 | 52.9 % | 0.19 | -0.23 až +0.57 | 0.05 | 0.13 | 0.556 | 2.34 | 1.47 | 14.9 | 8.6 |
| M6 CHOCH → retest FVG (do 8 sv.) | test | 15 | 33.3 % | -0.23 | -0.70 až +0.23 | -0.03 | -0.20 | 0.389 | 1.20 | 2.07 | 14.7 | 8.3 |
| M7 DISPLACEMENT → FVG → retest | vývoj | 11 | 72.7 % | 0.90 | +0.36 až +1.35 | 0.02 | 0.88 | 0.003 | 2.81 | 1.16 | 17.1 | 6.9 |
| M8 ENGULF nebo PIN po signálu | vývoj | 603 | 43.4 % | 0.00 | -0.10 až +0.11 | -0.10 | 0.10 | 0.066 | 1.36 | 1.17 | 7.2 | 4.0 |
| M8 ENGULF nebo PIN po signálu | test | 305 | 42.3 % | -0.04 | -0.19 až +0.12 | -0.11 | 0.07 | 0.405 | 1.33 | 1.29 | 8.1 | 3.9 |



Čtení:
- **Žádný model nemá v nezávislém testu očekávání významně nad nulou a nad náhodným vstupem.** Kontrolní M0 je prakticky 0 R (+0,005 vývoj, +0,001 test), tedy bez nákladů rovnováha.
- **M1 (CHOCH):** +0,08 R (vývoj, n = 134) a +0,06 R (test, n = 67), oba intervaly zahrnují nulu; oproti náhodnému vstupu +0,15 a +0,12 R (p = 0,08 / 0,39). Shodné znaménko v obou obdobích je jediné povzbudivé; není to ale nález.
- **M7 (displacement → FVG → retest):** ve vývoji +0,90 R (n = 11, p = 0,003), v testu jen 5 případů, nelze vyhodnotit. Jde o hypotézu k ověření na více datech, ne o model.
- **M2, M9:** příliš málo případů (n ≤ 15). M3 (sweep): velké n, očekávání mírně záporné (−0,06 R v obou obdobích). M8 (engulfing/pin): velké n, očekávání kolem nuly (+0,005 / −0,04 R).
- M4, M5, M6: ve vývoji kladné (+0,30, +0,17, +0,19 R), v testu kolem nuly nebo záporné; typický příznak přeučení na vývojová data.

## Sekvence struktur

### Sekvence před/při signálu (testováno 159, FDR prošlo 0)

| sekvence | n | win rate | rozdíl vs. základ | p | test: n | test: win rate |
|---|---|---|---|---|---|---|
| NR7 → NR7 → NR7 | 40 | 72.5 % | +21.2 p.b. | 0.005 | 13 | 46.2 % |
| TRIANGLE → ENGULF | 45 | 35.6 % | -15.7 p.b. | 0.013 | 20 | 50.0 % |
| PIN → RANGE_EXPANSION | 30 | 30.0 % | -21.3 p.b. | 0.016 | 39 | 30.8 % |
| ENGULF → SWEEP → NR7 | 31 | 32.3 % | -19.0 p.b. | 0.036 | 11 | 63.6 % |
| SWEEP → SWEEP → FALLING_WEDGE | 34 | 35.3 % | -16.0 p.b. | 0.063 | 14 | 57.1 % |
| STREAK_EXHAUST → FAILED_BREAKOUT | 76 | 61.8 % | +10.6 p.b. | 0.067 | 46 | 61.4 % |
| TRIANGLE → TRIANGLE | 34 | 35.3 % | -16.0 p.b. | 0.068 | 14 | 42.9 % |
| NR7 → FVG_RETEST → NR7 | 30 | 66.7 % | +15.4 p.b. | 0.077 | 11 | 45.5 % |
| NR7 → SWEEP → NR7 | 52 | 63.5 % | +12.2 p.b. | 0.084 | 21 | 47.6 % |
| NR7 → STREAK_EXHAUST → STREAK_EXHAUST | 42 | 64.3 % | +13.0 p.b. | 0.085 | 34 | 38.2 % |

### Sekvence po signálu (testováno 79, FDR prošlo 0)

| sekvence | n | očekávané R | edge vs. náhoda | p | test: n | test: R | test: edge |
|---|---|---|---|---|---|---|---|
| RISING_WEDGE → NR7 | 27 | 0.30 | 0.55 | 0.025 | 23 | 0.13 | 0.01 |
| SWEEP → FVG | 21 | 0.39 | 0.46 | 0.071 | 20 | 0.01 | 0.04 |
| FVG → FVG_RETEST | 50 | 0.33 | 0.33 | 0.091 | 28 | -0.03 | 0.16 |
| NR7 → NR7 | 103 | 0.10 | 0.21 | 0.099 | 41 | -0.29 | -0.26 |
| PIN → NR7 | 72 | 0.03 | 0.23 | 0.104 | 43 | 0.00 | 0.01 |
| NR7 → COMPRESSION | 22 | -0.49 | -0.46 | 0.112 | 15 | 0.02 | 0.06 |
| NR7 → PIN | 170 | 0.01 | 0.14 | 0.113 | 73 | -0.08 | 0.01 |
| FALLING_WEDGE → FALLING_WEDGE | 21 | -0.39 | -0.36 | 0.120 | 19 | -0.06 | 0.09 |
| PIN → SWEEP | 166 | 0.03 | 0.14 | 0.131 | 56 | 0.06 | 0.21 |
| RISING_WEDGE → SWEEP | 31 | 0.33 | 0.32 | 0.139 | 18 | 0.04 | 0.17 |

Žádná sekvence neprošla FDR. Nominálně nejsilnější (`NR7 → NR7 → NR7` 72,5 % ve vývoji, ale 46 % v testu; `RISING_WEDGE → NR7` +0,55 R ve vývoji, +0,01 R v testu) nereplikují.

## Grafická dokumentace

`research/reversal/charts/`: `modelM1_*` a `modelM7_*` (po 5 historických příkladech, **nevalidované modely**, zobrazují předchozí strukturu, Reverzál, místo potvrzení a následný vývoj),
`late_*` (10 případů s pohybem až po pozdějším potvrzení), `best_*` a `worst_*`. Zóny jsou algoritmické (H4 plné, D1 čárkovaně, W1 tlustě).

## Co z toho plyne pro obchodování (jen informace, žádná změna pravidel)

- Reverzál sám ani žádná z testovaných struktur nedává statisticky prokázaný edge při vstupu. Zbývá slabá tendence k návratu (+0,2 ATR za 48 h) a model M1 s kladným, ale nevýznamným očekáváním.
- Subjektivní Supply/Demand zóny jsem netestoval (jsou nereprodukovatelné); algoritmická definice zón neměla vliv. Pokud je tvoje zóna kvalitnější, ověří to jedině záznam v deníku (štítek u obchodu).
- Důležité hypotézy k dalšímu testování jsou v kap. 11 `REVERSAL_EDGE_RESEARCH.md`.

## Reprodukce

Skripty v `research/reversal/` (`c_build_dataset.py`, `e_models.py`, `f_sequences.py`, `f_charts.py`, `h_tables.py`), data `data/research/ohlc/`. Kroky v kap. 12 výzkumné zprávy.

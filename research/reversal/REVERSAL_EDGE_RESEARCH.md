# REVERSAL_EDGE_RESEARCH — výzkum Reverzál signálu (RP+ER)

**Stav: DOKONČENO (první kolo, 2026-11-14).** Výzkum nemění produkční kód, databázi, algoritmus Reverzálu ani Trading Journal.
Hlavní závěr: **na dostupných datech (28 párů, ~2 roky H4) se nepodařilo najít žádný cenový vzorec, zónu, faktor ani sekvenci, která by statisticky prokazatelně odlišovala ziskové Reverzály od ztrátových, a žádný entry model nepřežil nezávislý test.** Neznamená to, že žádný edge neexistuje; znamená to, že tento objem dat ho nedokáže ukázat (viz kap. 9).

## 1. Současný algoritmus Reverzálu (audit)

Implementace: `index.html` → `getRPERSignal(p,sb,sq)` (ř. ~1750), vstupy `getRangePosition`, `getEfficiencyRatio` (`engine.js` ř. ~3322–3360),
varianty pro zlato (`getGoldRangePosition/EfficiencyRatio`) a US100. Server: `scripts/bias-alerts.js` (cron každých 15 min) posílá Telegram.

Podmínky (denní uzavřené ceny, okno 10 dní):
- **RP (Range Position)** = (poslední close − min10) / (max10 − min10), kde se bere 10 posledních UZAVŘENÝCH denních hodnot
  (`_dropUnclosedToday` zahazuje dnešní nedokončený den). **ER (Efficiency Ratio, Kaufman)** = |close_t − close_{t−10}| / Σ|Δclose|.
- **SHORT:** RP ≥ 0,80 a ER > 0,50. **LONG:** RP ≤ 0,20 a 0,20 ≤ ER < 0,65. (Prahy pocházejí z backtestu 2024-05 → 2026-07, 28 párů.)
- Epizoda trvá, dokud RP neopustí zónu, ve které vznikla. Fundamentální filtr byl 2026-10-02 zrušen (měření ukázalo, že kvalitu zhoršoval).
- COT kontext (`cotContext`) je jen informační tag, signál nefiltruje.
- Čas vzniku: signál se mění při denním rolloveru (nový uzavřený den), proto Telegram chodí kolem 00:00 UTC
  (v zimě 01:00, v létě 02:00 pražského času). Soubor `data/bias_alert_state.json` nese `since` a `onsetPrice` (živá cena při prvním běhu).

Jak je „zisk/ztráta“ definována původně (`scripts/backtest-rper*.js`): epizoda je **CORRECT**, když cena mezi vznikem a koncem signálu
(RP opustil zónu) zhodnotí ve směru signálu o víc než 0,05 %, **WRONG** při pohybu proti, jinak **CHOP**. Výsledek se tedy zná až v den, kdy signál
skončí. Při vstupu nejde poznat (délka 1 den: 419 správných/2 špatné; 8+ dní: 3 správné/124 špatné) a při tradovatelném vstupu (pevný TP/SL)
backtest vychází PF 0,93. **Pro výzkum proto platí: úspěšnost „win rate 72 %“ nepoužívat jako cíl, hodnotit ceny po vstupu (MFE/MAE v ATR).**

## 2. Data: co existuje, od kdy, co chybí

| Potřeba | Stav | Rozsah | Poznámka |
|---|---|---|---|
| Logované reálné signály | **částečně** | `data/bias_alert_state.json`, historie v gitu od 2026-10-07 (1 624 změn stavu) | Telegram zprávy samotné nejsou k dispozici. Hlubší historii lze dostat `git fetch --shallow-since` |
| Denní close FX | ano | `data/fx_daily/*.json` od 2003 (29 symbolů), Supabase `fx_price_daily` | **jen close**, bez high/low; popisky dní se liší od bar-času (ověřeno, že u Yahoo je datum posunuté), proto pro výzkum bere se vlastní UTC agregace |
| H4 / H1 OHLC | **NE (neukládalo se; od 2026-11-14 sebráno)** | Yahoo 60m max ~730 dní, 15m max ~60 dní | Skripty `backtest-rper-*.js` ho stahují za běhu a zahazují. Sebráno `scripts/research-fetch-ohlc.js` + `.github/workflows/research-ohlc.yml` → `data/research/ohlc/` (28 FX párů, 2024-11-15 → 2026-11-13; **zlato Yahoo pro XAUUSD=X nevrátilo, vyřazeno**) |
| D1/W1 OHLC | ano po sběru | D1 z H1 (730 dní), W1 odvozené | Starší než 730 dní jen close |
| Supply/Demand zóny (H4/D1/W1) | **NE, v projektu vůbec nejsou** | — | Zóny se budou rekonstruovat algoritmicky point-in-time (definice níže). Je to náhrada, ne zaznamenaná historie ani subjektivní zóny |
| Currency Strength (skóre měn) | částečně | `data/engine_hist.json` denní od 2026-07-11 (115 dní); Supabase `score_snapshots` od 2026-07-28 (1 427), `fundamental_scores` od 2026-07-21 | Žádná H4 historie síly. Pro 2 roky bude použita **cenová síla měn** (index z 28 párů), jasně označená jako náhrada |
| COT Leveraged / Asset Mgr | ano | `data/cot_hist.json` týdně od 2024-07; Supabase `cot_reports` od 2022-09 | Point-in-time: data jsou k dispozici až od pátku 19:30 UTC po úterním reportu |
| Retail sentiment | omezeně | `data/retail_hist.json` od 2026-09-30 (15 min), Supabase `retail_sentiment_intraday` 2026-06-22 → 2026-10-10 | Zhruba 4,5 měsíce, mezera nepokrytá. Starší historie neexistuje |
| Fundamenty (kalendář) | rekonstruovatelné | `data/calendar_hist.json` od 2025-01 | Jde přehrát enginem (`scripts/backtest-replay.js`), nejde o zaznamenaný stav |
| Sezónnost | ano | z `fx_daily` od 2003 | |
| Stav Analyzeru v čase (snapshot) | ano, nově | Supabase `analyzer_state_history` od 2026-11 (každých 5–15 min) | Příliš krátké pro statistiku, hodí se jako validace |

Důsledek: **plná analýza (zóny, struktury, síla měn, MFE/MAE na H4) je možná na posledních ~730 dnech, analýza s COT/retail/fundamenty/skóre
jen na kratších obdobích** (retail ~4,5 měsíce, skóre Analyzeru ~4 měsíce). Co není k dispozici, se neodhaduje.

## 3. Metodika

Vše je reprodukovatelné skripty v `research/reversal/` (kroky v kap. 12). Hlavní rozhodnutí:

- **Signály** rekonstruovány přesně podle `getRPERSignal` (RP/ER 10, stejné prahy) z D1 (UTC den) složeného z H1 Yahoo. **Validace:** z 70 reálně
  logovaných signálů (git historie `bias_alert_state.json`, 14. 10. – 13. 11. 2026) se podařilo najít **67 (96 %)** se shodným párem, směrem a vznikem ±1 den;
  rekonstruováno 72, z toho 5 bez záznamu v logu. Celkem **1 202 signálů** (2024-12-17 → 2026-11-13), 1 197 s kompletním 48h výsledkem.
- **Cíl (výsledek):** *win* = cena dosáhne +1,0 ATR(14, H4) ve směru signálu dřív než −1,0 ATR do 48 h (12 H4). Při zásahu obou v jedné svíčce platí ztráta.
  Dále MFE/MAE na 4, 8, 12, 24, 48 h (v ATR), výsledek na konci horizontu, čas do maxima, čas do +1 ATR, pullback před impulsem. Původní štítek CORRECT/WRONG se
  zachoval jen pro srovnání (kap. 5), protože se určuje až při zániku signálu.
- **Vstup:** otevření první H4 svíčky od 00:00 UTC (okamžik rolloveru, kdy chodí Telegram).
- **Struktury** (26 typů, detektory v `features.py`): engulfing, pin/rejection, displacement, range expansion, NR7, komprese, vyčerpání série, wick cluster, FVG, FVG retest,
  sweep, BOS, CHOCH, equal highs/lows, double/triple top/bottom, H&S a inverzní, rising/falling wedge, trojúhelník, breakout a failed breakout. Každá struktura má
  `conf` = svíčka, jejímž uzavřením je podmínka splněna; dříve se nepoužije. Ve vlastnostech jsou jen struktury **ve směru signálu**; protisměr je kontrola.
  Časová okna: před 8/12/24 H4, při signálu (poslední uzavřená svíčka), po signálu (1–4, 5–8, 9–12 svíček).
- **Zóny** (H4, D1, W1): algoritmické Supply/Demand (potvrzený swing + impulz ≥ 1,5 ATR, zrušeny uzavřením skrz). **Nejde o subjektivní zóny obchodníka.**
  Dále PDH/PDL, sweep PDH/PDL, vzdálenost od 20denního extrému, vzdálenost od zón v ATR.
- **Síla měn:** cenová (průměr směrových výnosů z 28 párů) za 24 h a 5 dní: úroveň, rozdíl, sklon po 4/8/12/24 h, obrat, extrém, divergence. **Není to skóre Analyzeru** (to existuje jen ~4 měsíce).
- **COT** (Leveraged Funds, percentil proti vlastní historii, point-in-time od soboty po reportu); **retail, skóre Analyzeru a fundamenty nebyly testovány**, historie je příliš krátká (kap. 2).
- **Statistika:** chronologicky **vývoj** (signály do 2026-03-31, n = 785) a **nezávislý test** (od 2026-04-01, n = 412). Hypotézy se vybírají jen na vývoji; nejistota = bootstrap po clusterech
  (den vzniku, protože signály na korelovaných párech vznikají společně); vícenásobné testy = Benjamini–Hochberg FDR (q = 0,10); min. 30 pozorování ve skupině i mimo ni.
  Entry modely: vstup na otevření svíčky po potvrzení, stop za extrémem pohybu − 0,1 ATR, cíl 1,5 R, držet max. 24 svíček, náklady 0,05 ATR, srovnání s **náhodnou dobou vstupu** (stejný pár, směr a vzdálenost stopu).

## 4. Výsledky: signál sám proti náhodě

| Měřítko | Signál | Náhodný vstup | Rozdíl [95% CI po clusterech] |
|---|---|---|---|
| Win (+1 ATR před −1 ATR, 48 h), vše | 49,4 % | 46,7 % | +2,6 p.b. [−1,2; +6,3] |
| Výsledek po 48 h (ATR), vše | +0,195 | −0,014 | +0,209 [+0,008; +0,412] |
| – vývoj | +0,223 | −0,013 | +0,236 [−0,025; +0,485] |
| – test | +0,142 | −0,015 | +0,157 [−0,138; +0,442] |
| MFE do 48 h (ATR) | 1,87 | 1,72 | +0,15 [+0,02; +0,29] |
| MAE do 48 h (ATR) | 1,76 | 1,80 | −0,04 [−0,17; +0,11] |
| SHORT / LONG výsledek po 48 h | +0,216 / +0,185 | −0,081 / +0,017 | +0,30 / +0,17 |

Čtení: po Reverzálu je tendence k mírnému návratu (asi +0,2 ATR za 48 h; ATR H4 u EURUSD ≈ 25 pipů, takže ≈ 5 pipů), v celém vzorku těsně statisticky odlišná od nuly,
ve vývoji i v testu stejným směrem, ale **ani v jednom z nich samostatně významná**, a velikost je řádově jako spread a swap. Win rate +1 ATR před −1 ATR se od náhody neliší.
Základní win rate navíc kolísá mezi obdobími (vývoj 51,2 %, test 45,9 %).
Čas do pohybu (všechny signály): +1 ATR dosáhne 65,7 % signálů, medián za 4 svíčky (16 h); medián času maximálního MFE 7 svíček (28 h); medián pullbacku před impulsem 0,95 ATR.
Průměrný MFE 1,87 a MAE 1,76 ATR: cena se po signálu pohybuje na obě strany prakticky stejně.

## 5. Původní „zisk/ztráta“ a tradovatelný výsledek

| Původní štítek | n | Tradovatelný win (48 h) | Výsledek 48 h (ATR) | Průměrná doba signálu (dny) |
|---|---|---|---|---|
| CORRECT | 737 | 67,2 % | +1,28 | 1,7 |
| WRONG | 368 | 17,9 % | −1,86 | 3,7 |
| CHOP | 87 | 32,2 % | −0,25 | 2,2 |

Štítek je dán budoucností (signál, který skončí rychle v dobrém směru, je CORRECT), takže přímo ukazuje, co se stalo, ne co z něj lze předem obchodovat. Kontrolní běh univariátních
testů s tímto štítkem (CORRECT vs. WRONG, n = 1 106) dopadl stejně: 108 hypotéz, **0 prošlo FDR** (`OUTCOME=legacy python3 d_stats.py`).

## 6. Výsledky podle faktorů (výhry vs. ztráty)

Pozn.: tabulky ukazují, kolik signálů má faktor, win rate s ním, rozdíl proti signálům bez něj, MFE/MAE, medián výsledku po 48 h a chování v testu.
„Výhry“ a „ztráty“ jsou podle primárního cíle (+1/−1 ATR do 48 h).

### Univariátní tabulka (vývoj, seřazeno podle p; plná tabulka v `out/univariate.csv`)

Vývoj: n = 785, základní win rate 51.2 %; test: n = 412, základ 45.9 %. Testováno hypotéz: 110, prošlo FDR (q = 0,10): **0**.

| faktor | n | výhry | ztráty | win rate | 95% CI | rozdíl vs. nepřítomno | p (clustery) | FDR | MFE12 | MAE12 | medián výsl. 48 h (ATR) | test: n | test: win rate |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pre12_BREAKOUT | 51 | 17 | 34 | 33.3 % | 22–47 % | -19.1 p.b. | 0.010 | ne | 1.71 | 2.92 | -0.11 | 29 | 31.0 % |
| opp_pre12_EQUAL_LOWS | 44 | 30 | 14 | 68.2 % | 53–80 % | +18.0 p.b. | 0.012 | ne | 2.12 | 1.35 | 0.01 | 20 | 45.0 % |
| opp_pre12_FAILED_BREAKOUT | 55 | 19 | 36 | 34.5 % | 23–48 % | -17.9 p.b. | 0.014 | ne | 1.59 | 2.78 | -0.21 | 24 | 33.3 % |
| at_STREAK_EXHAUST | 63 | 41 | 22 | 65.1 % | 53–76 % | +15.1 p.b. | 0.015 | ne | 2.19 | 1.53 | 0.78 | 25 | 32.0 % |
| pre12_ENGULF | 395 | 188 | 207 | 47.6 % | 43–53 % | -7.3 p.b. | 0.036 | ne | 1.69 | 1.88 | 0.04 | 221 | 44.3 % |
| at_SWEEP | 112 | 47 | 65 | 42.0 % | 33–51 % | -10.8 p.b. | 0.044 | ne | 1.64 | 2.13 | -0.15 | 49 | 44.9 % |
| rp_extreme(<=0.05|>=0.95) | 568 | 305 | 263 | 53.7 % | 50–58 % | +9.0 p.b. | 0.051 | ne | 1.96 | 1.80 | 0.28 | 312 | 43.6 % |
| opp_pre12_DOUBLE_TOP | 33 | 22 | 11 | 66.7 % | 50–80 % | +16.1 p.b. | 0.052 | ne | 1.97 | 1.51 | 0.56 | 21 | 28.6 % |
| dir_LONG | 539 | 261 | 278 | 48.4 % | 44–53 % | -8.9 p.b. | 0.055 | ne | 1.85 | 1.87 | 0.24 | 276 | 45.7 % |
| pre24_RISING_WEDGE | 202 | 117 | 85 | 57.9 % | 51–65 % | +9.0 p.b. | 0.060 | ne | 2.03 | 1.62 | 0.21 | 114 | 49.1 % |
| strength_slope_24h>0 | 238 | 110 | 128 | 46.2 % | 40–53 % | -7.2 p.b. | 0.098 | ne | 1.89 | 1.84 | 0.05 | 114 | 57.0 % |
| pre8_FVG | 110 | 65 | 45 | 59.1 % | 50–68 % | +9.2 p.b. | 0.102 | ne | 2.11 | 1.48 | 0.70 | 58 | 41.4 % |
| er_ge_0.65 | 61 | 38 | 23 | 62.3 % | 50–73 % | +12.0 p.b. | 0.108 | ne | 1.96 | 1.51 | 0.43 | 34 | 55.9 % |
| pre12_FALLING_WEDGE | 216 | 100 | 116 | 46.3 % | 40–53 % | -6.8 p.b. | 0.112 | ne | 1.93 | 1.99 | 0.37 | 114 | 51.8 % |
| at_ENGULF | 34 | 13 | 21 | 38.2 % | 24–55 % | -13.6 p.b. | 0.126 | ne | 1.71 | 1.85 | -0.04 | 17 | 52.9 % |
| pre8_FVG_RETEST | 132 | 76 | 56 | 57.6 % | 49–66 % | +7.7 p.b. | 0.127 | ne | 1.97 | 1.50 | 0.53 | 74 | 39.2 % |
| strength_slope_4h>0 | 324 | 154 | 170 | 47.5 % | 42–53 % | -6.3 p.b. | 0.133 | ne | 1.77 | 1.79 | 0.24 | 204 | 46.6 % |
| opp_pre12_BOS | 253 | 140 | 113 | 55.3 % | 49–61 % | +6.1 p.b. | 0.161 | ne | 2.07 | 1.64 | 0.34 | 126 | 53.2 % |
| at_FAILED_BREAKOUT | 36 | 14 | 22 | 38.9 % | 25–55 % | -12.9 p.b. | 0.164 | ne | 1.63 | 2.25 | 0.11 | — | — |
| zone_h4_near(<=1ATR) | 493 | 262 | 231 | 53.1 % | 49–58 % | +5.2 p.b. | 0.176 | ne | 1.88 | 1.79 | 0.24 | 285 | 44.2 % |
| cot_both_weak | 69 | 30 | 39 | 43.5 % | 32–55 % | -8.5 p.b. | 0.181 | ne | 1.83 | 2.05 | 0.19 | 118 | 36.4 % |
| pre24_PIN | 655 | 328 | 327 | 50.1 % | 46–54 % | -6.8 p.b. | 0.186 | ne | 1.88 | 1.86 | 0.21 | 345 | 45.5 % |
| pre8_ENGULF | 251 | 120 | 131 | 47.8 % | 42–54 % | -5.0 p.b. | 0.188 | ne | 1.74 | 1.83 | -0.06 | 149 | 47.0 % |
| pre8_NR7 | 633 | 331 | 302 | 52.3 % | 48–56 % | +5.6 p.b. | 0.217 | ne | 1.95 | 1.79 | 0.21 | 327 | 46.5 % |
| pre24_BREAKOUT | 157 | 73 | 84 | 46.5 % | 39–54 % | -5.9 p.b. | 0.221 | ne | 1.97 | 2.08 | 0.22 | 63 | 42.9 % |

### Zóny

| faktor | n | výhry | ztráty | win rate | 95% CI | rozdíl vs. nepřítomno | p (clustery) | FDR | MFE12 | MAE12 | medián výsl. 48 h (ATR) | test: n | test: win rate |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| zone_h4_near(<=1ATR) | 493 | 262 | 231 | 53.1 % | 49–58 % | +5.2 p.b. | 0.176 | ne | 1.88 | 1.79 | 0.24 | 285 | 44.2 % |
| oppzone_h4_blocks(<=1ATR) | 106 | 51 | 55 | 48.1 % | 39–58 % | -3.6 p.b. | 0.520 | ne | 1.81 | 1.72 | 0.08 | 62 | 58.1 % |
| any_zone_in | 461 | 232 | 229 | 50.3 % | 46–55 % | -2.1 p.b. | 0.570 | ne | 1.83 | 1.82 | 0.19 | 284 | 45.4 % |
| zone_h4_in(<=0.25ATR) | 334 | 175 | 159 | 52.4 % | 47–58 % | +2.1 p.b. | 0.578 | ne | 1.89 | 1.87 | 0.14 | 197 | 45.7 % |
| zone_d1_near(<=1ATR) | 295 | 147 | 148 | 49.8 % | 44–56 % | -2.2 p.b. | 0.579 | ne | 1.73 | 1.84 | 0.06 | 218 | 45.0 % |
| zone_w1_near(<=1ATR) | 104 | 51 | 53 | 49.0 % | 40–59 % | -2.5 p.b. | 0.667 | ne | 1.74 | 1.81 | 0.11 | 83 | 41.0 % |
| zone_w1_in(<=0.25ATR) | 79 | 39 | 40 | 49.4 % | 39–60 % | -2.0 p.b. | 0.745 | ne | 1.74 | 1.80 | 0.12 | 63 | 47.6 % |
| zone_d1_in(<=0.25ATR) | 238 | 123 | 115 | 51.7 % | 45–58 % | +0.7 p.b. | 0.883 | ne | 1.81 | 1.81 | 0.07 | 180 | 43.9 % |
| d1_or_w1_zone_in | 279 | 142 | 137 | 50.9 % | 45–57 % | -0.5 p.b. | 0.888 | ne | 1.82 | 1.78 | 0.21 | 196 | 43.9 % |

### Úrovně

| faktor | n | výhry | ztráty | win rate | 95% CI | rozdíl vs. nepřítomno | p (clustery) | FDR | MFE12 | MAE12 | medián výsl. 48 h (ATR) | test: n | test: win rate |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| at_PDL_PDH(<=0.5ATR) | 341 | 179 | 162 | 52.5 % | 47–58 % | +2.3 p.b. | 0.582 | ne | 1.82 | 1.73 | 0.14 | 139 | 40.3 % |
| at_20d_extreme(<=0.5ATR) | 125 | 67 | 58 | 53.6 % | 45–62 % | +2.8 p.b. | 0.586 | ne | 2.14 | 1.81 | 0.43 | 62 | 38.7 % |

### Síla měn

| faktor | n | výhry | ztráty | win rate | 95% CI | rozdíl vs. nepřítomno | p (clustery) | FDR | MFE12 | MAE12 | medián výsl. 48 h (ATR) | test: n | test: win rate |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| strength_slope_24h>0 | 238 | 110 | 128 | 46.2 % | 40–53 % | -7.2 p.b. | 0.098 | ne | 1.89 | 1.84 | 0.05 | 114 | 57.0 % |
| strength_slope_4h>0 | 324 | 154 | 170 | 47.5 % | 42–53 % | -6.3 p.b. | 0.133 | ne | 1.77 | 1.79 | 0.24 | 204 | 46.6 % |
| strength_s6_with_signal | 87 | 39 | 48 | 44.8 % | 35–55 % | -7.2 p.b. | 0.231 | ne | 1.65 | 1.83 | -0.19 | 48 | 52.1 % |
| strength_slope_12h>0 | 279 | 136 | 143 | 48.7 % | 43–55 % | -3.8 p.b. | 0.395 | ne | 1.84 | 1.80 | 0.06 | 160 | 50.0 % |
| strength_s30_with_signal | 40 | 18 | 22 | 45.0 % | 31–60 % | -6.5 p.b. | 0.449 | ne | 1.90 | 1.92 | 0.20 | 17 | 58.8 % |
| strength_divergence_s6<0&s30>0 | 33 | 15 | 18 | 45.5 % | 30–62 % | -6.0 p.b. | 0.485 | ne | 1.88 | 2.05 | 0.00 | — | — |
| strength_slope_8h>0 | 325 | 162 | 163 | 49.8 % | 44–55 % | -2.3 p.b. | 0.559 | ne | 1.87 | 1.77 | 0.14 | 176 | 48.9 % |
| strength_turning_12h | 213 | 107 | 106 | 50.2 % | 44–57 % | -1.3 p.b. | 0.755 | ne | 1.95 | 1.75 | 0.17 | 126 | 49.2 % |
| strength_s30_extreme(>=0.8) | 212 | 108 | 104 | 50.9 % | 44–58 % | -0.4 p.b. | 0.957 | ne | 1.95 | 1.90 | 0.33 | 121 | 38.8 % |

### COT

| faktor | n | výhry | ztráty | win rate | 95% CI | rozdíl vs. nepřítomno | p (clustery) | FDR | MFE12 | MAE12 | medián výsl. 48 h (ATR) | test: n | test: win rate |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cot_both_weak | 69 | 30 | 39 | 43.5 % | 32–55 % | -8.5 p.b. | 0.181 | ne | 1.83 | 2.05 | 0.19 | 118 | 36.4 % |
| cot_diverg_agree | 90 | 51 | 39 | 56.7 % | 46–66 % | +6.2 p.b. | 0.322 | ne | 2.01 | 1.56 | 0.08 | 60 | 50.0 % |
| cot_diverg_contra | 79 | 42 | 37 | 53.2 % | 42–64 % | +2.2 p.b. | 0.765 | ne | 1.83 | 1.89 | -0.00 | 61 | 55.7 % |
| cot_mixed | 373 | 190 | 183 | 50.9 % | 46–56 % | -0.5 p.b. | 0.876 | ne | 1.92 | 1.82 | 0.39 | 156 | 46.2 % |
| cot_both_strong | 108 | 56 | 52 | 51.9 % | 43–61 % | +0.7 p.b. | 0.878 | ne | 1.76 | 1.68 | 0.11 | 17 | 58.8 % |

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

Shrnutí:
- Z **110** testovaných hypotéz (struktury před/při signálu, zóny, PDH/PDL, síla měn, COT, směr, ER) **nepřežila FDR žádná** (q = 0,10). Nejnižší p = 0,010. U 110 nezávislých
  testů se při p < 0,05 náhodou očekává ~5 „nálezů“, nominálně jich je 6 (p ≤ 0,044) a žádný se v testu nepotvrdil: např. `pre12_BREAKOUT` (−19 p.b. ve vývoji, −16 p.b. v testu, p = 0,047) je jediný, který v testu nominálně drží, ale po korekci na počet testů nemá oporu.
- **Zóny** (H4, D1, W1, tedy i kombinace „v zóně“): rozdíl proti signálům mimo zónu od −4 do +5 p.b., všude p > 0,17 (11 variant zón a úrovní PDL/PDH, 20denní extrém).
- **Síla měn:** obrat, sklon, extrém ani divergence nerozlišují (p > 0,09). **COT:** žádná kombinace (divergence souhlas/kontra, obě silné/slabé) nerozlišuje.
- Struktury **po signálu** (kap. 7) se u výher vyskytují častěji (např. CHOCH 53 % vs. 24 %), ale to je kruhový důkaz: příznivý pohyb sám vytvoří býčí/medvědí strukturu.

## 7. Struktury a jejich časování po signálu (popis, ne predikce)

Podíl signálů, u nichž se daná struktura (ve směru signálu) objevila v prvních 1–4, 5–8 a 9–12 H4 svíčkách po vstupu, a podíl u výher/ztrát:

| Struktura | do 12 sv. | 1–4 | 5–8 | 9–12 | u výher | u ztrát | medián sv. |
|---|---|---|---|---|---|---|---|
| Sweep | 60 % | 36 | 14 | 10 | 48 | 71 | 4 |
| CHOCH | 38 % | 12 | 14 | 13 | 53 | 24 | 7 |
| FVG | 42 % | 14 | 17 | 11 | 54 | 31 | 5 |
| FVG retest | 30 % | 5 | 13 | 12 | 42 | 19 | 7 |
| Engulfing | 62 % | 33 | 17 | 13 | 66 | 59 | 4 |
| Pin bar | 68 % | 30 | 24 | 13 | 65 | 69 | 5 |
| Displacement | 14 % | 6 | 3 | 5 | 19 | 9 | 5 |
| BOS | 8 % | 1 | 2 | 4 | 13 | 2 | 9 |
| Failed breakout | 36 % | 19 | 11 | 7 | 25 | 47 | 4 |
| Double top/bottom | 1–2 % | | | | | | |

Před signálem (posledních 24 H4): NR7 100 %, sweep 90 %, pin 84 %, engulfing 80 %, failed breakout 59 %. V posledních 12 H4: NR7 91 %, sweep 68 %, pin 67 %, engulfing 51 %. Podíl je
u výher a ztrát shodný (tyto struktury jsou na H4 prostě časté a nic nerozlišují).

## 8. Sekvence a entry modely

Podrobně v `ENTRY_MODEL_DISCOVERY.md`. Stručně: z 159 sekvencí před/při signálu a 79 po signálu **nepřežila FDR žádná** a nominální nejlepší se v testu nepotvrdily;
z 10 entry modelů **žádný neprokázal kladné očekávání v nezávislém testu**.

## 9. Statistická spolehlivost a síla testu

- **Vzorek:** 1 197 signálů, po sloučení do clusterů (dny vzniku) výrazně méně nezávislých událostí; ve vývoji 785, v testu 412. Signály ze stejného dne a z korelovaných párů se resamplují společně.
- **Síla:** u skupiny ~50 signálů je směrodatná chyba rozdílu win rate ≈ 7 p.b., takže **spolehlivě odlišitelný je jen efekt kolem 15–20 p.b. a víc**. Menší skutečné efekty (5–10 p.b.) tento objem dat nedokáže ukázat ani vyvrátit.
- **Vícenásobné testy:** celkem asi 360 hypotéz (110 + 108 kontrolních + 159 + 79 + 10 modelů); korekce BH; nálezy s p ≈ 0,003–0,01 jsou při tolika testech v rozsahu očekávané náhody.
- **Režim trhu:** základní win rate se mezi vývojem a testem liší o 5 p.b.; dva roky jsou prakticky jeden tržní režim.
- **Korelace není příčina:** i kdyby nějaký faktor vyšel významně, ukazuje jen souběh v historii.

## 10. Omezení

- H4/D1 jsou UTC-zarovnané z Yahoo H1 (ne broker); žádné ticky, spready, swapy. Zlato a US100 nejsou v H4 datech.
- Zóny a struktury jsou algoritmické definice; subjektivní Supply/Demand obchodníka nejsou reprodukovatelné a mohou se chovat jinak.
- Cenová síla měn není skóre Analyzeru. Retail, skóre Analyzeru a fundamenty nebyly testovány (krátká historie), COT jen jako čtyřstavový tag.
- Dva roky dat. Starší výzkum na jiném zdroji cen (ECB/Frankfurter) vycházel opačně pro vstup hned po signálu (viz poznámka níže); výsledek je tedy citlivý na zdroj dat.
- Detektory mají volné parametry (např. k = 2/3 u swingů, 1,5 ATR u zón); jiná volba by dala jiné počty. Parametry byly zvoleny předem a neladěny na výsledek.

Poznámka ke zdroji dat: dřívější backtest na ECB/Frankfurter datech ukazoval po 10 dnech od signálu +0,16 %; přepočet na Yahoo denních cenách, které appka používá i naživo, dává −0,16 % za 3 dny při vstupu hned po alertu
(`scripts/backtest-rper-entry-rules.py`), zatímco H4 data ukazují +0,2 ATR po 48 h oproti náhodě. Výsledky se mezi zdroji a horizonty liší znaménkem, což samo svědčí o tom, že žádný stabilní edge se nepodařilo prokázat.

## 11. Doporučení: co stojí za další testování (žádná změna produkce)

1. **Menší tendence k návratu po 48 h (+0,2 ATR, silnější u SHORT):** ověřit na delší historii a na jednom konzistentním zdroji cen (nejdřív vyřešit rozpor Yahoo × ECB). Bez nákladů to nestačí; musí se po spreadu a swapu ověřit na reálných vstupech.
2. **CHOCH po signálu (model M1):** v obou obdobích kladné očekávání (+0,08 R vývoj, +0,06 R test) a stále lepší než náhodný vstup (+0,15 / +0,12 R), ale statisticky nevýznamné. Potřebuje víc dat (jiné nástroje, delší historie).
3. **Sekvence displacement → FVG → retest (M7):** ve vývoji +0,90 R (n = 11), v testu jen 5 případů. Je to jediný nominálně silný nález a **zatím je to jen hypotéza**.
4. **Sbírat vlastní historii:** H4 OHLC každý týden, stav Analyzeru (už se ukládá do `analyzer_state_history`), retail a COT. Po ~6–12 měsících znovu otestovat faktory, které dnes nemají dost dat (retail, skóre Analyzeru, fundamenty).
5. **Deník MT5:** ukládá u každého obchodu stav Reverzálu, takže za pár měsíců jde skutečný výsledek tvých vstupů porovnat s tímto výzkumem.

## 12. Reprodukce

1. Spustit workflow `research-ohlc` (GitHub Actions) → `data/research/ohlc/`.
2. `pip install numpy pandas scipy matplotlib`.
3. V `research/reversal/`: `python3 b_validate_reconstruction.py` (validace signálů), `c_build_dataset.py` (dataset `out/signals.csv`), `d_stats.py` (+ `OUTCOME=legacy python3 d_stats.py`),
   `e_models.py`, `f_sequences.py`, `g_baseline.py`, `f_charts.py`, `h_tables.py`. Náhodné generátory mají pevný seed.
4. Logované signály: `python3 scripts/backtest-rper-alerts-month.py` (vyžaduje hlubší git clone: `git fetch --shallow-since=2026-10-01 origin main`).

## 13. Grafy

Složka `research/reversal/charts/` (40 grafů, generované skriptem `f_charts.py`): `best_*` (10 nejlepších signálů podle výsledku po 48 h), `worst_*` (10 nejhorších), `late_*` (10 případů s pohybem až po pozdějším potvrzení,
CHOCH po signálu), `modelM1_*` a `modelM7_*` (po 5 příkladech modelů; **nevalidované**). Každý graf: H4 svíčky, svislá čára = vznik Reverzálu, algoritmické zóny H4 (plné), D1 (čárkovaně) a W1 (tlustě) platné v tu chvíli,
svislá tečkovaná čára = vstup po potvrzení a dole cenová síla měn ve směru signálu (24 h).
Společné i rozdílné rysy: nejlepší případy jsou z velké části JPY kříže ze dne 2.–3. 10. 2025 (AUDJPY, EURJPY, CHFJPY, GBPJPY, CADJPY), tedy **jeden společný tržní pohyb, ne mnoho nezávislých pozorování**.
Nejhorší případy jsou převážně LONG signály z 3.–4. 4. 2025 na AUD, NZD, CAD a CHF křížích: opět jeden společný pohyb (cena po signálu dál klesala). Mezi nejlepšími a nejhoršími jsem před signálem nenašel společný strukturální rozdíl, v obou skupinách jsou podobně časté sweepy, pin bary i engulfing.

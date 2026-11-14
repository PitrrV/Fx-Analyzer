# REVERSAL_EDGE_RESEARCH — výzkum Reverzál signálu (RP+ER)

**Stav: ROZPRACOVÁNO. Hotové jsou kapitoly 1 (algoritmus), 2 (data a jejich dostupnost) a 3 (plán testování).
Výsledky (kapitoly 4–9) zatím neexistují.** Výzkum nemění produkční kód, databázi, algoritmus Reverzálu ani Trading Journal.
Datum auditu: 2026-11-14.

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
| H4 / H1 OHLC | **NE (neukládá se nikde)** | Yahoo 60m max ~730 dní, 15m max ~60 dní | Skripty `backtest-rper-*.js` ho stahují za běhu a zahazují. Sběr připraven: `scripts/research-fetch-ohlc.js` + `.github/workflows/research-ohlc.yml` (sandbox na Yahoo nemá přístup, běží na GitHub Actions) |
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

## 3. Metodika (plán)

**Etapa A – sběr dat.** Spustit `research-ohlc` (H1 → H4 UTC-zarovnané a D1), uložit do `data/research/ohlc/`. Žádné doplňování chybějících barů.

**Etapa B – rekonstrukce signálů + validace.** Stejné RP(10)/ER(10) a prahy nad D1 closes (UTC den) pro 28 FX + zlato. Ověřit proti
reálně logovaným signálům z gitu (shoda vzniku/zániku) a změřit rozdíl; teprve potom brát rekonstruované epizody za základ. Epizody ze stejného dne
a korelovaných párů se spojují do **clusterů** (pro nezávislost).

**Etapa C – vlastnosti v okamžiku signálu (jen to, co je v ten moment známé).** Pro každý signál bar (poslední uzavřená H4 před vznikem):
- zóny: algoritmický Supply/Demand (swing pivoty + impulzivní odchod ≥ k·ATR z báze ≤ n svíček, platí do uzavření skrz) na H4, D1, W1;
  vzdálenost v ATR, dotyk/průraz, PDH/PDL, předchozí swing, equal highs/lows, sweep;
- cenová síla měn: index z 28 párů, úroveň, rozdíl, sklon a zrychlení, divergence, extrém;
- COT, retail, sezónnost, skóre (jen v období, kde existují).

**Etapa D – struktury před, při a po signálu.** Algoritmické detektory (definice s přesným časem potvrzení = uzavření svíčky, která podmínku splní):
double/triple top/bottom, H&S, liquidity sweep, equal highs/lows, BOS/CHOCH, engulfing, pin bar, FVG a retest, displacement, breakout/failed breakout,
wedge, triangle/kompresi, range expansion, failed auction. Okna: před 8/12/24 H4, při signálu, po 1/2/4/6/8/12 H4. Pattern se před potvrzením nepočítá.

**Etapa E – výsledky po signálu.** MFE, MAE, čas do max. pohybu, hloubka prvního pullbacku, čas do impulsu na 4/8/12/24/48 h,
normalizované ATR(14, H4). Primární cíl „výhra“: dosažení +1,0 ATR před −1,0 ATR do 48 h; sekundární spojité MFE−MAE.

**Etapa F – statistika.** Chronologické dělení: vývoj = první ~60 % času, nezávislý test = zbytek, nikdy se nemíchá. Min. 30 pozorování na buňku.
Nejistota: bootstrap po clusterech/týdnech, intervaly spolehlivosti. Vícenásobné testy: počet hypotéz se zapisuje předem, korekce Benjamini–Hochberg (FDR).
Sekvence: n-gramy událostí v pořadí vzniku, srovnání četnosti u ziskových a ztrátových. Entry modely: jen na vývojové části, jednou ověřit na testovací.
Rozlišit modely dostupné při signálu a po signálu.

**Etapa G – grafy.** Minimálně 5 historických příkladů na významný model + 10 nejlepších, 10 ztrátových a 10 s pozdním potvrzením, generovaně z dat.

**Etapa H – závěr.** Doplnit kapitoly 4–9 a `ENTRY_MODEL_DISCOVERY.md`.

## 10. Omezení (zatím)
- H4/D1 zarovnání je UTC, ne broker (17:00 NY); bez ticků a spreadů.
- Jen ~2 roky H4; značná část faktorů má kratší historii. Počty signálů se budou po clusterování výrazně snižovat.
- Zóny a struktury jsou algoritmické definice, ne subjektivní graf trading. Mohou se lišit od toho, co vidí obchodník.
- Currency strength z ceny není skóre Analyzeru.

## 11. Doporučení
Zatím žádná. Doplní se po etapě H.

# Snímek Analyzeru k 09:00 (Europe/Prague) zpětně — zjištění a nástroj

Jen výzkum/diagnostika. Nic v produkci ani v datech se nemění.

## Jak se to dělá (git time-travel)
`replay0900.js <YYYY-MM-DD>` vezme všechny vstupy (`data/*.json`) i `engine.js` z **posledního commitu s časem ≤ 09:00 Praha**
(letní/zimní čas řeší `Intl`, 25. 10. = 08:00Z, 29. 3. = 07:00Z) a spustí **stejný skript, který počítá produkční snímek**
(`scripts/snapshot-analyzer-state.js`; pro přesnou reprodukci záznamu engine_hist `--producer=engine_hist`) se **zmrazeným časem**
(Date shim = cutoff), takže engine nemůže vidět „teď" ani pozdější vstup.
Výstup: `state` (měny, páry), `extras` (COT s datem zveřejnění, kalendář před cutoffem, trh, páry se ★/výhledem/RP/ER), `audit` (důkaz bez look-aheadu).

## Co je skutečný záznam a co přepočet
| Co | Skutečný záznam od | Poznámka |
|---|---|---|
| Skóre měn + složky (server) | **2026-07-11** (`data/engine_hist.json`, každá verze v git = stav v tu hodinu) | Počítá server (cron); záznam dne se přepisuje, takže verze commitu ≤ 09:00 = stav z cca 08:00 Praha |
| Totéž + páry, ★, COT %, retail, VIX, RP/ER signály | **2026-11-13** (`analyzer_state_history`, Supabase, 5–15 min; i git `data/analyzer_state.json`) | |
| Skóre/výhled % **tak, jak je ukázal tvůj prohlížeč** | **2026-07-02** (`app_state.engine_log`, `forecast_log` v cloudu) | Jen poslední zápis dne; do 18. 10. závisely na lokální historii zařízení (viz níže) |
| Směr páru (28 + XAUUSD) | **2026-09-18** (`bias_alert_state.json` → `biasState`) | |
| RP/ER signály (aktivní + od kdy) | **2026-09-18** (`bias_alert_state.json` → `rpEr`) | číselné RP/ER se nikde neukládaly → přepočet z `prices.json` |
| Všechno ostatní | přepočet | od **2026-06-22** plně z git vstupů; dál do minulosti (až ~2024-07-26) „dnešním enginem" z oříznutých historií |

## Vstupy a odkdy jsou k dispozici (ověřeno z git/Supabase)
- COT: týdny od 2024-07-23 (`cot_hist`), Supabase `cot_reports` od 2022-09-20. **Datum zveřejnění** = pátek 15:30 New York (pravidlo CFTC); empiricky první commit, kde se týden objevil (jen od 2026-06-27): v ukázce zveřejněno pá 16. 10. 19:30Z, v repu až so 17. 10. 16:32Z.
- Kalendář: živé snímky `calendar.json` (první otisk) od 2026-06-19; `calendar_hist.json` (backfill, **finální/revidované** actual) od 2024-03-04.
- Retail sentiment: od 2026-06-22. VIX: `vix.json` od 2026-08-02 (dřív nikde v repu). Ropa: `oil.json` od 2026-06-29. Ceny: `prices.json` od 2026-06-26; `fx_daily`/Supabase `fx_price_daily` od roku 2000.
- **DXY se nikam neukládá** (ani repo, ani Supabase) — jen přibližně dopočítat z párů.
- XAUUSD: `gold_cot/gold_retail/gold_price` od 2026-09-15; US100 retail od 2026-08-11.

## Validace
1. **Server záznam (engine_hist)**: 12 náhodných dnů (07–11/2026), přehrání přesně v čase záznamu producerem platným v tu dobu → **12/12 dnů shoda 8/8 měn** (skóre + všechny složky + COT %). (`PRODUCER=engine_hist python3 validate.py 7 12`)
   Bez `--producer=engine_hist` (dnešní producer) je shoda 6/12 — rozdíl dělají známé opravy producerů (VIX od 24. 9., kalendářní okno od 20. 8.), ne chyba času/vstupů.
2. **Záznam prohlížeče (engine_log)**: od 2026-10-22 `max|Δ| ≤ 0.11` (typicky AUD +0.1 = ruční CB sazba v prohlížeči, GBP +0.04). **Před 2026-10-19 rozdíly 0.35–1.85** — prohlížeč do #288 (19. 10.) skóroval z lokální historie zařízení, kterou git nezná. (`python3 compare_browser_log.py`)
3. Výhled %: směr 28/28 shodný s `forecast_log` prohlížeče, pravděpodobnost ±1–2 b. (`p` v logu = P(pár nahoru)).
4. **Leak test**: stejný den s úmyslným posunem +24 h → skóre se mění až o 1,4 a `audit.lookahead_free=false` (retail bod z druhého dne, 15 událostí s actual po cutoffu).

## Limity
Hodnoty z doby před zapnutím sběru (VIX/ropa/retail) v přepočtu chybí → složky risk/oil/sent jsou 0. Starší dny používají dnešní `engine.js`
(CB sazby se k dobovým hodnotám dostanou až po ~12 týdnech z kalendářních událostí). Kalendář před 2026-06-19 má revidované hodnoty (ne první otisk).
`beat_miss` je směr, který počítá engine; bez forecastu nelze určit.

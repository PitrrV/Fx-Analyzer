# ÚKOL 1 — Výzkum Reverzálu + označování zón přes Cowork (stav pro navázání)

Když uživatel řekne **„vrátíme se k Úkolu 1“**, přečti tento soubor, shrň uživateli stav a otevřené body a naváž na ně. Poslední aktualizace: 2026-11-15.

Pokyn uživatele: čistě výzkum, **neměnit produkční kód, Reverzál, Journal ani obchodní pravidla**. Výstupy: `REVERSAL_EDGE_RESEARCH.md` a `ENTRY_MODEL_DISCOVERY.md` (obojí v této složce).

**Hotovo (první kolo, 2026-11-14):** audit, sběr H4/D1 OHLC (workflow `research-ohlc`, `data/research/ohlc/`, 28 FX párů, zlato chybí), rekonstrukce signálů
(shoda s logovanými 96 %), 26 detektorů struktur, algoritmické zóny H4/D1/W1, cenová síla měn, COT, univariátní testy (vývoj/test, FDR), 10 entry modelů + sekvence s nulovou kontrolou, 40 grafů, závěrečné dokumenty.
**Hlavní závěr:** žádný faktor, struktura, zóna, sekvence ani entry model neprošel korekcí na vícenásobné testy a nezávislým testem. Jen slabá tendence k návratu (+0,2 ATR za 48 h, nevýznamná v testu) a model M1 (CHOCH po signálu, +0,06–0,08 R, nevýznamný).

**Otevřené / další krok (jen se souhlasem uživatele):** víc dat (delší historie, zlato, US100), retail a skóre Analyzeru až budou mít 6–12 měsíců historie, rozpor Yahoo × ECB u vstupu po signálu, ověření M1 a M7 na nových datech.
Reprodukce: kap. 12 v `REVERSAL_EDGE_RESEARCH.md`. Starší měření: `scripts/backtest-rper-alerts-month.py`, `scripts/backtest-rper-entry-rules.py`.
Potřebné balíčky: numpy pandas scipy matplotlib.

## Cowork: označování subjektivních Supply/Demand zón (rozpracováno)
- Zadání a data: `research/reversal/cowork/` (`COWORK_ZONE_LABELING.md`, `signals_to_label.csv` 320 řádků bez výsledků, `labels_template.csv`). Soukromý klíč s výsledky: `research/reversal/out/cowork_key.csv` (Coworku nedávat).
- Vyhodnocení připraveno: `research/reversal/i_analyze_cowork_labels.py` (předem zapsané hypotézy H1–H6, bootstrap po clusterech, BH FDR, stabilita, shoda opakování a s algoritmickými zónami). Spouští se až po dodání `labels_filled.csv`.
- **Pilot (20 řádků) dodán a zkontrolován** (`cowork/labels_pilot_20.csv`): formát i geometrie zón v pořádku, ale **H4 zóny a liquidity sweep jsou u všech řádků `n/a`** (Bar Replay na 4H není v plánu TradingView), `at_key_level = Y` u 15/20 (skoro konstanta), `minutes_spent` skoro vždy 3. Výsledky signálů se u pilotu záměrně nepoužily (slepost).
- **Čeká se na rozhodnutí uživatele:** A) pokračovat jen s W1 a D1 (H5 odpadá), nebo B) nejdřív zajistit Bar Replay na 4H. Případně zpřísnit `at_key_level` (jen úroveň s ≥ 3 dotyky) v zadání.
- Pak: Cowork označí zbylých 300 řádků po dávkách po 20, uživatel pošle `labels_filled.csv`, spustit `python3 research/reversal/i_analyze_cowork_labels.py cowork/labels_filled.csv` a zapsat výsledek do `REVERSAL_EDGE_RESEARCH.md`.

## Připomenutí hlavního výsledku
Žádný faktor, struktura, algoritmická zóna, sekvence ani entry model neprošel korekcí na vícenásobné testy a nezávislým testem (viz `REVERSAL_EDGE_RESEARCH.md`, `ENTRY_MODEL_DISCOVERY.md`). Subjektivní zóny zatím netestovány, proto Cowork. Výzkum nemění produkční kód.

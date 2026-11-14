# Výzkum Reverzálu — stav úkolu (pro navázání)

Pokyn uživatele: čistě výzkum, **neměnit produkční kód, Reverzál, Journal ani obchodní pravidla**. Výstupy: `REVERSAL_EDGE_RESEARCH.md` a `ENTRY_MODEL_DISCOVERY.md` (obojí v této složce).

**Hotovo (první kolo, 2026-11-14):** audit, sběr H4/D1 OHLC (workflow `research-ohlc`, `data/research/ohlc/`, 28 FX párů, zlato chybí), rekonstrukce signálů
(shoda s logovanými 96 %), 26 detektorů struktur, algoritmické zóny H4/D1/W1, cenová síla měn, COT, univariátní testy (vývoj/test, FDR), 10 entry modelů + sekvence s nulovou kontrolou, 40 grafů, závěrečné dokumenty.
**Hlavní závěr:** žádný faktor, struktura, zóna, sekvence ani entry model neprošel korekcí na vícenásobné testy a nezávislým testem. Jen slabá tendence k návratu (+0,2 ATR za 48 h, nevýznamná v testu) a model M1 (CHOCH po signálu, +0,06–0,08 R, nevýznamný).

**Otevřené / další krok (jen se souhlasem uživatele):** víc dat (delší historie, zlato, US100), retail a skóre Analyzeru až budou mít 6–12 měsíců historie, rozpor Yahoo × ECB u vstupu po signálu, ověření M1 a M7 na nových datech.
Reprodukce: kap. 12 v `REVERSAL_EDGE_RESEARCH.md`. Starší měření: `scripts/backtest-rper-alerts-month.py`, `scripts/backtest-rper-entry-rules.py`.
Potřebné balíčky: numpy pandas scipy matplotlib.

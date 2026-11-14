# Výzkum Reverzálu — stav úkolu (pro navázání)

Pokyn uživatele: čistě výzkum, **neměnit produkční kód, Reverzál, Journal ani obchodní pravidla**. Cíl: zjistit, jaké struktury, zóny, síla měn
a faktory provázejí ziskové a ztrátové Reverzály a zda z toho jde odvodit statisticky podložený entry model. Výstupy:
`research/reversal/REVERSAL_EDGE_RESEARCH.md` a `research/reversal/ENTRY_MODEL_DISCOVERY.md`.

Hotovo: audit algoritmu a dat (REVERSAL_EDGE_RESEARCH.md kap. 1–3), skript a workflow na sběr OHLC (`scripts/research-fetch-ohlc.js`,
`.github/workflows/research-ohlc.yml`, dispatch-only), starší měření: `scripts/backtest-rper-alerts-month.py`, `scripts/backtest-rper-entry-rules.py`.
Důležité zjištění: původní „win rate 72 %“ je definovaný až při konci signálu (nejde obchodovat); vstup hned po alertu vychází záporně (−0,16 % za 3 dny, Yahoo data).

Další krok: spustit workflow `research-ohlc` na GitHubu, pak etapy B až H podle plánu v kap. 3.

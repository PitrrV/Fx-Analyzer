# Deník MT5 — stav úkolu (pro navázání v další session)

Když uživatel řekne **„vrátíme se k Deníku MT5“**, přečti tento soubor a `Trading Denik/README.md`, shrň uživateli stav
a otevřené body níže a pokračuj od nich. Poslední aktualizace: 2026-11-13.

## Cíl
Automatický, **jen čtecí** MT5 Trading deník v Analyzeru (složka `Trading Denik/`): obchody z MT5 se zapisují samy, ke každému
obchodu se uloží snapshot toho, co Analyzer ukazoval při vstupu, a AI Coach z toho umí odpovídat. Více účtů (FundingPips, ForTraders).
ForTraders nemá investor heslo, proto je „jen čtení“ zajištěno kódem (allow-list obálka `connector/mt5_readonly.py` + test).

## Hotovo (ve `main`, PR #300)
- Produkční Supabase (projekt `wdcvxfbhauwvwzbatkfh`): tabulky `mt5_*`, `analyzer_state_history`, `mt5_entry_snapshots`, RPC
  `mt5_create_account`, `mt5_rotate_token`, `mt5_equity_series`; RLS podle `user_id`.
- Edge funkce `mt5-ingest` (token per účet, idempotentní) a `analyzer-state-capture` (pg_cron každých 5 min, čte `data/analyzer_state.json` z `main`).
- E0 bezpečnostní oprava (policy `fundamental_*`, dispatch funkce).
- Konektor `connector/` (24 testů), statistiky `journal-stats.js`, UI `mt5-journal-ui.js` (PC `index.html` + mobil `m.html`), kontext AI Coache (`mt5Journal`).
- Integrační test proti produkci s dočasným účtem prošel. Playwright smoke test PC i mobil prošel.

## Otevřené body
1. **Úklid testovacích dat v produkční Supabase (čeká na potvrzení uživatele):** smazat účet `ZZ_TEST_A`
   (id `00000000-0000-0000-0000-00000000a001`, kaskádou smaže i jeho obchody) a řádky `analyzer_state_history`, kde `state->>'test'='true'`.
   Poslední pokus vypršel, protože Supabase čekal na potvrzení. Pak ověřit, že `mt5_*` tabulky mají 0 řádků.
2. **Ověřit `analyzer-state-capture`:** po mergi jsem neověřil, že se do `analyzer_state_history` opravdu ukládají nové stavy
   (job `analyzer-state-capture`, `*/5 * * * *`; zdroj `data/analyzer_state.json` na `main`, plní ho krok v `data-refresh.yml`).
3. **Uživatel:** v Analyzeru založit MT5 účet (token se ukáže jen jednou), nainstalovat konektor podle `connector/README.md`,
   zkusit na demo účtu, nechat vypnuté Algo Trading, ověřit pravidla FundingPips/ForTraders o nástrojích třetích stran.
4. **E6: test na skutečném MT5** (demo, potom ostré účty). Netestováno na skutečném terminálu: tvar dat z `history_deals_get`,
   netting reverzace (INOUT), `terminal_info().trade_allowed`.
5. Zjištěné, ale neřešené: 7 Supabase views `SECURITY DEFINER`; tabulky `fx_price_daily` a `retail_sentiment_intraday` v Supabase
   se neplní (plní je neznámý externí proces, Analyzer je nepoužívá); `classic.html` MT5 sekci nemá.
6. Možné další kroky: připomenutí, že konektor neběží; filtr/export obchodů; zobrazení MT5 obchodů v `classic.html`;
   malý read-only EA pro zachycení změn SL/TP v reálném čase (dnes jen polling).

## Zásady
- Jen čtení, žádné obchodní funkce MT5. Uživatelská data nemazat ani nepřepisovat (smí se jen s výslovným souhlasem).
- Snapshot jen z dat platných při vstupu; nedostupné = `NULL`, nikdy zpětně nedoplňovat.
- Změna `journal-stats.js`/`mt5-journal-ui.js`/`sync.js` = zvýšit `?v=` v HTML souborech. Edge funkce se nasazují ručně do Supabase (zdrojáky v `supabase/functions/`).
- Odpovídat česky, výsledky ověřovat na skutečných datech, na konci stručně říct, co je hotové a co ne.

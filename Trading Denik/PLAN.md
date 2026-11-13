# MT5 Trading Journal — audit a technický plán

Stav: **NÁVRH, nic z toho zatím není implementováno.** Datum auditu 2026-11-13.
Složka `Trading Denik/` v repozitáři dosud neexistovala, tímto souborem vzniká.

## 1. Audit současného stavu

### Architektura
- Statický web na GitHub Pages, bez vlastního backendu a bez build kroku. Tři frontendy
  (`index.html` PC, `m.html` mobil, `classic.html`) sdílejí `engine.js` a `sync.js`; UI se
  mezi nimi duplikuje (viz CLAUDE.md).
- Backend je jen **Supabase** (projekt `wdcvxfbhauwvwzbatkfh`, eu-west-1, Postgres 17):
  Auth (OTP/heslo, 4 uživatelé), tabulka `app_state`, 6 edge funkcí, pg_cron (dispatch
  GitHub Actions každých 15 min). Data pro analýzu generují GitHub Actions do `data/*.json`.

### Současný Trading deník
- Ukládá se v `localStorage['journal']`, pole obchodů zadávaných ručně
  (`pair, dir, entry, sl, tp, riskPct, outcome, rMultiple, notes, openedAt, closedAt, ctx`).
- `ctx` = `captureContext()` (index.html:51): diff, conviction, band, dailyLevel, flip, CBDI,
  CB stage, AI bias, list type. **Neobsahuje COT, retail, sezónnost ani jednotlivé složky skóre.**
- Statistiky (`buildJournal`, `jStat`) jsou v **R jednotkách zadaných ručně**; žádné peníze,
  poplatky, equity účtu, ani drawdown. Win rate nepočítá BE, PF v R.
- Sync: celý deník jde jako JSON pole v jediném řádku `app_state.data` (max dnes 491 kB,
  89 obchodů v deníku), merge podle `updatedAt`, mazání jen tombstonem.
- AI Coach (index.html `buildCoachContext`, ř. ~959): z prohlížeče volá OpenAI/OpenRouter s
  klíčem uloženým v localStorage. Deník vidí jen jako agregát „Ověření edge“ (buckety s n ≥ 3).
- Hromadný import `importTradesJSON` už počítá s `mt_pos_id`, je to jediný dnešní MT5 háček.

### Zdroje historických dat pro snapshot (co existuje a co ne)
| Zdroj | Kde | Použitelné jako point-in-time? |
|---|---|---|
| COT (lev. fondy, asset mgr, long/short/net) | `data/cot_hist.json`, tabulka `cot_reports` (týdně, má `report_date`) | Ano, týdenní, publikace v pátek |
| Retail sentiment | `data/retail_hist.json` (45 dní, ~15 min body) | Ano, jen za posledních ~45 dní |
| Skóre měn a složky | `data/engine_hist.json` (denně), tabulka `score_snapshots` | Jen denní; bez COT/retail rozkladu per hodina |
| Kalendář, sazby, CPI | `data/calendar*.json` | Ano |
| Technické informace | `data/fx_daily/*.json` (denní ceny) | Jen denní |

**Důsledek:** Analyzer dnes neukládá historii „stavu v okamžiku X“ v hodinovém/15min rozlišení.
Snapshot při otevření obchodu proto nejde spolehlivě poskládat zpětně — musí se začít
ukládat stav průběžně (etapa 4). Obchody před zahájením ukládání dostanou `NULL` + příznak
„nedostupné“, nic se nedopočítává.

### Bezpečnostní nálezy (ověřeno v produkční DB)
1. **Reálná chyba (střední až vysoká):** tabulky `fundamental_block_observations`,
   `fundamental_expectations_history`, `fundamental_shadow_snapshots` mají policy
   „service role full access“, ale **určenou roli `public` s `true`** — kdokoli s veřejným
   anon klíčem (je v `sync.js`) je může číst, měnit i mazat. Oprava: policy jen pro `service_role`.
2. Supabase advisor: 7 views `SECURITY DEFINER`; funkce `trigger_*_dispatch()` volatelné rolí
   `anon` přes `/rest/v1/rpc/…` — kdokoli může spamovat GitHub Actions dispatch. Oprava
   `REVOKE EXECUTE … FROM anon, authenticated`.
3. API klíče (OpenAI/OpenRouter/GitHub PAT) jsou v localStorage a synchronizují se do `app_state`.
   Pro nový deník to znamená: **AI Coach dostane vypočtené agregáty, ne syrová data účtů**,
   a čísla účtů/brokera se do LLM neposílají bez opt-in.
4. `ADMIN_EMAIL` je jen kosmetika v klientu. Nové tabulky musí být chráněné RLS přes `user_id`,
   nikdy přes e-mail.
5. Nikde v repu nejsou zdrojáky edge funkcí (žijí jen v Supabase). Nové funkce budou verzované
   ve složce `Trading Denik/`.
6. Je nutné nezvětšovat blob `app_state` obchody z MT5 (race při push celého blobu, limit velikosti).

## 2. Volba MT5 konektoru

| | A) Python + `MetaTrader5` | B) MQL5 EA + WebRequest |
|---|---|---|
| Historie dealů/orderů | `history_deals_get`, `history_orders_get` — snadná plná resynchronizace po výpadku | `HistorySelect` taky, ale kód v MQL5 je pracnější a hůř testovatelný |
| Změny SL/TP v reálném čase | jen **polling** `positions_get` (rozlišení = interval, mezi polly se změna ztratí) | `OnTradeTransaction` zachytí každou změnu hned |
| Více účtů | jeden proces na terminál (`initialize(path=…)`) | jeden EA na každý terminál/graf |
| Read-only záruka | kód nevolá `order_send`; navíc lze použít **investor heslo** (broker to vynutí) | EA technicky může obchodovat, read-only je jen konvencí kódu |
| Hesla | terminál už je přihlášený, konektor heslo nepotřebuje | dtto |
| Testovatelnost | adaptér + falešná data, pytest | těžko bez MT5 |
| Provoz | Windows (balíček je jen pro Windows), proces musí běžet | musí běžet terminál s připojeným grafem |
| Povolení brokera/prop firmy | **nutné ověřit v podmínkách FundingPips/ForTraders** — nic nepředpokládám | stejně |

**Doporučení: varianta A** (Python, read-only, polling + plná resynchronizace historie).
Známé omezení: mezilehlé změny SL/TP při vypnutém konektoru nelze zpětně zjistit — MT5
je v historii neuchovává. Budou zaznamenány jen pozorované změny a to bude v UI označeno.
Volitelná pozdější etapa: malý read-only EA jen pro `OnTradeTransaction` jako doplněk.

Konektor mluví s Supabase přes HTTPS na novou edge funkci `mt5-ingest` (GitHub Pages
nemůže přijímat data, backend = Supabase). Autentizace konektoru: **tokeny per účet**
(náhodných 256 bitů, v DB jen SHA-256 hash, scope jen „ingest tohoto účtu“, lze zrušit),
uložené v souboru mimo repo / v Windows Credential Manageru. Žádné obchodní heslo se nikde nesaví.

## 3. Datový model (nové tabulky, vše s RLS `user_id = auth.uid()`)
- `mt5_accounts` (id, user_id, label, broker, server, login_hash, currency, kind hedging/netting,
  sync_enabled, ingest_token_hash, last_seen_at)
- `mt5_deals` (account_id, deal_ticket, position_id, order_ticket, time_msc, symbol, type, entry,
  volume, price, profit, commission, swap, fee, comment, raw) — **PK (account_id, deal_ticket)**
- `mt5_positions` (account_id, position_id, symbol, side, opened_at, closed_at, volume_in/out,
  open_price, close_price, initial_sl, initial_tp, risk_money, r_multiple, net_profit, status)
- `mt5_position_events` (account_id, event_key, position_id, kind open/modify_sl_tp/partial/close,
  time, payload) — **PK (account_id, event_key)**, idempotentní
- `mt5_orders` (pending orders a jejich stav)
- `mt5_equity_samples` (account_id, ts, balance, equity, margin, floating) — vzorkování + po obchodech
- `mt5_symbol_specs` (tick value/size, contract size, zachyceno při otevření — kvůli R a rizikům)
- `analyzer_state_history` (asof, per měna: skóre a složky, COT lev/AM long/short/net + report_date,
  retail long/short + čas bodu, sezónnost, CB sazby, reverzní signály, zdroj a stáří každého údaje)
- `mt5_entry_snapshots` (account_id, position_id, state_id, state_asof, lag_seconds, flags:
  per pole `available`/`stale`; hodnoty `NULL` když nedostupné)
Deník ručních záznamů (`localStorage['journal']`) zůstává beze změny; UI zobrazí oba zdroje
odděleně označené. **Nic se nemaže ani nepřepisuje.**

## 4. Etapy, testy, kritéria dokončení
Každá etapa = samostatný malý PR do main, žádný hromadný přepis.

**E0 Bezpečnostní opravy (volitelné, doporučeno):** policy `service_role`, REVOKE na dispatch funkce.
Test: anon klíčem nejde psát do `fundamental_*`; cron dál běží. *Potřebuje tvůj souhlas, mění produkční DB.*

**E1 Schéma + ingest + konektor (jádro):** migrace, edge funkce `mt5-ingest`, Python konektor
s adaptérem (reálný MT5 / falešný). Testy (pytest, falešný adaptér): otevření/uzavření, změna SL/TP,
částečné zavření, restart konektoru (kurzor), výpadek spojení (fronta + backfill), duplicitní
události, více účtů (izolace — token účtu A nesmí zapsat do B), hedging vs netting (INOUT, OUT_BY).
*Hotovo když:* test replay stejného vstupu 2× dá identický stav DB, a po vypnutí/zapnutí konektoru
nechybí žádný dealt ticket.

**E2 Statistiky:** čistý modul `Trading Denik/journal-stats.js` (plain JS, testovatelný v Node,
načítaný všemi frontendy): win rate (definice BE explicitně), PF v penězích i R, expectancy, avg R,
max drawdown z equity křivky, průměrná výhra/ztráta, rozpady podle instrumentu/směru/dne/měsíce/
kombinace faktorů; uzavřený vs. otevřený (floating) profit odděleně; vklady/výběry jsou cash-flow,
ne výkon. *Hotovo když:* ruční výpočty na fixture datech sedí na desetinná místa.

**E3 UI v Trading deníku (PC první, pak mobil):** přepínač účtů + „Souhrn všech“, filtry účet/období,
otevřené/uzavřené, detail s historií změn, equity a balance křivka. Zachová se styl AT TRADING.
*Hotovo když:* smoke test (Playwright) bez chyb v konzoli, ruční deník beze změny.

**E4 Analyzer snapshot:** GitHub Actions (stávající 15min běh) navíc ukládá `analyzer_state_history`;
`mt5-ingest` při otevření pozice přiřadí poslední stav s `asof ≤ čas otevření` a zapíše lag.
Stav starší než limit → `NULL` + příznak. *Hotovo když:* test, že snapshot nikdy nepoužije data
novější než čas vstupu a chybějící údaj zůstane `NULL`.

**E5 AI Coach:** deterministická vrstva dotazů nad `mt5_*` (po účtu/páru/období/faktoru) počítá
čísla v JS; LLM dostane výsledek + `n` + období + upozornění na malý vzorek a rozlišení korelace
od kauzality. Coach nikdy nedostane data jiného účtu, než o který se ptáš. *Hotovo když:* testy
na vzorových dotazech ze zadání vrací správné obchody a počty.

**E6 Integrační test na reálném MT5:** na Windows, nejdřív demo účet, jen čtení; teprve po něm
reálné účty.

## 5. Soubory
Nové: `Trading Denik/{PLAN.md, connector/*.py, connector/tests/*, sql/*.sql,
supabase/functions/mt5-ingest/index.ts, journal-stats.js, tests/*.js, README.md}`,
`.github/workflows/` úprava stávajícího data-refresh (E4), případně `scripts/snapshot-analyzer-state.js`.
Změněné: `index.html`, `m.html` (E3, E5), `sync.js` jen pokud nová data potřebují klíč (nepředpokládám),
cache-bust verze v HTML.
Nesmí se změnit: pair score, váhy, prahy Edge Reversal, dosavadní deník v localStorage.

## 6. Co nelze zajistit / upozornění
- V tomto prostředí není Windows ani MT5. Logiku konektoru ověřím na falešném adaptéru;
  **skutečný test s MT5 musíš spustit ty** (E6).
- Zpětně nelze zjistit stav Analyzeru před zahájením ukládání ani změny SL/TP při vypnutém konektoru.
- FundingPips/ForTraders: žádné předpoklady; je potřeba, abys ověřil, že jejich pravidla povolují
  čtecí API / investor přístup.
- URL se mezerou (`Trading Denik/`) funguje, ale odkazy se musí kódovat (`Trading%20Denik/…`).
  Pokud preferuješ `Trading-Denik`, řekni.

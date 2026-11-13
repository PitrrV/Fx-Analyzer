# Trading Denik — automatický MT5 deník

Vše k automatickému zápisu obchodů z MT5 do Trading deníku Analyzeru.

| Část | Kde | Co dělá |
|---|---|---|
| Konektor (Python, jen čtení) | `connector/` | Čte z MT5 a posílá na HTTPS endpoint. Návod: `connector/README.md` |
| Příjem dat (Supabase edge funkce) | `supabase/functions/mt5-ingest/` | Ověří token účtu, idempotentně uloží dealy, složí pozice, události, equity a snapshot Analyzeru |
| Stav Analyzeru v čase | `supabase/functions/analyzer-state-capture/` + `scripts/snapshot-analyzer-state.js` | Každých 15 min uloží, co Analyzer ukazuje (COT, retail, skóre…), do tabulky `analyzer_state_history` |
| Databáze | `sql/*.sql` | Tabulky `mt5_*`, RLS, RPC pro založení účtu a token (aplikováno do produkční Supabase) |
| Statistiky | `journal-stats.js` | Win rate, PF, expectancy, R, drawdown. Čisté funkce, definice v hlavičce souboru |
| UI + AI Coach kontext | `mt5-journal-ui.js` | Sekce „MT5 deník“ v záložce Trading deník (PC i mobil) a podklady pro AI Coache |
| Demo na falešných datech | `demo.html`, `demo-data.js` | Jen ukázka vzhledu, žádná skutečná data |
| Testy | `tests/`, `connector/tests/` | `node tests/stats.test.js`, `node tests/derive.test.mjs`, `python -m pytest connector/tests` |

Pravidla, která se nesmí porušit:
- MT5 integrace je **jen pro čtení**. Žádný kód nesmí volat obchodní funkce MT5.
- Uživatelská data se nemažou ani nepřepisují. Ruční deník (`localStorage['journal']`) zůstává beze změny.
- Snapshot Analyzeru obsahuje jen data platná při vstupu. Nedostupné údaje jsou `NULL`, nikdy se nedoplňují zpětně.
- Změny souborů `journal-stats.js` a `mt5-journal-ui.js` vyžadují zvýšit `?v=` v `index.html` a `m.html`.
- Změna funkcí v `supabase/functions/` se do Supabase nasazuje ručně (zdrojáky tady jsou jen verzovaná kopie).

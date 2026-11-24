# AT Trading FX Analyzer – Mapa datových zdrojů (Fáze 2)

*Stav k 2026-11-24. Zdroj údajů: kód v repu [KÓD]. Licence viz `AT_TRADING_LICENSE_AUDIT.md`.*

| Zdroj | Co dodává | Jak se získává | Frekvence | Uložení | Limity / poznámky | Cena dnes | Licenční stav |
|---|---|---|---|---|---|---|---|
| **CFTC COT** (TFF `gpe5-46if`, legacy `6dca-aqww`, zip `fut_fin_txt_*`) | pozice COT pro měny, zlato | Socrata API `publicreporting.cftc.gov` ze skriptu `fetch-cot.js`; klient i `engine.js` | týdně (pá), cron denně | `data/cot_hist.json`, `cot_reports` (1744 ř.) | bez klíče; vládní veřejná data | 0 | ORANŽOVÁ (data veřejná, ale formální licenční text nenalezen) |
| **FXSSI** `current-ratio` | retail sentiment (long/short) | scraping HTML/JSON `c.fxssi.com`, `scripts/fetch-retail.js` | */15 min | `data/retail*.json`, `retail_sentiment_intraday` (12,9k ř.) | neoficiální, může se změnit/blokovat | 0 | ČERVENÁ/NEOVĚŘENO |
| **Myfxbook** Community Outlook | retail sentiment | oficiální REST (`login.json`, `get-community-outlook.json`) přes relay edge funkci | */15 min | tytéž tabulky | free 100 požadavků/24 h; přihlášení účtem (secrets `MYFXBOOK_*`) | 0 | ORANŽOVÁ/ČERVENÁ pro komerci |
| **ForexFactory** kalendář | události, forecast, actual | scraping HTML týdenních stránek (`window.calendarComponentStates`), relay `ff-calendar-relay` kvůli IP blokaci | */15 min | `calendar_events` (6060 ř.), `data/calendar*.json` | žádné oficiální API; blokace datacenter IP | 0 | ČERVENÁ |
| **FairEconomy** `nfs.faireconomy.media` | týdenní JSON kalendáře (FF mirror) | přímé stažení `engine.js:1632` | per týden | cache localStorage | neoficiální | 0 | ČERVENÁ/NEOVĚŘENO |
| **Yahoo Finance** `query1` | FX, indexy, komodity (OHLC) | neoficiální chart API ze `scripts/fetch-prices.js`, `fetch-vix.js` | */15 min | `fx_price_daily` (148k ř.), `data/fx_daily` (5,4 MB) | nepodporované, bez záruk | 0 | ČERVENÁ pro komerci |
| **Frankfurter / ECB** | denní referenční kurzy | `api.frankfurter.app` záloha, backtesty | denně | – | ECB data jsou volně použitelná s uvedením zdroje (**NEOVĚŘENO**, nečteno) | 0 | NEOVĚŘENO |
| **open.er-api.com** | záloha kurzů | `fetch-prices.js:52` | dle potřeby | – | free tier, atribuce | 0 | NEOVĚŘENO |
| **Stooq** | ropa, zlato, sezónnost | `fetch-oil.js` aj. | denně | `data/*` | z Actions vrací blokující HTML → de facto nefunkční | 0 | NEOVĚŘENO |
| **FRED** | VIXCLS, DCOILWTICO, makro | `fetch-vix.js`, `fetch-research-data.js` | denně | `data/vix*.json`, `data/research` | část sérií má copyright třetích stran | 0 | ORANŽOVÁ |
| **CBOE** `cdn.cboe.com` | živý VIX (delayed) | `fetch-vix.js:55` | */15 min | `data/vix*` | zpožděné kotace | 0 | NEOVĚŘENO |
| **OANDA** order book | retail pozicování | BYOK token uživatele | na vyžádání | localStorage | vlastní účet uživatele | 0 | ZELENÁ jako BYOK (klíč a data patří uživateli) |
| **Finnhub / FMP / Alpha Vantage** | kalendář, ceny | BYOK klíče uživatele | na vyžádání | localStorage | free tier osobní | 0 | ZELENÁ jako BYOK |
| **OpenRouter / OpenAI / Gemini** | AI Coach, AI radar | BYOK; radar server-side `RADAR_GEMINI_KEY` | dle použití | `data/radar_hist.json` (14 MB) | cena za tokeny | provozovatel platí jen radar | NEOVĚŘENO pro radar |
| **RSS zprávy** (fxstreet, investing, forexlive, marketwatch…) | titulky pro radar | RSS + rss2json | */15 min | `radar_hist.json` | autorská práva k obsahu | 0 | ORANŽOVÁ/ČERVENÁ při ukládání/zobrazení |
| **Telegram** | alerty | Bot API | událostně | – | – | 0 | ZELENÁ |
| **CORS proxy** (allorigins, corsproxy.io, codetabs, thingproxy, r.jina.ai) | průchod pro prohlížeč | klient | – | – | veřejné služby bez SLA | 0 | v produkci nepřijatelné |

## Odvozená data (vlastní výpočty)
Skóre měn a párů, konfluence, conviction, CB-bias, risk režim, point-in-time snímky (`score_snapshots`, `fundamental_scores` 78k ř., `analyzer_state_history`). Jsou **odvozená** z výše uvedených zdrojů – komerčně nejbezpečnější vrstva, ale jen pokud se zobrazují skóre, ne zdrojová surová data (viz licenční audit).

## Sezónnost, síla měn, futures
Sezónnost (`fetch-seasonality-daily.js`) a síla měn se počítají z cenových dat (Yahoo/Stooq) → dědí jejich licenční problém. „Futures“ zdroj v kódu nenalezen kromě COT.

## Hlavní zjištění
1. Pět klíčových vstupů (kalendář FF, FXSSI, Myfxbook, Yahoo, Stooq) je neoficiálních nebo bez komerčního oprávnění.
2. Jediné skutečně bezpečné vstupy: CFTC (po ověření), BYOK klíče uživatelů, vlastní výpočty.
3. Obejití blokace (relay přes Supabase, browser User-Agent) je v kontextu placené služby závažné právní riziko.

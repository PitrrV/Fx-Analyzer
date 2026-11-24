# AT Trading FX Analyzer – Technický audit (Fáze 1)

*Stav k 2026-11-24. Audit je čistě čtecí: žádný kód, data ani DB nebyly změněny.*
Značení důkazů: **[KÓD]** ověřeno v repozitáři, **[DB]** ověřeno dotazem do Supabase (jen čtení), **[WEB]** z webu, **[NEOVĚŘENO]**.

## 1. Co projekt je
Statická aplikace bez backendu a bez buildu: 3 nezávislá UI (`index.html` ~3,5k řádků, `m.html` ~1,9k, `classic.html` ~3,7k) sdílí `engine.js` (~4,5k ř., veškerá scoring logika) a `sync.js` (Supabase sync). React + Babel běží v prohlížeči z CDN. Hosting GitHub Pages (+ zmínka Netlify). `radar.html` je samostatná vanilla-JS aplikace (AI news radar). **[KÓD]**

## 2. Tok dat poskytovatel → UI
```
Poskytovatel ──► GitHub Actions cron (scripts/fetch-*.js) ──► data/*.json (commit [skip ci] do repa)
                                                          └─► (část) Supabase tabulky
Prohlížeč ──► načte data/*.json z GitHub Pages ──► engine.js (scoring v klientu) ──► UI
Prohlížeč ◄─► localStorage ◄─► sync.js ◄─► Supabase app_state (per uživatel, RLS)
```
Spouštění: `data-refresh.yml` každých 15 min, ale **ne** přes GitHub `schedule` (nespolehlivý), nýbrž přes Supabase `pg_cron` → funkce `trigger_fx_analyzer_data_refresh_dispatch()` → GitHub API `workflow_dispatch` s PAT uloženým ve Vaultu. **[DB]** Dále `cot.yml` (denně 13:30 UTC), `fx-daily-history.yml`, `calibration.yml` (so). 27 workflow souborů, 68 skriptů v `scripts/`. **[KÓD]**

## 3. Externí integrace (host → soubory)
| Host | Kde | Role |
|---|---|---|
| publicreporting.cftc.gov, www.cftc.gov | `engine.js:1159,681,1225,1406`, `scripts/fetch-cot.js:101`, `fetch-gold-cot.js` | COT |
| c.fxssi.com / fxssi.com | `scripts/fetch-retail.js:202`, `fetch-us100-retail.js`, | retail sentiment (HTML/JSON scraping) |
| www.myfxbook.com | `scripts/fetch-retail.js` (login.json, get-community-outlook.json), `engine.js:702` | retail sentiment (REST s přihlášením) |
| www.forexfactory.com, nfs.faireconomy.media | `scripts/fetch-calendar.js:35`, `backfill-calendar.js`, `engine.js:1632,1724` | kalendář (scraping HTML) |
| query1.finance.yahoo.com | 17 výskytů, `fetch-prices.js` | ceny FX (primární od 17. 9. 2026) – neoficiální endpoint |
| api.frankfurter.app, open.er-api.com | `fetch-prices.js` | záložní kurzy |
| stooq.com | `fetch-oil.js`, `fetch-gold-price.js`, `fetch-seasonality-daily.js` | z GH Actions vrací blokující HTML |
| fred.stlouisfed.org, cdn.cboe.com | `fetch-vix.js`, `fetch-research-data.js` | VIX, makro |
| finnhub.io, financialmodelingprep.com, alphavantage.co | `engine.js:1514,1538,2579` | volitelné BYOK adaptéry |
| api-fxtrade.oanda.com | `engine.js:528` | volitelný BYOK OANDA order book |
| openrouter.ai, OpenAI, Gemini | Coach (BYOK), `scripts/fetch-radar.js` (`RADAR_GEMINI_KEY`) | AI |
| RSS (fxstreet, investing, forexlive, …), api.rss2json.com | `radar.html` | zprávy |
| allorigins, corsproxy.io, codetabs, thingproxy, r.jina.ai | `engine.js:704-706,1135,1394,1600,1659` | veřejné CORS proxy |
| api.telegram.org | `scripts/bias-alerts.js` | alerty |

## 4. Supabase (projekt `wdcvxfbhauwvwzbatkfh`) **[DB]**
- Postgres 17.6, DB ~85 MB. 8 edge funkcí: `ff-calendar-relay` (relay ForexFactory přes Supabase egress, protože FF/Cloudflare blokuje IP GitHub Actions), `myfxbook-relay`, `fetch-calendar`, `ff-probe-test`, `notify-admin-login`, `trigger-recompute`, `mt5-ingest` (verify_jwt=false, vlastní token), `analyzer-state-capture`.
- pg_cron: 4 joby (fetch-calendar-dispatch */15, data-refresh dispatch */15, analyzer-state-capture */5, jeden neaktivní). Vault: 2 secrets (GitHub PAT).
- Auth: Supabase Auth (heslo + OTP). SMTP Resend ve zkušebním režimu (e-maily jen na admin adresu → nové uživatele je nutné zakládat ručně).
- Tabulky: `app_state` (RLS, `auth.uid()=user_id`), `mt5_*` (RLS), `analyzer_state_history`; **zdrojová data čitelná anonymně** (`cot_reports`, `calendar_events`, `fundamental_scores`, `fx_price_daily` 148k ř., `retail_sentiment_intraday`, `score_snapshots`, `narratives` aj. – SELECT `true` pro anon).
- Advisors: 7× ERROR `security_definer_view`, WARN `pg_net` v public, WARN SECURITY DEFINER RPC `mt5_create_account/mt5_rotate_token` volatelné rolí authenticated, WARN vypnutá ochrana uniklých hesel, 5 tabulek s RLS bez politik.

## 5. Zabezpečení – zjištění
| # | Zjištění | Závažnost pro komerci |
|---|---|---|
| S1 | **Přístupová brána je jen klientská** (`ADMIN_EMAIL`, `FX_EXTRA_ALLOWED_EMAILS`, `fxIsAllowedEmail()`). Kdo ví, jak číst `data/*.json` nebo anon API, obejde ji. Žádné entitlements/role/předplatné v DB. | **BLOKUJÍCÍ** |
| S2 | Veškerá zdrojová a odvozená data jsou přístupná anonymně (Supabase anon SELECT i veřejné `data/*.json`, pokud je repo/Pages veřejné). Platící zákazník nemá nic, co by neměl i neplatící. Zároveň jde o **redistribuci** dat třetích stran (viz licenční audit). | **BLOKUJÍCÍ** |
| S3 | Scoring logika (`engine.js`) je v klientu čitelná – žádná ochrana know-how. | Střední |
| S4 | `sync.js` `KEYS_SCALAR` synchronizuje uživatelské API klíče (`fh, av, fmp, or_key, openai_key, oanda_token`) do `app_state` jako čistý JSON. Zda v DB reálně existují, nebylo zkontrolováno. | Vysoká (GDPR/odpovědnost) |
| S5 | 7 SECURITY DEFINER views obchází RLS. | Vysoká |
| S6 | PAT ve Vaultu pro GitHub dispatch; druhá funkce míří i na repo `PitrrV/Fundamet-app`. Single point of failure: výpadek PAT = zastaví data. | Střední |
| S7 | Neexistuje test suite mimo MT5 modul; 3 UI duplikují logiku (drift). | Střední |
| S8 | Viditelnost repa (veřejné/soukromé) **[NEOVĚŘENO]** – GitHub Pages na free plánu implikuje veřejné. Pokud veřejné, jsou veřejně i `data/*.json` (43 MB) a kód. | Vysoká |
| S9 | Tarif Supabase (free/pro) **[NEOVĚŘENO]**; free projekt se pauzuje a nemá SLA/zálohy. | Střední |

## 6. Provozní zralost
- **Spolehlivost dat**: kritické závislosti jsou scraping (FF, FXSSI) a neoficiální Yahoo endpoint; relay přes Supabase existuje právě proto, že zdroj blokuje IP datacenter. **[KÓD/DB]**
- **Cron**: GitHub Actions jako produkční scheduler = bez SLA; spotřeba minut v privátním repu **[NEOVĚŘENO]** (~96 běhů/den).
- **Velikost repa**: `.git` ~388 MB, `data/` 43 MB (radar_hist 14 MB, research 12 MB) – commity botem každých 15 min nafukují historii.
- **Monitoring/zálohy**: žádný centrální monitoring ani ověřený postup obnovy **[NEOVĚŘENO]**.

## 7. Kvalita signálu (relevantní pro marketing)
Vlastní kalibrace `data/calibration_replay.json` (okno 2024-05-27 → 2026-08-03, split 2025-06-30) ukazuje **profit factor < 1 ve všech pásmech skóre a horizontech** (např. „silný 3+": PF 0,61–0,73, WR 44–46 %; „slabý <2": PF 0,83–0,95). Interní `docs/COUNTER_AUDIT_2026-07.md` odhaduje správnost architektury na ~55–65 % a prokázané faktory přeceněné. Prodej s tvrzením o ziskovosti/predikci by byl rizikový (regulace investičního poradenství/reklamy – **právně neověřeno**). Produkt je vhodné pozicovat jako analytický/vzdělávací přehled, ne signály.

## 8. Co je silné
Funkční datová pipeline s historií (COT, kalendář, ceny, retail), point-in-time snímky, MT5 deník s RLS, Supabase Auth a sync už existují; MT5 modul je testovaný a read-only.

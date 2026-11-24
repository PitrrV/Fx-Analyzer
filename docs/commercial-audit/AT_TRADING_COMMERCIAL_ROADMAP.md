# AT Trading FX Analyzer – Architektura, závěr a 30denní plán (Fáze 6 + 7)

## 1. Cílová architektura (web nejdřív, desktop později)
```
Prohlížeč (statický frontend na CF Pages/Netlify, NE GitHub Pages)
   │  JWT (Supabase Auth)
   ▼
Supabase: Auth + Postgres (RLS) + Edge Functions (API vrstva)
   ├─ tabulky: profiles, subscriptions, entitlements, app_state, mt5_*
   ├─ data tabulky čitelné jen pro roli s aktivním předplatným (žádné anon SELECT)
   └─ Stripe/Paddle webhook (edge funkce) → subscriptions
Ingest (cron, mimo GitHub nebo GitHub jako dočasné) → jen licencované/veřejné zdroje → Postgres
Odvozené: scoring se přesune z klienta do edge funkce / SQL view (klient dostane skóre, ne surová data)
Desktop později: Tauri/Electron obal nad stejným frontendem a stejným API (žádná druhá logika)
```
Principy: jeden zdroj pravdy (API), přístup řídí server (RLS + entitlements), zdrojová data se nezveřejňují, klient dostává jen odvozené výsledky. Sjednocení tří UI na jedno (dnes `index.html`, `m.html`, `classic.html` driftují) je podmínka udržitelného placeného produktu.

## 2. Závěr – odpovědi na otázky zadání
**Je Analyzer připraven na komerční provoz? – NE.** Funkčně a datově je to silný osobní nástroj, ale chybí: serverové řízení přístupu a předplatného, licence dat, bezpečnostní opravy a oddělení veřejných dat.

**Která data lze zachovat?** Vlastní odvozená data (skóre, snímky, historie vlastních výpočtů), CFTC COT (po ověření podmínek), BYOK klíče uživatelů, MT5 deník (data patří uživateli), vlastní kód.

**Co vyžaduje souhlas/licenci?** Myfxbook, FXSSI, Forex Factory/FairEconomy (písemný souhlas), cenová data (Yahoo → nahradit), FRED série s copyrightem třetích stran, RSS zprávy v radaru, případně CBOE VIX.

**Co nahradit?** Yahoo → licencované price API; FF kalendář → licencovaný/vlastní; FXSSI/Myfxbook → licencovaný zdroj nebo vynechat/BYOK; CORS proxy odstranit; GitHub Pages → jiný hosting.

**Měsíční provoz:** minimální varianta ~926 Kč (20 zákazníků) až ~17 000 Kč (1000), profesionální ~22 000 až ~45 500 Kč (viz `AT_TRADING_MONTHLY_COSTS.md`; datové licence jsou odhad).

**Největší překážky (seřazeno):**
1. Licence dat (kalendář, sentiment, ceny) – a redistribuce přes veřejná `data/*.json` a anon Supabase.
2. Klientská přístupová brána místo serverové; žádné předplatné/entitlements.
3. Bezpečnostní nálezy (7× security definer view, API klíče uživatelů v sync).
4. Signál bez prokázané hrany (kalibrace PF < 1) – riziko u marketingových tvrzení a regulace; nutný disclaimer a opatrné pozicování.
5. Provozní zralost: GitHub Actions jako scheduler, žádné SLA/monitoring/zálohy, SMTP ve zkušebním režimu.

## 3. Nejlevnější bezpečná placená beta
- **Rozsah:** do ~20–30 pozvaných uživatelů, předplatné ručně/přes Stripe Payment Link, pozicování „analytický přehled a vzdělávání“, ne signály.
- **Data:** jen CFTC (po ověření), vlastní odvozené skóre a BYOK; kalendář a retail sentiment buď vypnout, nebo za BYOK, dokud nejsou licence. Cenová data buď BYOK, nebo jeden levný feed s potvrzenou display licencí.
- **Technika:** přesun hostingu mimo GitHub Pages, soukromé repo, uzavření anon SELECT na zdrojových tabulkách, opravit 7 views, přidat `entitlements` + serverovou kontrolu, SMTP z produkční domény, zapnout leaked-password protection.
- **Náklad:** ~$40–120/měs. (~900–2 600 Kč) dle tabulky A.

## 4. Plán na 30 dní
| Týden | Úkol | Výstup |
|---|---|---|
| 1 | Přečíst plné podmínky CFTC, FRED, ECB, GitHub Pages; napsat Myfxbook, FXSSI (a FF) žádost o komerční licenci; dotazy Twelve Data/Tiingo/EODHD na display licenci a cenu | tabulka odpovědí, aktualizace licenčního auditu |
| 1 | Zjistit viditelnost repa, tarif Supabase, spotřebu Actions minut, skutečný obsah `app_state` (API klíče) | doplnění technického auditu |
| 2 | Návrh bezpečnosti (bez nasazení): RLS politiky pro zdrojové tabulky, `profiles/subscriptions/entitlements`, oprava security definer views | schválený migrační plán (SQL ve verzi, neprovedeno) |
| 2 | Rozhodnutí o právní formě, DPH (OSS), podmínky služby, disclaimer, zásady ochrany osobních údajů – konzultace s právníkem/účetní | checklist |
| 3 | Na staging projektu Supabase prototyp: auth + entitlements + Stripe webhook; hosting na CF Pages; soukromé repo | funkční beta prostředí |
| 3 | Odpojit zdroje bez licence z produkční větve (feature flagy), kalendář/sentiment přepnout na BYOK/vypnuto | seznam zdrojů „zelených“ |
| 4 | Pozvat 5–10 testerů, měřit spolehlivost dat a podporu, zapnout monitoring a zálohy | beta report |
| 4 | Rozhodnout go/no-go podle odpovědí poskytovatelů a break-even | rozhodnutí |

## 5. Otevřené body (NEOVĚŘENO)
Viditelnost repa, tarif Supabase, plné znění podmínek většiny poskytovatelů, ceny hostingu/monitoringu/záloh, aktuální oficiální ceny Stripe ČR, právní kvalifikace služby (investiční doporučení vs. obecná analýza), GDPR vztah k uloženým API klíčům.

*Pravidlo auditu dodrženo: nic nebylo upraveno, smazáno ani migrováno, žádné placené účty nevznikly.*

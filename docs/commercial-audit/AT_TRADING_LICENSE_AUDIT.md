# AT Trading FX Analyzer – Licenční audit (Fáze 3 + 4)

> **Důležité omezení:** Tento dokument není právní posudek. Plná znění podmínek se mi nepodařilo načíst (nástroj WebFetch nebyl k dispozici; použito webové vyhledávání, které vrací úryvky a sekundární zdroje). Každý závěr proto nese stupeň důkazu. **Žádný závěr níže není právní jistota.** Před placeným provozem je nutné ověřit plné znění podmínek a ideálně písemně požádat poskytovatele.
>
> Stupnice: **ZELENÁ** = povoleno doloženě · **ORANŽOVÁ** = nejasné / vyžaduje ověření nebo souhlas · **ČERVENÁ** = pravděpodobně zakázáno / vysoké riziko · **NEOVĚŘENO** = nenalezeno.
> Pozn.: i „ČERVENÁ“ zde znamená *riziko z dostupných indicií*, ne potvrzené porušení.

## 1. Rozlišení, které rozhoduje
- **Odvozený výpočet** (skóre, bias, ranking vypočtený z dat): obecně bezpečnější, ale licence mnoha poskytovatelů zakazuje i použití dat „pro komerční účely“ bez licence, ne jen redistribuci.
- **Redistribuce zdrojových dat** (zobrazení tabulky COT/kalendáře/cen, veřejné `data/*.json`, anonymní SELECT v Supabase): **dnes se děje** – veřejné repo/Pages a anon RLS vystavují zdrojová data komukoli. To je pro placený model největší problém bez ohledu na poskytovatele.

## 2. Zdroje

| Zdroj | Závěr | Důkaz (typ) | Odkaz | Konkrétní ustanovení / poznámka |
|---|---|---|---|---|
| **CFTC COT** | **ORANŽOVÁ** (pravděpodobně přijatelné) | [WEB] data.gov katalog uvádí datasety COT jako veřejně přístupné (Open Government), bez uvedené licence | https://catalog.data.gov/dataset/commitments-of-traders | Vládní zveřejnění; obecná „terms of use“ pro stahování nenalezena (nalezené podmínky se týkají jen datových submission systémů: https://accountcreation.cftc.gov/UserAgreementForm.aspx). Ověřit patičku/„Website policies“ cftc.gov. |
| **Yahoo Finance** (neoficiální `query1`) | **ČERVENÁ** | [WEB] sekundární citace Yahoo API podmínek: zákaz používat API k získávání příjmů bez povolení; yfinance README: „personal use only“; developer guidelines: některá API jen pro nekomerční použití | https://legal.yahoo.com/us/en/yahoo/terms/product-atos/apiforydn/index.html , https://legal.yahoo.com/us/en/yahoo/guidelines/ydn/index.html | Plné znění nepřečteno; navíc používaný endpoint není oficiální API. Pro placenou službu nepoužívat. |
| **Myfxbook API** | **ORANŽOVÁ → ČERVENÁ pro komerci** | [WEB] API stránka: použitím souhlasíte s Terms of use; free limit 100 požadavků/24 h, placená varianta existuje | https://www.myfxbook.com/api | Text podmínek nenalezen. Skript se přihlašuje uživatelským účtem a ukládá data → nutná písemná dohoda. |
| **FXSSI** | **NEOVĚŘENO** (dosavadní postup = scraping neveřejného JSON) | [WEB] žádné podmínky nenalezeny | – | Scraping `c.fxssi.com` bez dohody považovat za rizikový. |
| **Forex Factory / FairEconomy** | **ČERVENÁ** | [WEB] sekundární: žádné oficiální API; podmínky zakazují kopírování/redistribuci kalendáře bez písemného souhlasu | https://www.forexfactory.com/notices , https://www.financecalendar.com/?p=2921 (sekundární) | Navíc kód obchází IP blokaci (relay, browser UA). Primární text podmínek nenalezen → NEOVĚŘENO, ale riziko vysoké. |
| **FRED** | **ORANŽOVÁ** | [WEB] API terms: série s copyrightem třetích stran vyžadují souhlas vlastníka pro jiné než osobní použití; zákaz redistribuce cizího obsahu pro komerční užití bez povolení; 2024 doplnění: zákaz ukládat/cachovat/archivovat obsah FRED přes API | https://fred.stlouisfed.org/docs/api/terms_of_use.html , https://fred.stlouisfed.org/legal/terms_of_use.html | Projekt ukládá FRED série do `data/` = přesně to, co 2024 doplnění omezuje. VIXCLS pochází od CBOE (třetí strana) → ověřit. |
| **CBOE delayed VIX** | **NEOVĚŘENO** | – | – | Vyžaduje čtení CBOE podmínek. |
| **ECB / Frankfurter** | **NEOVĚŘENO** | – | – | Nečteno. Obecně ECB referenční kurzy mají zveřejněnou reuse policy – ověřit. |
| **Stooq** | **NEOVĚŘENO** | – | – | Technicky nefunkční z Actions; nepoužívat. |
| **Finnhub** | **ZELENÁ jako BYOK**; ORANŽOVÁ pokud by provozovatel zobrazoval data zákazníkům | [WEB] forex pricing stránka: licence „Personal Use“ | https://www.finnhub.io/pricing-forex-api | Vlastní klíč uživatele = jeho smlouva. |
| **Twelve Data** | ORANŽOVÁ | [WEB] redistribuce přes API vyžaduje samostatnou licenční smlouvu | https://intercom.help/twelvedata/en/articles/12520817-forex-api-v2 | Zobrazení vlastních výpočtů v aplikaci může spadat pod „display“ licenci – dotaz na sales. |
| **Tiingo** (alternativa) | ORANŽOVÁ | [WEB] uvádí tarif „Display Redistribution“ (~$250/měs. startup, ~$500 enterprise) – nepotvrzeno proti podmínkám | https://api.tiingo.com/products/forex-api | |
| **Alpha Vantage / FMP / EODHD** | NEOVĚŘENO (podmínky existují, nečteno) | – | https://alphavantage.co/terms_of_service , https://site.financialmodelingprep.com/developer/docs/terms-of-service , https://eodhd.com/financial-apis/commercial-vs-personal-license-use | EODHD má explicitně oddělenou komerční licenci. |
| **OANDA** | NEOVĚŘENO | – | – | Order book přes uživatelův token = BYOK. |
| **RSS zprávy (radar)** | **ORANŽOVÁ/ČERVENÁ** | [KÓD] radar ukládá titulky do `radar_hist.json` a zobrazuje | – | Autorské právo / podmínky feedů; veřejné zobrazení cizích titulků + AI shrnutí v placené službě → ověřit nebo nahradit licencovaným zpravodajstvím. |
| **OpenRouter / OpenAI / Gemini** | NEOVĚŘENO | – | – | BYOK pro Coach OK; server-side radar na klíči provozovatele je provozní náklad, ne licenční problém (ověřit podmínky komerčního použití a zpracování osobních údajů). |
| **GitHub Pages** | **ORANŽOVÁ** | [WEB] dokumentace limitů (verze Enterprise Server): Pages „is not intended for or allowed to be used as a free web hosting service to run your online business, e-commerce site, or any other website that is primarily directed at either facilitating commercial transactions or providing commercial software as a service (SaaS)“ | https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits | Citace z kopie dokumentace pro Enterprise Server; aktuální verzi pro github.com nutno ověřit. Pro placený SaaS hostovat jinde. |
| **CORS proxy** | nepoužívat v produkci | [KÓD] | – | Veřejné služby bez smlouvy; navíc přenášejí požadavky třetích stran. |

## 3. Souhrn podle otázek zadání
- **Osobní vs. komerční použití:** dnešní stav je osobní/hobby. Yahoo, FF, Myfxbook, FXSSI jsou nejproblematičtější pro komerci.
- **Ukládání na vlastní server:** FRED (2024 doplnění) a pravděpodobně FF/Myfxbook podmínky to omezují; CFTC zřejmě ne (NEOVĚŘENO).
- **Vlastní indikátory z cizích dat:** nejméně problematické u CFTC; u ostatních záleží na znění „commercial use“.
- **Zobrazení platícím zákazníkům / redistribuce:** dnes redistribuuje veřejné `data/*.json` a anon Supabase tabulky → nutno uzavřít, ať už licence dopadne jakkoli.

## 4. Alternativy (Fáze 4) – preferenční pořadí
1. **Veřejná/otevřená data s explicitně povoleným použitím** *(vše NEOVĚŘENO, nutno přečíst podmínky)*: CFTC (COT), ECB (referenční kurzy), FRED série označené jako Public Domain, EIA (ropa), ČNB (kurzy a sazby), BIS/OECD/Eurostat/BLS/BEA (makro, vládní zdroje).
2. **Vlastní výpočty z veřejných dat:** vlastní kalendář událostí z oficiálních termínů centrálních bank a statistických úřadů (BLS, Eurostat, ONS…) místo FF; actual hodnoty z oficiálních releasů. Nejvyšší pracnost, nejnižší licenční riziko.
3. **Levná API s komerční/display licencí:** Twelve Data, Tiingo, EODHD, Polygon, FMP – ceny a podmínky nutno potvrdit u obchodního oddělení (indicie: Tiingo display ~$250/měs.).
4. **Retail sentiment:** bez veřejného zdroje s komerční licencí; reálné cesty: (a) smlouva s FXSSI/Myfxbook, (b) data z vlastních zdrojů (OANDA/IG partnerské API), (c) sentiment z COT jako náhrada, (d) v beta variantě sentiment vynechat nebo ho nechat jako BYOK.
5. **Drahé feedy** (LSEG, ICE, CME): až při škálování.
6. **Model BYOK:** zákazník dodá vlastní klíč (Finnhub/OANDA/Twelve Data) – právní riziko přechází na smlouvu zákazníka; Analyzer data jen zobrazuje, neukládá. Již dnes částečně implementováno.

## 5. Co dělat před jakýmkoli prodejem
1. Přečíst plné znění podmínek (CFTC, FRED, ECB, vybraný price provider, GitHub Pages) – ne z úryvků.
2. Písemně požádat Myfxbook/FXSSI/FF o komerční licenci; bez odpovědi zdroje nahradit.
3. Právník: odpovědnost za finanční obsah, disclaimery, GDPR, DPH/OSS.

# US100 (Nasdaq-100) — fundamentální směr, roadmapa

> Kontext: US100 je v appce samostatný, plně izolovaný nástroj (vlastní
> `data/us100_*.json`, vlastní `localStorage` klíče, vlastní fetch skripty —
> nic z tohohle se nikdy nedotýká 8 FX měn ani `STANDARD_PAIRS`). Tenhle
> dokument popisuje, co už appka reálně počítá do BIAS skóre (Tier 1+2), a
> návrh, jak later přidat zbytek (Tier 3+4) — beze změny v Tier 1+2 kódu.

---

## Stav — implementováno (Tier 1 + Tier 2)

`scoreUS100()` v `engine.js` počítá `score = cotScore + sentScore + macroScore`,
kde `macroScore = usdScore + riskScore + yieldScore + dxyScore + fedScore`:

| Komponenta | Zdroj | Nový fetch? | Směr |
|---|---|---|---|
| `usdScore` | živé USD skóre appky (`loadScoreHistory()`) | ne — appka to už počítá pro FX | silný USD → tlak dolů |
| `riskScore` | `computeAutoRiskSentiment()` (VIX) | ne — appka to už počítá pro FX | risk-off → tlak dolů |
| `yieldScore` | FRED `DGS10`, 20denní změna | ano, `fetch-us100-macro.js` | rostoucí výnosy → tlak dolů |
| `dxyScore` | FRED `DTWEXBGS`, 20denní změna | ano, `fetch-us100-macro.js` | silnější dolar → tlak dolů |
| `fedScore` | FRED `DFF`, 20denní změna | ano, `fetch-us100-macro.js` | rostoucí sazby → tlak dolů |

Váhy/koeficienty jsou tržní konvence (směr vztahu), NE zpětně testované — stejný
princip appka už používá u VIX prahů (`classifyRegime` ve `fetch-vix.js`). Každá
komponenta je samostatně tlumená (malý rozsah), ať jedna vstupní řada sama
nezlomí celkové skóre. Zdroj dat: FRED `fredgraph.csv`, bez API klíče — appka
stejný zdroj/vzorec už ověřeně používá pro VIX a v research reportu.

---

## Návrh — Tier 3 (později, náročnější)

### A) US makro kalendář reinterpretovaný pro akcie
FX skórovací pravidla (`EVENT_RULES` v `engine.js`) říkají "lepší data = silnější
měna" — pro US100 to částečně platí obráceně ("dobrá zpráva je špatná zpráva",
protože silná data = menší šance na snížení sazeb = tlak na ocenění growth
firem). Nejde ale o čistou inverzi: záleží na režimu (goldilocks vs. přehřátá
ekonomika vs. recesní strach), takže přímé převzetí `EVENT_RULES` by dávalo
zavádějící signál (viz i odpověď appky uživateli v chatu: "slabá data pro USD
= dobré pro US100" platí JEN v goldilocks scénáři, ne při recesním honění).

Navrhovaný postup, až na to dojde:
1. Nová, samostatná sada pravidel (ne recyklace `EVENT_RULES`) pro klíčové US
   reporty s dopadem na akcie: NFP, CPI, ISM Manufacturing/Services, GDP,
   Fed rozhodnutí/dot plot.
2. Režimový přepínač: pokud je aktuální Fed funds trend klesající/pauza
   (viz `fedScore` výš) → "dobrá data" = mírně bullish (soft landing potvrzen).
   Pokud je Fed v hike módu nebo `riskRegime==='RISK_OFF'` → "dobrá data" =
   bearish (odkládá uvolnění). Bez režimového rozlišení je signál nespolehlivý
   — proto to není v Tier 1/2.
3. Zdroj dat: appka už kalendář stahuje (`data/calendar.json`, US eventy tam
   jsou) — nejde o nový zdroj, jen o novou interpretaci existujících dat,
   psanou do samostatné `us100`-scoped funkce (žádný zásah do sdíleného
   `scoreCurrency`/`getShortTermFundScore`).

### B) Credit spreads / Financial Conditions Index
FRED `NFCI` (Chicago Fed National Financial Conditions Index) — týdenní,
bez klíče, stejný `fredgraph.csv` vzorec jako `DGS10`/`DTWEXBGS`/`DFF`.
Kladné hodnoty = přísnější finanční podmínky = tlak dolů na rizikové aktivum.
Nízké riziko na přidání (stejný pipeline, jen další `SERIES` klíč ve
`fetch-us100-macro.js` a další `*Score` člen v `scoreUS100()`), ale odloženo
mimo Tier 1/2, ať se první verze makro bloku nejdřív ověří na živém provozu.

---

## Návrh — Tier 4 (mimo dohled, náročné/rizikové)

### C) Mega-cap earnings faktor
Nasdaq-100 je koncentrovaný v hrstce firem (mega-cap tech) — jejich earnings
překvapení hýbou indexem nepřiměřeně k šíři trhu. Vyžadovalo by nový datový
zdroj (earnings kalendář + surprise %) pro ~10 tickerů, což appka dnes nemá a
není to `EVENT_RULES`-kompatibilní tvar. Náročnější na údržbu (earnings sezóny
4×/rok, ne kontinuální tok jako makro) — realisticky až po ověření Tier 3.

### D) Cena/technika (RP+ER, sezónnost)
Appka pro FX páry používá price-based komponenty (RP+ER, sezónnost), ale zdroj
cen (Stooq) je ze GitHub Actions IP blokovaný (ověřeno diagnostickým
`probe-gold-us100.yml` workflow — infra limitace, ne specifická pro US100).
Než tohle půjde přidat i pro US100, potřeba vyřešit price feed obecně — např.
Yahoo Finance fallback stejným způsobem, jak už `fetch-oil.js` řeší WTI (Yahoo
jako fallback zdroj). Blokující závislost, ne US100-specifický problém.

---

## Invarianty, které musí platit i po Tier 3/4

- Žádná nová složka, žádný nový `data/*.json` mimo `data/us100_*.json`.
- Žádný nový fetch skript mimo `scripts/fetch-us100-*.js`.
- Žádný zásah do `STANDARD_PAIRS`, `CURRENCIES`, `scoreCurrency`,
  `EVENT_RULES`, ani do žádné funkce používané pro 8 FX měn.
- Všechno nové musí reálně vstupovat do `scoreUS100()` (žádný "jen na
  zobrazení" ukazatel) a zobrazovat se výhradně v existující US100 detail
  kartě/dashboardu — žádný nový samostatný panel/tab jinde v appce.

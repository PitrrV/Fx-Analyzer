# Zadání pro Claude Cowork: označení Supply/Demand zón u historických Reverzál signálů (TradingView)

## Prompt k vložení do Coworku

> Přečti si přiložené zadání `COWORK_ZONE_LABELING.md` a vstupní soubor `signals_to_label.csv` (320 řádků). Pro každý řádek otevři v TradingView
> Bar Replay k danému okamžiku, podle pravidel v zadání označ Supply/Demand zóny a vyplň řádek v `labels_filled.csv` (šablona `labels_template.csv`).
> Nikdy se nedívej na vývoj ceny po signálu. Pracuj po dávkách po 20 řádcích, po první dávce mi ukaž 5 řádků ke kontrole. Žádné jiné soubory z repozitáře neotvírej.

K práci stačí jen tyto tři soubory: `COWORK_ZONE_LABELING.md`, `signals_to_label.csv`, `labels_template.csv`. **Nesdílej** složku `out/` ani `data/`: obsahují výsledky signálů.

## 1. Proč to děláme (stručně)

Analyzer posílá na Telegram Reverzál signály (RP+ER). Statistický výzkum (`research/reversal/REVERSAL_EDGE_RESEARCH.md`) neprokázal, že by signál sám nebo algoritmické zóny dávaly edge.
Nezkoušelo se jedno: **tvoje subjektivní Supply/Demand zóny na W1, D1 a H4**. Úkolem je u 300 náhodně vybraných historických signálů zapsat, jak by zóny vypadaly, **jen z toho, co bylo v ten okamžik vidět**.
Výsledky signálů se k tobě nedostanou. Vyhodnotí je potom skript proti předem zapsaným hypotézám. Cílem není najít obchody, ale zjistit, jestli zóna cokoli vysvětluje.

## 2. Pravidla proti zkreslení (nejdůležitější část)

1. **Bar Replay:** graf musí končit svíčkou, která se uzavřela v čase signálu. Po nastavení nikdy nespouštěj Play, nepřetáčej dopředu a nescrolluj za poslední svíčku.
   Po vyplnění řádku **se nedívej, jak signál dopadl**. Nevyhledávej obchody ani zprávy z toho dne na internetu.
2. **Pořadí:** řádky jdi přesně v pořadí souboru (je záměrně zamíchané). Už zapsané řádky nikdy neupravuj.
3. **Opakování:** 20 signálů je v souboru dvakrát pod různým ID. Označ je pokaždé znovu a nezávisle, ke shodě je nehledej. Slouží k ověření, jak stabilní je označování.
4. **Žádné indikátory** (jen svíčky, případně objem). Nepoužívej AI funkce ani cizí šablony zón.
5. **Čas:** nejvýš 4 minuty na řádek. Když je situace nejasná, zapiš, co vidíš, a dej `confidence_1_3 = 1`. Nepřemýšlej nad tím, jestli by to byl zisk.
6. **Žádné domýšlení:** když nejde zobrazit graf nebo replay, napiš `n/a` do polí a důvod do `notes`.

## 3. Příprava TradingView

- Plán s Bar Replay na 4H (pokud ho nemáš na 4H, použij jen D1/W1 a pole H4 vyplň `n/a`).
- Symbol `tv_symbol` ze souboru (např. `OANDA:EURUSD`). Zóna: **UTC** (Settings → Time zone → UTC). Svíčkový graf, žádné indikátory, čistý layout bez dříve nakreslených čar.
- Tři grafy: **W1, D1, H4** stejného symbolu. Replay nastav na každém časovém rámci na stejný okamžik.

## 4. Postup pro každý řádek

1. Přečti `pair`, `type` (LONG/SHORT) a `signal_time_utc` (vždy 00:00 UTC; poslední viditelná H4 svíčka je ta, která skončila v 00:00, tj. 20:00–24:00 předchozího dne).
2. V Replay vyber tento okamžik. Zkontroluj, že poslední svíčka na H4 odpovídá. Poznamenej si cenu poslední svíčky.
3. Pro **každý** časový rámec (W1, D1, H4) najdi **nejbližší nezrušenou zónu ve směru signálu**:
   - **LONG → Demand zóna** (kolem ceny nebo pod ní). **SHORT → Supply zóna** (kolem ceny nebo nad ní).
   - **Zóna** je oblast základny: 1–3 svíčky s malým tělem nebo konsolidace, ze které cena odešla impulzivně (aspoň 2 svíčky po sobě ve směru odchodu, nebo jedna svíčka s tělem
     aspoň 1,5× větším než průměr těl posledních 10 svíček).
   - **Hranice:** Demand: dolní = nejnižší low základny, horní = nejvyšší hrana těla (open/close) základny. Supply: horní = nejvyšší high základny, dolní = nejnižší hrana těla.
   - **Nezrušená:** žádná svíčka se nezavřela skrz zónu na druhou stranu.
   - Hledej jen v části grafu, kterou vidíš při výchozím zoomu (zhruba 100 svíček). Nic nevyhledávej dál do historie.
   - **fresh = Y**, pokud se cena do zóny od jejího vzniku ještě nevrátila (první test). **fresh = N**, pokud ji už aspoň jednou testovala.
   - Žádná taková zóna → `zone_xx = N` a ceny nech prázdné.
4. **Protilehlá zóna:** nejbližší zóna opačného typu ve směru očekávaného pohybu (LONG: nejbližší Supply nad cenou; SHORT: nejbližší Demand pod cenou), nejlépe z D1, jinak z H4. Zapiš její hranice, nebo nech prázdné, když žádná není.
5. **liquidity_sweep_last12h4 = Y**, pokud v posledních 12 H4 svíčkách (2 dny) knot zřetelně prorazil předchozí swing (nebo včerejší high/low) a svíčka se zavřela zpět uvnitř. U LONG sweep minima, u SHORT sweep maxima. Jinak N.
6. **at_key_level = Y**, pokud je cena do přibližně jedné průměrné D1 svíčky od zřetelné horizontální úrovně na D1/W1 (aspoň 2 dotyky). Jinak N.
7. **would_take** (vyplň nakonec): „Vzal bych tento Reverzál jako obchod, kdybych znal jen to, co vidím na grafu?“ **Y/N**. A `confidence_1_3`: 1 = nejistý, 2 = střední, 3 = jasný obraz.
8. Zapiš `minutes_spent` a stručnou poznámku (max. 1 věta), jen pokud se děje něco nestandardního.

## 5. Formát výstupu `labels_filled.csv`

Stejné sloupce a pořadí jako `labels_template.csv`, jeden řádek na ID, UTF-8, oddělovač čárka, desetinná tečka.

| Sloupec | Hodnoty |
|---|---|
| `id` | beze změny |
| `zone_w1`, `zone_d1`, `zone_h4` | `Y` nebo `N` (nebo `n/a`) |
| `w1_top`, `w1_bottom`, `d1_top`, `d1_bottom`, `h4_top`, `h4_bottom` | cena (např. `1.08350`, u JPY `150.250`), prázdné když zóna `N` |
| `w1_fresh`, `d1_fresh`, `h4_fresh` | `Y` / `N`, prázdné když zóna `N` |
| `opposing_zone_top`, `opposing_zone_bottom` | cena, prázdné když není |
| `liquidity_sweep_last12h4`, `at_key_level`, `would_take` | `Y` / `N` |
| `confidence_1_3` | 1, 2 nebo 3 |
| `minutes_spent` | celé číslo |
| `notes` | volný text, nejvýš 1 věta |

Ukázka řádku (ceny fiktivní, jen formát): `L001,N,,,,Y,1.08420,1.08210,Y,Y,1.08390,1.08300,N,1.09150,1.08980,N,Y,Y,2,3,`

## 6. Dávky a kontrola kvality

- Pracuj po **20 řádcích**, po každé dávce soubor ulož.
- **Pilot:** po prvních 20 řádcích ukaž uživateli 5 vyplněných řádků a stručně popiš problémy. Pokračuj až po odsouhlasení.
- Po každých 100 řádcích napiš do `labeling_log.md` počet hotových řádků, průměrný čas a ID s problémem (chybějící graf, nejasná zóna).
- Odhad práce: 320 řádků ≈ 15–20 hodin. Lze rozložit do více dnů.

## 7. Co se s tím stane potom (jen pro přehled)

Skript `research/reversal/i_analyze_cowork_labels.py` spojí štítky s výsledky signálů a otestuje **předem zapsaných šest hypotéz** (cíl: dosažení +1 ATR před −1 ATR do 48 h; sekundárně výsledek po 48 h):

| | Hypotéza |
|---|---|
| H1 | Cena je v zóně nebo u ní (do 0,25 ATR) na kterémkoli rámci |
| H2 | Totéž na D1 nebo W1 |
| H3 | `would_take = Y` |
| H4 | Volný prostor: protilehlá zóna je dál než 3 ATR nebo žádná |
| H5 | Liquidity sweep = Y |
| H6 | Čerstvá zóna a cena v ní/u ní |

Nejistota se počítá bootstrapem po clusterech, s korekcí na 12 testů (BH FDR) a kontrolou stability v první a druhé polovině období. Zvlášť se změří shoda opakovaných označení a shoda s algoritmickými zónami (kappa).
Hypotézy se po dodání štítků nemění. **300 signálů odliší jen efekt kolem 11–14 procentních bodů a víc**, menší efekt tento vzorek neukáže. Neúspěch (žádný efekt) je legitimní výsledek.

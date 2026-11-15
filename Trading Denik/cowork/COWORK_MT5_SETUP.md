# Zadání pro Claude Cowork: zprovoznění MT5 konektoru (jen čtení) pro Trading deník

## Prompt k vložení do Coworku

> Přečti si přiložené zadání `COWORK_MT5_SETUP.md` a proveď ho celé sám, bez dotazů, na tomto počítači s Windows. Cílem je zprovoznit automatický zápis obchodů z MT5 do Trading deníku v Analyzeru.
> Konektor je jen pro čtení. **Nikdy neobchoduj, nemaž ani neupravuj žádné pozice, nezapínej Algo Trading, neposílej e-maily ani zprávy podpoře a token nikam nepiš.**
> Zastav se a zeptej se mě jen ve dvou případech: (a) MT5 terminál je odhlášený a vyžaduje heslo k účtu, (b) Analyzer v prohlížeči není přihlášený a nejde otevřít Trading deník.

## 1. Co se staví (pro orientaci)

Malý Python program běží na tomto počítači vedle terminálu MT5, přes oficiální balíček `MetaTrader5` **čte** obchody, pozice a equity a posílá je šifrovaně (HTTPS) do Analyzeru. Hesla k účtu nepotřebuje, připojí se k už přihlášenému terminálu.
Instalaci dělá hotový skript `install_windows.ps1`. Ty ho jen spustíš, zkontroluješ výsledek a ověříš ho v Analyzeru.

## 2. Zakázáno (platí vždy)

- Žádné obchodní akce v MT5: nekliknout na Buy/Sell/Close/Modify, nic nevkládat do Obchodu, nepouštět žádné EA ani skripty.
- Nezapínat **Algo Trading** a nic nenastavovat v terminálu. Jen si zapiš, jestli je zapnuté.
- Nezadávat ani neukládat hesla k obchodním účtům (hlavní ani investor). Když terminál žádá přihlášení, zastav se (viz bod 6).
- Token konektoru nepsat do chatu, nefotit, nevkládat do souborů mimo skript, nesdílet v reportu. Pokud se token omylem objeví na obrazovce nebo v textu, v Analyzeru ho hned zneplatni tlačítkem „Nový token“ a založ znovu.
- Nic neměnit v repozitáři GitHub, nic neposílat podpoře prop firem, žádné e-maily.
- Neotvírat jiné soubory z repozitáře než zde uvedené.

## 3. Postup (proveď pro každý účet zvlášť; první FundingPips, potom ForTraders)

Jeden terminál MT5 = jeden účet. Pro každý účet tedy potřebuješ jeho vlastní terminál (vlastní složku s `terminal64.exe`).

### Krok A – zjisti terminály
1. Najdi nainstalované MT5 terminály (Start menu, plocha, typicky `C:\Program Files\MetaTrader 5\terminal64.exe` nebo složky brokerů, např. `C:\Program Files\FundingPips MetaTrader 5\`). Správnou cestu ukáže pravé tlačítko na zástupci → Vlastnosti → Cíl.
2. Zapiš pro každý účet: cestu k `terminal64.exe`, jestli terminál běží a zda je přihlášený na správný účet (název účtu v hlavičce okna).
3. Když pro ForTraders existuje jen jeden terminál sdílený s FundingPips (jeden přepíná účty), nastav **jen ten, který je právě přihlášený**, a druhý účet uveď v závěrečné zprávě jako nedokončený s důvodem „potřebuje vlastní terminál“. Druhý terminál neinstaluj sám.

### Krok B – založ účet v Analyzeru a zkopíruj token
1. V prohlížeči otevři Analyzer (GitHub Pages repozitáře `PitrrV/Fx-Analyzer`, obvykle `https://pitrrv.github.io/Fx-Analyzer/`, kde je uživatel přihlášený přes Cloud sync v Nastavení). Otevři záložku **Trading deník**, nahoře sekce **MT5 deník (automatický)**.
2. Klikni **+ Přidat MT5 účet**. Název účtu napiš přesně `FundingPips` (pro druhý `ForTraders`), broker a server doplň, pokud je znáš (zbytek nech prázdný), měna `USD` (MT5 ji potom doplní sám). Klikni **Vytvořit účet a token**.
3. Zobrazí se oranžový rámeček s tokenem. Klikni **Kopírovat** (token je teď ve schránce). **Nezavírej stránku, token nikam jinam nevkládej.** Až skript token načte, schránka se sama vymaže. Až potom klikni **Uložil jsem ho, skrýt**.

### Krok C – spusť instalační skript (hned po zkopírování tokenu)
1. Otevři **PowerShell** jako běžný uživatel (ne jako správce).
2. Stáhni a spusť skript. Pro FundingPips (cestu k terminálu dosaď podle kroku A):
   ```
   Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/PitrrV/Fx-Analyzer/main/Trading%20Denik/connector/install_windows.ps1" -OutFile "$env:TEMP\install_windows.ps1"
   powershell -ExecutionPolicy Bypass -File "$env:TEMP\install_windows.ps1" -AccountName "FundingPips" -TerminalPath "C:\cesta\k\terminal64.exe"
   ```
3. Skript sám: najde nebo nainstaluje Python (při instalaci ti řekne, abys otevřel nové okno PowerShellu a spustil ho znovu, udělej to; token ve schránce mezitím ponech nebo ho znovu zkopíruj z Analyzeru tlačítkem „Nový token“), nainstaluje balíček `MetaTrader5`, stáhne soubory, načte token ze schránky (jinak se zeptá, vlož ho tehdy zkopírovaný), spustí **diagnostiku**, jednou konektor spustí a založí úlohu Plánovače **`ATTradingMT5-FUNDINGPIPS`** (poběží při každém přihlášení).
4. Úspěch poznáš podle řádků:
   - `OK: diag_report.json · účet ***XYZ · hedging|netting · USD · deals N · otevřené pozice M`
   - `OK deals=N -> {...}`
   - `Úloha 'ATTradingMT5-…' založena a spuštěna`
5. Případné problémy a řešení:
   | Hláška | Co dělat |
   |---|---|
   | `Terminál MT5 nenalezen` | Oprav cestu k `terminal64.exe` (krok A) |
   | `MT5 initialize selhalo` nebo `Diagnostika selhala` | Spusť terminál a počkej, až se přihlásí na účet; zkus znovu. Pokud chce heslo, stop (bod 6) |
   | `server odmítl přístup (HTTP 401/403)` | Token je špatný nebo zneplatněný. V Analyzeru klikni u účtu „Nový token“, zkopíruj a spusť skript znovu |
   | `Instalace balíčku MetaTrader5 selhala` | Zjisti, že Python je 64bitový, a spusť znovu |
   | Skript zablokován politikou spouštění | Použij přesně příkaz s `-ExecutionPolicy Bypass` výše |

### Krok D – ověř v Analyzeru (do 2 minut)
Na stránce Trading deník klikni **⟳ Obnovit** a zkontroluj:
1. U účtu stojí zelené **„● konektor běží“**, jsou vidět `balance` a `equity` a režim `hedging` nebo `netting` a měna.
2. Pokud účet má historii obchodů, objeví se v seznamu Obchody. Počet zhruba odpovídá historii v MT5 (záložka Historie, zvol celé období).
3. Po několika minutách se objeví equity křivka (potřebuje aspoň dva vzorky po 60 s).
4. V Plánovači úloh Windows je úloha `ATTradingMT5-…` ve stavu „Běží“ nebo „Připraveno“.
Pořiď screenshot karty účtu (bez tokenu) a seznamu obchodů.

### Krok E – druhý účet
Zopakuj kroky B až D pro ForTraders s jeho vlastním terminálem a názvem účtu `ForTraders`.

## 4. Podklady pro ověření na skutečných datech (E6)

Z každého účtu vezmi soubor `%USERPROFILE%\ATTradingMT5\<NAZEV_UCTU>\diag_report.json` (např. `...\FUNDINGPIPS\diag_report.json`). Obsahuje historii obchodů (bez hesel, bez komentářů, číslo účtu je zamaskované na poslední 3 číslice). Přilož ho k závěrečné zprávě. Slouží k offline kontrole, že konektor správně chápe tvar dat z MT5 (hedging/netting, částečná zavření, reverzace).

## 5. Závěrečná zpráva (formát)

Pro každý účet jednu tabulku s položkami:
- název účtu, režim (hedging/netting), měna, počet obchodů v deníku, počet otevřených pozic,
- cesta k terminálu, název úlohy v Plánovači, stav úlohy,
- zda bylo v terminálu zapnuté **Algo Trading** (jen si zapsat, neměnit),
- řádek z diagnostiky a všechna `UPOZORNĚNÍ`,
- stav kroku D (✔/✘ po bodech 1 až 4) a screenshoty,
- co se nepovedlo, přesné chybové hlášky a co jsi zkoušel.
Přilož `diag_report.json` obou účtů. **Neuváděj token ani cokoli, co vypadá jako `mt5_…`.**

## 6. Kdy se zastavit a zeptat

- Terminál je odhlášený a žádá heslo k účtu. Heslo nezadávej, požádej uživatele, ať se přihlásí sám, a pak pokračuj.
- Analyzer není přihlášený (Cloud sync) a nejde otevřít Trading deník bez přihlášení e-mailovým kódem.
- Zjistíš, že by pokračování vyžadovalo něco ze seznamu zakázaného (bod 2).
Ve všech ostatních případech řeš problém sám podle tabulky výše a pokračuj.

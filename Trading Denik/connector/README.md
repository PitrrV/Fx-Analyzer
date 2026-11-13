# MT5 konektor (jen čtení)

Malý program, který na počítači s MetaTrader 5 **čte** obchody, pozice a equity a posílá je zabezpečeně do tvého
Trading deníku v Analyzeru. **Nikdy neobchoduje, nemění SL/TP ani nezavírá pozice.** Kód používá jen obálku
`mt5_readonly.py`, která pustí pouze čtecí funkce MT5 (test `tests/test_readonly.py` hlídá, že se obchodní funkce nikde
neobjeví). Hesla k účtu nepotřebuje: připojí se k terminálu, který už je přihlášený.

## Instalace (Windows)
1. Nainstaluj Python 3.9+ a v příkazové řádce `pip install MetaTrader5`.
2. V Analyzeru otevři **Trading deník → MT5 deník → + Přidat MT5 účet**, zadej název a vytvoř účet. Zobrazí se **token (jen jednou)**.
3. Ulož token do proměnné prostředí (nikam jinam): `setx MT5_JOURNAL_TOKEN "mt5_…"` a otevři nové okno příkazové řádky.
4. Zkopíruj `config.example.json` na `config.json` a uprav `terminal_path` (cesta k `terminal64.exe`) a `state_file`.
5. Spusť MT5, přihlas se na účet. **Tlačítko Algo Trading nech vypnuté**: konektor ho nepotřebuje a je to druhá pojistka proti obchodování.
6. Zkouška: `python main.py --config config.json --once`. Má vypsat řádek `OK deals=…`. Obchody se objeví v Analyzeru.
7. Trvalý provoz: Plánovač úloh Windows → „Při přihlášení“ → `python main.py --config config.json` (bez `--once`).

## Více účtů
Jeden terminál MT5 = jeden účet. Pro další účet nainstaluj druhý terminál (portable), vytvoř v Analyzeru další účet a token,
a spusť druhý konektor s vlastním `config.json` (jiný `terminal_path`, `state_file` a proměnná s tokenem, `token_env`).
Každý token patří jen svému účtu, obchody se nikdy nesmíchají.

## Co se děje při výpadku
Kurzor (čas posledního potvrzeného dealu) se uloží až po potvrzení serverem. Po výpadku internetu nebo restartu se historie
přečte znovu od kurzoru, takže žádný obchod nechybí. Server je idempotentní, opakované odeslání nic nezdvojí.
Omezení: **změny SL/TP při vypnutém konektoru nelze zpětně zjistit** (MT5 je v historii neuchovává), uvidí se jen výsledná hodnota.

## Bezpečnost
Token je jen pro zápis dat tohoto jednoho účtu a v databázi je uložen jen jeho hash. Ztratil jsi ho nebo unikl? V Analyzeru klikni
u účtu na **Nový token** (starý okamžitě přestane platit) nebo **Vypnout sync**. Soubory `config.json` a `state*.json` jsou v `.gitignore`.
Pozor: prop firmy mívají pravidla o nástrojích třetích stran. Před nasazením na účet si ověř jejich podmínky.

## Testy
`python -m pytest tests` (běží na jakémkoli systému, používají falešný MT5, žádný skutečný terminál nepotřebují).

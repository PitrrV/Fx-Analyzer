# TradingView — architektonické místo, zatím bez implementace

Tento adresář je záměrně prázdný. TradingView je samostatná fáze a implementovat ho
naslepo by znamenalo vymyslet si rozhraní, které nikdo neověřil.

## Co se sem časem doplní

Nástroje ve stejném kontraktu jako všechny ostatní (`name` / `description` /
`inputSchema` / `permissions` / `execute`), pravděpodobně v tomto pořadí:

| Nástroj | Co dělá |
|---|---|
| `tradingview.read_chart` | Načte graf páru a timeframe a vrátí strojově čitelný popis |
| `tradingview.market_structure` | Rozpozná strukturu trhu (HH/HL/LH/LL, BOS, CHoCH) |
| `tradingview.zones` | Supply/demand zóny, order blocky, likvidita |
| `tradingview.draw` | Zakreslí zóny a úrovně zpět do grafu |

## Proč to ještě není

Čtení grafu není jeden problém, ale tři, a každý má jinou odpověď:

1. **Přístup k datům** — TradingView nemá veřejné API pro čtení uživatelského grafu.
   Reálné cesty jsou browser automation (Playwright), webhooky z Pine Script alertů,
   nebo screenshot + vision model. Volba téhle cesty určuje všechno ostatní.
2. **Reprezentace** — než agent zakreslí zónu, musí existovat dohodnutý datový tvar
   pro „zónu", „úroveň" a „strukturu". Ten tvar musí sedět na to, jak s technickou
   analýzou pracuje uživatel, ne na to, co je nejsnazší naprogramovat.
3. **Konfluence s fundamentem** — smysl téhle vrstvy je spojit technický obraz
   s FX Analyzerem. To předpokládá, že už funguje čtení výstupů Analyzeru
   (`fx_analyzer.*`), jinak není co s čím spojovat.

**Pořadí prací:** FX Analyzer napřed, TradingView potom.

## Jak se to zapojí, až přijde čas

Beze změny čehokoli existujícího:

1. nový soubor v tomto adresáři podle kontraktu v `../registry.mjs`,
2. jeden řádek v poli `MODULES` v `../registry.mjs`,
3. název nástroje do `tools.enabled` v `jarvis.config.json`.

Nástroje sahající na síť nebo spouštějící prohlížeč patří `permissions.level: "network"`
resp. `"execute"`; zápis do grafu je `destructive: true`, tedy s potvrzením.

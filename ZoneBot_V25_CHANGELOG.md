# ZoneBot V25 — změny oproti V24

Výchozí strategie, score systém, alerty i risk zůstávají beze změny.
Žádné nové RSI/EMA/trendové filtry. Přidáno 5 cílených úprav, **všechny
zapínatelné inputem**, ať jdou A/B testovat po jedné.

## Co je nového (a jak to vypnout)

| # | Úprava | Input(y) | Default | Nasazení |
|---|--------|----------|---------|----------|
| 1 | **Spread guard** — neotvírá tržní vstup při širokém spreadu | `UseSpreadGuard`, `MaxSpread_Pts=12` | ON | live-ready |
| 2 | **TP kvalita** — nepřijme zónovou TP horší než N×R, jinak fallback 1.5R | `MinZoneTP_RR=1.3` | 1.3 | test (1.0 = původní) |
| 3 | **Kratší kontext** — platnost setupu zkrácena (bylo natvrdo 36 = 9 h) | `Context_ValidBars=12` | 12 | test |
| 4 | **FVG u zóny** — FVG se akceptuje jen poblíž M15 zóny | `UseFVGNearZone` | ON | test |
| 5 | **Breakeven** — posun SL na entry po X×R | `UseBreakeven`, `Breakeven_At_R=1.0`, `Breakeven_Offset=2.0` | ON | test |

Navíc drobný **bugfix** v `EvaluateContext`: když je cena u demand i supply
zároveň (chop), short už tiše nepřepíše long setup i s jeho D1 checkem.

## Doporučený postup testování

1. Nech zapnutý jen **#1 (spread guard)** → ostatní vypni
   (`MinZoneTP_RR=1.0`, `Context_ValidBars=36`, `UseFVGNearZone=false`,
   `UseBreakeven=false`). To je baseline ≈ V24.
2. Zapínej změny **po jedné** na stejných datech jako poslední test
   a porovnávej Profit Factor + max DD.
3. Pozor: 58 obchodů je málo — ber výsledky orientačně, ne jako důkaz.
   Hlavně u #2 a #5 hlídej, ať PF neklesne.

## Jak rychle vrátit chování V24

```
UseSpreadGuard   = false
MinZoneTP_RR     = 1.0
Context_ValidBars= 36
UseFVGNearZone   = false
UseBreakeven     = false
```

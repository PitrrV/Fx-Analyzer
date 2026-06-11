# Technická specifikace — ORB‑930 (Opening Range Breakout, US100/NAS100)

Verze: 1.0 · Cílový jazyk: **MQL5 (MetaTrader 5)** · Soubor EA: `MQL5/Experts/ORB930.mq5`

---

## 1. Účel a princip

Intradenní **Opening Range Breakout** na US100/NAS100. Po US cash open (15:30 CET)
se sestaví úzký „opening range" (OR) z prvních X minut a obchoduje se **první
čistý breakout** tímto směrem. Edge = strukturální směrový tah po otevření trhu.

Design je záměrně **minimalistický**: čisté jádro + několik **vypnutelných**
filtrů (default OFF), aby se daly v Strategy Testeru ověřovat inkrementálně, ne
všechny najednou (ochrana proti přeoptimalizaci).

---

## 2. Instrument / timeframe / čas

| Položka | Hodnota |
|---|---|
| Instrument | US100 / NAS100 (CFD) |
| Primární TF | M5 (podporováno i M15) |
| Obchodní okno | 15:30–21:00 CET |
| Max obchodů/den | 1 |
| Risk/obchod | 0,5 % balance |

> **Čas:** všechny časové inputy jsou v **server time brokera**. Uživatel je
> nastaví tak, aby OR start odpovídal 15:30 CET (mnoho brokerů běží EET = UTC+2/+3,
> pak je 15:30 CET ≈ 16:30/17:30 server). Pozor na DST.

---

## 3. Definice opening range (OR)

1. OR start = `InpORStartHour:InpORStartMinute` (server).
2. OR délka = `InpORDurationMin` minut (default 15 → 3 svíčky M5).
3. Po dobu OR okna se akumuluje:
   - `ORhigh = max(High)` všech svíček, jejichž **open** spadá do OR okna,
   - `ORlow  = min(Low)` týchž svíček.
4. Jakmile čas dosáhne `OR start + délka`, OR se **uzamkne** (`g_orLocked`).

### Validace OR (chop filtr)
- `ORrange = ORhigh − ORlow`.
- OR je **platný** pouze pokud:
  `InpORrangeMinATR × ATR ≤ ORrange ≤ InpORrangeMaxATR × ATR`
  (default 0.5–2.5 × ATR(14)). Jinak se daný den **neobchoduje**.

---

## 4. Pravidla vstupu

Vyhodnocuje se na **uzavřené svíčce** (shift 1), pouze při:
- OR je uzamčený a platný,
- čas v okně `OR start … InpEntryCutoff` (default do 18:00),
- žádná otevřená naše pozice, `g_tradedToday == false`,
- nejsme v news‑block okně.

`buffer = InpBufferATR × ATR(14)` (default 0.10×).

| Směr | Podmínka |
|---|---|
| **BUY** | `Close[1] > ORhigh + buffer` (+ volitelně `Close[1] > EMA50`) |
| **SELL** | `Close[1] < ORlow − buffer` (+ volitelně `Close[1] < EMA50`) |

První splněná podmínka v daný den otevře obchod a uzamkne den (1 obchod/den).

---

## 5. Stop loss

| Směr | SL |
|---|---|
| BUY | `ORlow − buffer` |
| SELL | `ORhigh + buffer` |

Cap: pokud `InpSLcapATR > 0` a vzdálenost SL > `InpSLcapATR × ATR`, ořeže se
na tuto maximální vzdálenost (default 1.5×).

---

## 6. Take profit a řízení pozice

- `R = |entry − SL|` (počáteční riziko).
- **TP** = `InpTP_R × R` (default 2R).
- **Partial TP** (`InpUsePartialTP`, default ON): při dosažení `InpPartialTP_R × R`
  (default 1R) zavřít **50 %** pozice a posunout SL na **break‑even**.
- **Time‑stop** (`InpUseTimeStop`, default OFF): pokud po vstupu uběhne
  `InpTimeStopBars` svíček, pozici zavřít (ochrana proti chopu po vstupu).
- **Force close**: v `InpForceCloseHour:Min` (default 21:00) zavřít vše.

Zakázáno (dle zadání): martingale, grid, navyšování ztrátových pozic.

---

## 7. Money management (sizing)

```
riskMoney  = balance × InpRiskPercent / 100
valuePerPricePerLot = TICK_VALUE / TICK_SIZE
riskPerLot = slDistance(price) × valuePerPricePerLot
lots       = riskMoney / riskPerLot   → zaokrouhleno dolů na VOLUME_STEP,
             ořezáno do [VOLUME_MIN, VOLUME_MAX]
```

---

## 8. News filtr

Deterministický a testovatelný: `InpNewsBlocks` = čárkou oddělená server‑time
okna `HH:MM-HH:MM` (např. `"14:28-14:33,15:58-16:03"`). V těchto oknech se
neotevírá nová pozice. Prázdný string = filtr vypnutý.

---

## 9. Kdy NEobchodovat

- OR neplatný (příliš úzký = chop, příliš široký = vyjeté).
- Breakout přijde až po `InpEntryCutoff`.
- V news‑block okně.
- Po vyčerpání 1 obchodu/den.

---

## 10. Inputy (přehled)

| Input | Default | Význam |
|---|---|---|
| InpRiskPercent | 0.5 | Risk na obchod (%) |
| InpMagic | 930930 | Magic number |
| InpORStartHour/Minute | 15 / 30 | Začátek OR (server) |
| InpORDurationMin | 15 | Délka OR (min) |
| InpEntryCutoffHour/Min | 18 / 0 | Konec vstupů |
| InpForceCloseHour/Min | 21 / 0 | Force close |
| InpATRPeriod | 14 | ATR perioda |
| InpBufferATR | 0.10 | Buffer = x×ATR |
| InpORrangeMinATR / MaxATR | 0.5 / 2.5 | Chop / over‑extended filtr |
| InpSLcapATR | 1.5 | Cap SL (0=off) |
| InpTP_R | 2.0 | TP v R |
| InpUsePartialTP | true | Částečný TP + BE |
| InpPartialTP_R | 1.0 | Úroveň částečného TP (R) |
| InpUseEMAfilter | false | EMA směrový filtr |
| InpEMAperiod | 50 | EMA perioda |
| InpUseTimeStop | false | Time‑stop |
| InpTimeStopBars | 12 | Svíčky do time‑stopu |
| InpNewsBlocks | "" | News okna |

---

## 11. Test plán (pořadí)

1. **Baseline** (vše volitelné OFF): OR=15, buffer=0.10, TP=2R, partial ON.
   Změřit počet obchodů, expectancy (R), profit factor, max DD.
2. In‑sample 2022–2023, **out‑of‑sample 2024–2025 nedotčené**.
3. Robustnost: ±20 % na `InpBufferATR` a `InpORDurationMin` nesmí převrátit
   ziskovost. Hledat **plató**, ne špičku.
4. Teprve pak inkrementálně zapínat EMA filtr / time‑stop a měřit přínos.

> Pozn.: EA nebyl kompilován v tomto prostředí (chybí MetaEditor). Před
> ostrým během zkompilovat v MetaEditoru a proběhnout v Strategy Testeru.

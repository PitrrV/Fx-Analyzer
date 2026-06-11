# ORB‑930 v2 — instalace a test v MT5

## 1. Zkopíruj soubory do MetaTrader 5

V MT5: **File → Open Data Folder**, pak vlož:

| Soubor z repa | Kam v MT5 data folderu |
|---|---|
| `MQL5/Experts/ORB930.mq5` | `MQL5/Experts/ORB930.mq5` |
| `MQL5/Presets/ORB930.set` | `MQL5/Presets/ORB930.set` |

## 2. Zkompiluj

Otevři `ORB930.mq5` v **MetaEditoru** → **Compile** (F7). Musí projít **0 errors**.
(V tomto prostředí nešlo kompilovat — chybí MetaEditor — proto zkompiluj u sebe.)

## 3. Strategy Tester (Ctrl+R)

- **Expert:** ORB930
- **Symbol:** US100 / NAS100 (přesný název dle tvého brokera)
- **Timeframe:** M5 (primární) — vyzkoušej i M15
- **Modelling:** **Every tick based on real ticks** (nejpřesnější)
- **Inputs → Load:** `ORB930.set`
- **Deposit:** reálná velikost účtu, **Leverage** dle brokera

## 4. ⚠️ Nastav čas podle svého brokera (kritické!)

Inputy `InpORStartHour/Minute` jsou v **server time brokera**, ne CET.
Musí odpovídat **15:30 CET** (US cash open).

- Broker v **CET** → nech `15:30`.
- Broker v **EET (UTC+2/+3)** → typicky `16:30` (zima) / `16:30`–`17:30`; ověř.
- Pozor na **letní/zimní čas (DST)** — offset se může v roce měnit.

Rychlý test: na grafu najdi svíčku odpovídající 15:30 CET a porovnej s časem serveru
(roh grafu / Market Watch).

## 5. První běh = baseline (bez optimalizace)

Nech defaulty. Sleduj:
- **počet obchodů** (málo = nespolehlivý vzorek),
- **profit factor**, **expectancy**,
- **max drawdown** a jeho délku.

Pokročilé filtry (`InpUseEMAfilter`, `InpUseTimeStop`) nech zatím **OFF** a zapínej
je až inkrementálně. Detailní postup: `docs/long-term-profitability.md`.

## 6. Než pustíš naživo

Demo / malý živý účet 1–3 měsíce, porovnej slippage backtest vs live.

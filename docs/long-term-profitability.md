# Cesta k dlouhodobé profitabilitě — ORB‑930 (a obecně)

> Poctivě: **žádný EA negarantuje zisk.** Dlouhodobou profitabilitu nedělá „lepší
> vstup", ale **robustnost + ochrana kapitálu + validace + diverzifikace**.
> Tento dokument je plán, jak k tomu dojít, ne slib výnosu.

---

## 1. Co v ORB‑930 v2 chrání kapitál (a proč na tom záleží nejvíc)

| Vrstva | Input | Proč rozhoduje o přežití |
|---|---|---|
| Equity drawdown guard | `InpMaxEquityDD_Pct` (12 %) | Tvrdě zastaví obchodování při poklesu z peaku → ochrana proti smrtelné sérii / rozbitému režimu. Vyžaduje manuální restart (záměrně). |
| Cooldown po sérii ztrát | `InpMaxConsecLossDays` (3) + `InpCooldownDays` (2) | Když strategie přestane fungovat (změna režimu), pauza místo „obchodování do nuly". |
| Spread filtr | `InpMaxSpreadPoints` (60) | Reálná frikce; brání vstupům za nevýhodných podmínek. |
| Risk z equity | `InpRiskFromEquity` | Sizing klesá s drawdownem → přirozená anti‑ruin geometrie (žádný martingale). |
| Trailing runneru | `InpUseTrailing` | Nechává zisky běžet → zlepšuje expectancy bez zvyšování rizika. |

> **Matematika přežití:** při 0,5 % riziku/obchod a max 1 obchodu/den je teoretický
> risk‑of‑ruin extrémně nízký i při dlouhé sérii ztrát. To je hlavní důvod, proč
> tahle konfigurace dává smysl pro *složené* dlouhodobé zhodnocení.

---

## 2. Validační protokol (než to pustíš naživo)

1. **Datová kvalita:** US100 M5, kvalitní tick data (Dukascopy / broker), reálný
   spread + komise. Nikdy „every tick (based on real ticks)" vynechat.
2. **Baseline bez optimalizace:** defaulty, advanced filtry OFF. Změřit:
   počet obchodů, expectancy (R), profit factor, max DD, délka DD.
3. **In‑sample vs out‑of‑sample:** optimalizuj (hrubě) na 2022–2023,
   **2024–2025 nech nedotčené** jako finální test.
4. **Walk‑forward:** posuvné okno (např. 12 měsíců train / 3 měsíce test),
   sleduj stabilitu napříč okny, ne jednu hezkou křivku.
5. **Robustnost parametrů:** ±20 % na `InpBufferATR` a `InpORDurationMin`
   nesmí převrátit ziskovost. Hledej **plató**, ne špičku. Špička = curve‑fit.
6. **Monte Carlo / náhodné pořadí obchodů:** odhadni rozdělení max DD a
   pravděpodobnost ruinu, ne jen jeden scénář.
7. **Akceptační kritéria (návrh):** PF > 1.3 OOS, max DD < 2× roční výnos,
   ≥ 100 obchodů, edge přítomný napříč ≥ 60 % walk‑forward oken.

---

## 3. Nasazení a provoz

- **Demo / malý živý účet 1–3 měsíce** před plnou velikostí — sleduj slippage
  a rozdíl backtest vs live.
- **Server time + DST:** zkontroluj, že OR start reálně sedí na 15:30 CET v každém
  ročním období (broker EET se mění; uprav inputy při přechodu na/z letního času).
- **Měsíční review:** porovnej živé statistiky s backtestem; odchylka =
  signál degradace edge, ne důvod ladit parametry.

---

## 4. Skutečné „nejlepší řešení" = diverzifikace (další krok)

Jeden intradenní setup je vždy zranitelný vůči režimu trhu. Dlouhodobě nejstabilnější
equity křivku dělá **portfolio nekorelovaných edge**:

1. **ORB‑930** (momentum/breakout) — vydělává v trend‑drive dnech.
2. **VWAP‑Fade** (mean reversion) — vydělává v range dnech (kdy ORB ztrácí).
3. **Squeeze‑Pop** (volatility expansion) — vydělává při změně volatility.

Tyto tři mají **různý profil P/L napříč režimy** → kombinace vyhladí drawdowny.
Doporučený postup: každou samostatně zvalidovat dle kap. 2, pak alokovat
risk mezi ně (např. 0,5 % každá, ale ne víc než 1 % celkem otevřeného rizika denně).

> Tohle je obvykle větší přínos pro dlouhodobou profitabilitu než jakákoli další
> optimalizace jednoho EA.

---

## 5. Co NEdělat (nejčastější cesty ke ztrátě účtu)

- Optimalizovat na špičku metrik (curve‑fit) místo plató.
- Zvyšovat risk po sérii ztrát (revenge / martingale) — v EA tvrdě zakázáno.
- Vypnout drawdown guard „protože to zrovna jede".
- Věřit backtestu bez out‑of‑sample a reálných nákladů.
- Ladit parametry po každém ztrátovém týdnu místo měsíčního review.

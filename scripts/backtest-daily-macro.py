#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Kandidáti na "co by mohlo dávat smysl v denní/24h změně" (na rozdíl od
COT/kalendáře/retailu, tohle jsou složky, co SKUTEČNĚ mají denní frekvenci
v datech, co už appka/projekt má): VIX, DXY (broad dolarový index), WTI ropa,
zlato, US 2Y výnos. Testuje se 1denní a 3denní změna proti výnosu páru/koše
1 a 3 dny dopředu, per měna — stejná Spearman IC + bootstrap p + FDR korekce
metodika jako zbytek projektu, jen na denní (ne týdenní) frekvenci.

VÝSLEDEK JE NEPOUŽITELNÝ — ponecháno jen jako záznam, PROČ. Diagnostika
(IC signálu proti SOUČASNÉMU dni vs. den+1 vs. den+2) ukázala typický obraz
posunuté časové značky mezi zdroji: IC 0.36 (dnes) → 0.22 (zítra) → 0.02
(pozítří) — reálný prediktivní efekt takhle strmě a plynule nedoznívá,
tohle je otisk toho, že FRED denní hodnota (VIX/DXY/…) a fx_daily close
nejsou zarovnané na stejnou tržní uzávěrku (jiný zdroj, jiná časová zóna).
Oprava by vyžadovala FX i makro data ze STEJNÉHO zdroje se stejným
uzávěrkovým časem — to v tomhle prostředí nemáme. Týdenní verze (VIX zóna
pro AUD/GBP) tímhle netrpí — týdenní resampling (pátek-na-pátek) přesah
mezi zdroji zahladí, proto ta už dřív prošla auditem v pořádku."""
import importlib.util, os, json
import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(__file__))
spec = importlib.util.spec_from_file_location("ra", os.path.join(os.path.dirname(__file__), "research-audit.py"))
ra = importlib.util.module_from_spec(spec); spec.loader.exec_module(ra)
CUR, PAIRS = ra.CUR, ra.PAIRS


def load_daily_basket():
    daily = {}
    for p in PAIRS:
        d = json.load(open(os.path.join(ROOT, f"data/fx_daily/{p}.json")))
        s = pd.Series(d["closes"], index=pd.to_datetime(d["dates"]))
        daily[p] = s[~s.index.duplicated()].sort_index()
    px = pd.DataFrame(daily).sort_index()
    ret = np.log(px).diff()
    basket = {}
    for c in CUR:
        cols = []
        for p in PAIRS:
            b, q = p[:3], p[3:]
            if b == c: cols.append(ret[p])
            elif q == c: cols.append(-ret[p])
        basket[c] = pd.concat(cols, axis=1).mean(axis=1)
    return pd.DataFrame(basket)


def fred_series(key):
    fred = json.load(open(os.path.join(ROOT, "data/research/fred.json")))
    rows = fred.get(key) or []
    s = pd.Series([r["v"] for r in rows], index=pd.to_datetime([r["d"] for r in rows]))
    return s[~s.index.duplicated()].sort_index()


def main():
    print("Načítám denní ceny + FRED…")
    bk = load_daily_basket()
    idx = bk.index

    vix = fred_series("vix").reindex(idx).ffill(limit=3)
    dxy = fred_series("dxy_broad").reindex(idx).ffill(limit=3)
    wti = fred_series("wti").reindex(idx).ffill(limit=3)
    gold_raw = json.load(open(os.path.join(ROOT, "data/research/gold.json")))
    gold = pd.Series([r["v"] for r in gold_raw], index=pd.to_datetime([r["d"] for r in gold_raw]))
    gold = gold[~gold.index.duplicated()].sort_index().reindex(idx).ffill(limit=3)
    us2y = fred_series("us2y").reindex(idx).ffill(limit=3)

    factors = {}
    for lb in (1, 3):
        factors[f"vix_d{lb}"] = vix.diff(lb)                          # body VIX
        factors[f"dxy_d{lb}"] = np.log(dxy).diff(lb)                  # log-návratnost
        factors[f"wti_d{lb}"] = wti.diff(lb) / wti.shift(lb)          # % změna (ne log, WTI umí i záporné)
        factors[f"gold_d{lb}"] = np.log(gold).diff(lb)
        factors[f"us2y_d{lb}"] = us2y.diff(lb)                        # bps

    fwd = {h: bk[::-1].rolling(h).sum()[::-1].shift(-1) for h in (1, 3)}

    # Diagnostika zarovnání zdrojů: IC signálu (den t) proti výnosu SAME/t+1/t+2.
    # Skutečný prediktivní efekt nemizí takhle strmě — pokud IC(same)>>IC(t+1)>>IC(t+2)
    # ve stejném poměru jako autokorelace samotného zpoždění, je to otisk posunuté
    # časové značky mezi zdroji (FRED vs. fx_daily), ne edge.
    from scipy.stats import spearmanr
    print("=== Diagnostika: same-day vs t+1 vs t+2 (test na zarovnání zdrojů) ===")
    diag_bad = False
    for fname, fs in [("dxy_d1", np.log(dxy).diff(1)), ("vix_d1", vix.diff(1))]:
        same = bk["USD"] if "dxy" in fname else bk["AUD"]
        for lbl, tgt in [("same-day", same), ("t+1", same.shift(-1)), ("t+2", same.shift(-2))]:
            df = pd.concat([fs, tgt], axis=1, keys=["s", "f"]).dropna()
            ic, _ = spearmanr(df["s"], df["f"])
            print(f"  {fname} vs {lbl}: IC={ic:+.4f} n={len(df)}")
        print()
    print("Pokud IC(same-day) výrazně > IC(t+1) a IC(t+2)~0 → zdroje nejsou zarovnané,")
    print("výsledky níže NEPOUŽÍVAT jako důkaz prediktivity (jen jako záznam pokusu).\n")

    print("=== Denní makro-faktory vs. krátký fwd výnos (Spearman IC, bootstrap p) ===")
    results = {}
    for fname, fs in factors.items():
        for h in (1, 3):
            for c in CUR:
                r = ra.eval_factor(fs, fwd[h][c])
                if r: results[f"{c}:{fname}_fwd{h}d"] = r

    rows = sorted(results.items(), key=lambda kv: -abs(kv[1]["ic"]))
    print(f"{'signál':26s} | {'n':>6s} | {'IC':>7s} | {'p_boot':>7s} | {'PF':>6s} | robustní")
    for key, r in rows[:30]:
        print(f"{key:26s} | {r['n']:6d} | {r['ic']:+7.4f} | {str(r['p_boot']):>7s} | {str(r['pf_sign']):>6s} | {r['robust']}")
    print(f"… ({len(rows)} testů celkem, top 30 podle |IC| zobrazeno)")

    pvals = [(k, r["p_boot"]) for k, r in results.items() if r["p_boot"] is not None]
    pvals.sort(key=lambda x: x[1])
    m = len(pvals)
    survivors = []
    for i, (k, p) in enumerate(pvals):
        if p <= (i + 1) / m * 0.20: survivors.append(k)
        else: break
    print(f"\nPo FDR korekci (q=0.20, {m} testů): {len(survivors)} přežije")
    for k in survivors:
        print(f"  ★ {k}: IC={results[k]['ic']:+.4f} p_boot={results[k]['p_boot']} PF={results[k]['pf_sign']}")

    json.dump({"results": results, "fdr_survivors_q20": survivors,
               "methodology": "denní VIX/DXY/WTI/zlato/US2y změna (1d,3d) vs fwd basket return (1d,3d) per měna, eval_factor stejně jako research-audit.py, FDR q=0.20 přes všechny testy."},
              open(os.path.join(ROOT, "data/research/daily_macro_backtest.json"), "w"), ensure_ascii=False, indent=1)
    print("\nOK -> data/research/daily_macro_backtest.json")


if __name__ == "__main__":
    main()

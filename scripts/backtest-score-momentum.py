#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Je ZMĚNA composite skóre (to, co appka ukazuje jako "24h vývoj"/momentum)
sama o sobě validní signál, nebo šum?

Metoda: appka umí denně přepočítat skóre jen z toho, co má denní/týdenní
frekvenci (COT týdně, fundament z kalendáře, retail). Kalendářová a retailová
historie jsou příliš krátké na víceletý test (stejný důvod jako u
backtest-coach-playbook.py), takže tu sestavíme PROXY composite skóre jen
z dlouze-historických složek, které appka taky používá:
  - COT blend 70% Leveraged Funds + 30% Asset Managers (net ratio)
  - "fund" proxy = průměr z-skóre real yield diff, CPI akcelerace, 3M carry
  - sezónnost (walk-forward, stejná metoda jako research-audit.py)
Váhy přibližně podle engine.js getDynamicWeights (fund ~0.53, cot ~0.45,
sezónnost ~0.02 — sentiment/retail vynechán, protože ho nejde rekonstruovat
historicky, váhy přeškálovány aby dali dohromady 1). NENÍ to identická
appčina live hodnota (chybí kalendářová fundamentální složka a retail) —
je to nejlepší dostupná aproximace na dlouhé historii, ne přesná replika.

Test: koreluje TÝDENNÍ ZMĚNA (Δ1/Δ2/Δ4 týdny) tohohle proxy skóre s
budoucím výnosem (1 a 4 týdny dopředu)? Kladné IC = momentum (změna
pokračuje), záporné IC = mean-reversion (změna se otáčí), |IC|~0 = šum.
Stejná statistická mašinerie jako research-audit.py (Spearman IC + moving-
block bootstrap p-hodnota + shoda znaménka napříč subperiodami)."""
import importlib.util, os
import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(__file__))
spec = importlib.util.spec_from_file_location("ra", os.path.join(os.path.dirname(__file__), "research-audit.py"))
ra = importlib.util.module_from_spec(spec); spec.loader.exec_module(ra)

CUR = ra.CUR


def expand_z(s, min_periods=52):
    """Expanding z-score (jen minulost, žádný look-ahead) — srovnatelné měřítko
    napříč složkami bez ohledu na jejich přirozené jednotky (%, ratio, bps…)."""
    m = s.expanding(min_periods=min_periods).mean()
    sd = s.expanding(min_periods=min_periods).std()
    return (s - m) / sd.replace(0, np.nan)


def main():
    print("Načítám ceny/FRED/COT/panel…")
    wk, pret, bk = ra.build_prices()
    fred = ra.build_fred()
    cot = ra.build_cot()
    F = ra.build_panel(bk, fred, cot)
    idx = F["vix_lvl"].index

    cot_blend = 0.70 * F["cot_lev"] + 0.30 * F["cot_am"]

    proxy = {}
    for c in CUR:
        cot_z = expand_z(cot_blend[c]) if c in cot_blend.columns else pd.Series(np.nan, index=idx)
        fund_parts = []
        for k in ["realyield", "cpi_accel", "carry3m"]:
            if c in F[k].columns:
                fund_parts.append(expand_z(F[k][c]))
        fund_z = pd.concat(fund_parts, axis=1).mean(axis=1) if fund_parts else pd.Series(np.nan, index=idx)
        seas_z = expand_z(F["seasonal_wf"][c]) if c in F["seasonal_wf"].columns else pd.Series(np.nan, index=idx)
        proxy[c] = 0.45 * cot_z + 0.53 * fund_z + 0.02 * seas_z
    proxy_df = pd.DataFrame(proxy)

    fwd = {h: bk[::-1].rolling(h).sum()[::-1].shift(-1) for h in (1, 4)}

    print("\n=== Je Δ proxy-skóre prediktivní, nebo šum? (Spearman IC, bootstrap p, sub-shoda) ===")
    results = {}
    for lookback in (1, 2, 4):
        delta = proxy_df.diff(lookback)
        for h in (1, 4):
            for c in CUR:
                if c not in delta.columns: continue
                r = ra.eval_factor(delta[c], fwd[h][c])
                if r:
                    key = f"{c}:delta{lookback}wk_fwd{h}wk"
                    results[key] = r

    rows = sorted(results.items(), key=lambda kv: -abs(kv[1]["ic"]))
    print(f"{'signál':32s} | {'n':>5s} | {'IC':>7s} | {'p_boot':>7s} | {'PF(sign)':>9s} | robustní")
    for key, r in rows:
        print(f"{key:32s} | {r['n']:5d} | {r['ic']:+7.4f} | {str(r['p_boot']):>7s} | {str(r['pf_sign']):>9s} | {r['robust']}")

    robust_hits = [k for k, r in results.items() if r["robust"]]
    print(f"\nRobustních (shoda ≥3/4 subperiod, |IC|≥0.03, bootstrap p<0.10) BEZ multiple-testing korekce: {len(robust_hits)}/{len(results)}")
    for k in robust_hits:
        print(f"  → {k}: IC={results[k]['ic']:+.4f} PF={results[k]['pf_sign']}")

    # FDR korekce (stejná jako counter-audit-fdr.py) — s tolika testy (3 lookback x 2 horizon x 8 měn = 48) je multiple-testing riziko reálné
    pvals = [(k, r["p_boot"]) for k, r in results.items() if r["p_boot"] is not None]
    pvals.sort(key=lambda x: x[1])
    m = len(pvals)
    fdr_survivors = []
    for i, (k, p) in enumerate(pvals):
        thresh = (i + 1) / m * 0.20
        if p <= thresh:
            fdr_survivors.append(k)
        else:
            break
    print(f"\nPo Benjamini-Hochberg FDR korekci (q=0.20, {m} testů): {len(fdr_survivors)} přežije")
    for k in fdr_survivors:
        print(f"  ★ {k}: IC={results[k]['ic']:+.4f} p_boot={results[k]['p_boot']}")

    import json
    json.dump({"results": results, "robust_uncorrected": robust_hits, "fdr_survivors_q20": fdr_survivors,
               "methodology": "proxy composite skóre (COT blend 70/30 + fund proxy [realyield,cpi_accel,carry3m z-score] + sezónnost, váhy 0.45/0.53/0.02) — BEZ kalendářní fundament složky a retailu (krátká historie). Δ skóre (1/2/4t) testováno proti fwd výnosu (1/4t) přes eval_factor stejnou metodou jako research-audit.py."},
              open(os.path.join(ROOT, "data/research/score_momentum_backtest.json"), "w"), ensure_ascii=False, indent=1)
    print("\nOK -> data/research/score_momentum_backtest.json")


if __name__ == "__main__":
    main()

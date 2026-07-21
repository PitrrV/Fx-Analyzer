#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Uživatelův nápad: COT (velcí hráči) long, retail short (nebo obráceně) —
čím větší rozestup, tím silnější signál JÍT SE SMĚREM COT. Legacy COT report
má od ~1986 i "non-reportable" pozice (malí obchodníci pod reportovacím
prahem) — veřejná, dlouhodobá proxy pro retail (appka sama tohle použije
jako primární retail zdroj, viz fetchRetailSentiment v engine.js — jen z
appčiny LOKÁLNÍ historie, tady z CFTC napřímo a 20+ let zpátky).

Signál = (non-commercial net ratio) − (non-reportable net ratio), tj. jak
moc jdou COT a retail proti sobě. Continuous, žádný předem vymyšlený práh —
necháme Spearman IC ukázat, jestli velikost rozestupu vůbec něco predikuje."""
import importlib.util, os, json
import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(__file__))
spec = importlib.util.spec_from_file_location("ra", os.path.join(os.path.dirname(__file__), "research-audit.py"))
ra = importlib.util.module_from_spec(spec); spec.loader.exec_module(ra)
CUR = ra.CUR


def main():
    print("Načítám ceny + COT legacy (vč. non-reportable)…")
    wk, pret, bk = ra.build_prices()
    legacy = json.load(open(os.path.join(ROOT, "data/research/cot_legacy.json")))

    def to_weekly_ratio(rows, long_key, short_key):
        df = pd.DataFrame(rows)
        df["d"] = pd.to_datetime(df["d"])
        df = df.sort_values("d").drop_duplicates("d", keep="last").set_index("d")
        oi = df["oi"].replace(0, np.nan)
        ratio = (df[long_key] - df[short_key]) / oi
        return ratio.resample("W-FRI").last().ffill(limit=3).shift(1)  # +1 týden publikační lag, stejně jako build_cot()

    cot_ratio, retail_ratio, div = {}, {}, {}
    for c in CUR:
        rows = legacy.get(c)
        if not rows: continue
        cot_ratio[c] = to_weekly_ratio(rows, "ncl", "ncs")
        retail_ratio[c] = to_weekly_ratio(rows, "nrl", "nrs")
    cot_df = pd.DataFrame(cot_ratio).reindex(bk.index)
    retail_df = pd.DataFrame(retail_ratio).reindex(bk.index)
    div_df = cot_df - retail_df   # kladné = COT long / retail short (nebo méně long)

    fwd = {h: bk[::-1].rolling(h).sum()[::-1].shift(-1) for h in (1, 4)}

    print("\n=== COT−retail rozestup vs. fwd výnos (sázka SE SMĚREM COT) ===")
    results = {}
    for c in CUR:
        if c not in div_df.columns: continue
        for h in (1, 4):
            r = ra.eval_factor(div_df[c], fwd[h][c])
            if r: results[f"{c}:cot_retail_div_h{h}"] = r

    rows = sorted(results.items(), key=lambda kv: -abs(kv[1]["ic"]))
    print(f"{'signál':28s} | {'n':>5s} | {'IC':>7s} | {'p_boot':>7s} | {'PF':>6s} | robustní")
    for key, r in rows:
        print(f"{key:28s} | {r['n']:5d} | {r['ic']:+7.4f} | {str(r['p_boot']):>7s} | {str(r['pf_sign']):>6s} | {r['robust']}")

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

    # bonus: JEN extrémní rozestup (top/bottom 15% percentil) — win rate/PF jak by appka tuhle myšlenku reálně ukázala
    print("\n=== Bonus: jen týdny s EXTRÉMNÍM rozestupem (top/bottom 15 %, sázka se směrem COT), h4 ===")
    extreme_summary = {}
    for c in CUR:
        if c not in div_df.columns: continue
        s = div_df[c].dropna()
        if len(s) < 60: continue
        hi, lo = s.quantile(0.85), s.quantile(0.15)
        sig_dates = s[(s >= hi) | (s <= lo)].index
        f = fwd[4][c].reindex(sig_dates).dropna()
        d = div_df[c].reindex(f.index)
        dirn = np.sign(d)
        rets = dirn * f
        rets = rets.dropna()
        if len(rets) < 15: continue
        wr = round((rets > 0).mean() * 100, 1)
        gp = rets[rets > 0].sum(); gl = -rets[rets < 0].sum()
        pf = round(float(gp / gl), 3) if gl > 0 else None
        extreme_summary[c] = {"n": len(rets), "win_rate": wr, "pf": pf}
        print(f"  {c}: n={len(rets)} win_rate={wr}% PF={pf}")

    json.dump({"results": results, "fdr_survivors_q20": survivors, "extreme_divergence_bonus": extreme_summary,
               "methodology": "signal = non-commercial net ratio − non-reportable(retail proxy) net ratio, +1 týden publikační lag, sázka se směrem COT (large speculators), fwd 1/4 týdny, eval_factor stejně jako research-audit.py, FDR q=0.20."},
              open(os.path.join(ROOT, "data/research/cot_retail_divergence_backtest.json"), "w"), ensure_ascii=False, indent=1)
    print("\nOK -> data/research/cot_retail_divergence_backtest.json")


if __name__ == "__main__":
    main()

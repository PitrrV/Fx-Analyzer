#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Protiaudit krok 4: pořádný test lineárního IC-modelu vs Random Forest /
XGBoost s PURGED walk-forward CV (ne obyčejné K-fold, které by protékalo
informací přes autokorelovaná okna forward returnů). Cíl: ověřit tvrzení
z architektonického auditu "RF nepřinesl OOS zlepšení" místo ho jen tvrdit."""
import importlib.util, os, json
import numpy as np, pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import LinearRegression
from scipy.stats import spearmanr
try:
    from xgboost import XGBRegressor
    HAS_XGB = True
except Exception:
    HAS_XGB = False

spec = importlib.util.spec_from_file_location("ra", os.path.join(os.path.dirname(__file__), "research-audit.py"))
ra = importlib.util.module_from_spec(spec); spec.loader.exec_module(ra)

wk, pret, bk = ra.build_prices()
fred = ra.build_fred()
cot = ra.build_cot()
F = ra.build_panel(bk, fred, cot)
fwd4 = {c: bk[c][::-1].rolling(4).sum()[::-1].shift(-1) for c in ra.CUR}

FACTORS = ["carry3m","y10diff","realyield","cpi_accel","cot_nc","cot_comm","cot_dealer","cot_am","cot_lev",
           "mom4","mom12","vol4","vix_lvl","vix_chg4","oil_r4","gold_r4","copper_r4","dxy_r4","seasonal_wf"]

def purged_kfold_splits(n, k=6, embargo=10):
    """K souvislých bloků; pro test blok i se z train odstraní pozorování
    v okně [test_start-embargo, test_end+embargo] (purge+embargo obou stran,
    kvůli 4týdenním forward-return oknům, co by jinak unikaly přes hranici)."""
    fold_size = n // k
    splits = []
    for i in range(k):
        test_start = i * fold_size
        test_end = n if i == k - 1 else (i + 1) * fold_size
        train_idx = [j for j in range(n) if j < test_start - embargo or j > test_end + embargo]
        test_idx = list(range(test_start, test_end))
        if len(train_idx) > 100 and len(test_idx) > 20:
            splits.append((train_idx, test_idx))
    return splits

def eval_ccy(ccy):
    X = pd.concat({f: F[f][ccy] for f in FACTORS if ccy in F[f].columns}, axis=1)
    y = fwd4[ccy]
    df = pd.concat([X, y.rename("y")], axis=1).dropna()
    if len(df) < 200: return None
    Xv, yv = df.drop(columns=["y"]).values, df["y"].values
    n = len(df)
    splits = purged_kfold_splits(n, k=6, embargo=10)

    lin_preds, rf_preds, xgb_preds, actuals = [], [], [], []
    for train_idx, test_idx in splits:
        Xtr, ytr = Xv[train_idx], yv[train_idx]
        Xte, yte = Xv[test_idx], yv[test_idx]
        lin = LinearRegression().fit(Xtr, ytr)
        lin_preds.extend(lin.predict(Xte)); actuals.extend(yte)
        rf = RandomForestRegressor(n_estimators=200, max_depth=4, min_samples_leaf=20, random_state=42, n_jobs=-1).fit(Xtr, ytr)
        rf_preds.extend(rf.predict(Xte))
        if HAS_XGB:
            xg = XGBRegressor(n_estimators=150, max_depth=3, learning_rate=0.05, min_child_weight=15,
                               subsample=0.8, colsample_bytree=0.8, random_state=42, verbosity=0).fit(Xtr, ytr)
            xgb_preds.extend(xg.predict(Xte))

    def ic_of(preds):
        r, _ = spearmanr(preds, actuals); return round(float(r), 3)
    def pf_of(preds):
        preds = np.array(preds); acts = np.array(actuals)
        ret = np.sign(preds) * acts
        gp = ret[ret > 0].sum(); gl = -ret[ret < 0].sum()
        return round(float(gp / gl), 3) if gl > 0 else None

    row = {"n": n, "n_folds": len(splits),
           "linear": {"ic": ic_of(lin_preds), "pf": pf_of(lin_preds)},
           "rf": {"ic": ic_of(rf_preds), "pf": pf_of(rf_preds)}}
    if HAS_XGB: row["xgb"] = {"ic": ic_of(xgb_preds), "pf": pf_of(xgb_preds)}
    return row

print(f"{'Měna':5s} | {'n':>5s} {'folds':>6s} | {'Linear IC/PF':>16s} | {'RandomForest IC/PF':>18s} | {'XGBoost IC/PF':>16s}")
results = {}
for c in ra.CUR:
    r = eval_ccy(c)
    if not r: continue
    results[c] = r
    xg = r.get("xgb", {"ic": None, "pf": None})
    print(f"{c:5s} | {r['n']:5d} {r['n_folds']:6d} | {r['linear']['ic']:+.3f}/{str(r['linear']['pf']):>6s} | "
          f"{r['rf']['ic']:+.3f}/{str(r['rf']['pf']):>7s} | {(str(xg['ic'])+'/'+str(xg['pf'])) if xg['ic'] is not None else 'n/a':>16s}")

lin_avg = np.mean([r["linear"]["ic"] for r in results.values()])
rf_avg = np.mean([r["rf"]["ic"] for r in results.values()])
print(f"\nPrůměr IC napříč měnami (purged 6-fold CV): Linear={lin_avg:.3f}  RandomForest={rf_avg:.3f}")
if HAS_XGB:
    xgb_avg = np.mean([r["xgb"]["ic"] for r in results.values() if "xgb" in r])
    print(f"XGBoost={xgb_avg:.3f}")

json.dump({"results": results, "summary": {"linear_avg_ic": float(lin_avg), "rf_avg_ic": float(rf_avg)}},
          open(os.path.join(os.path.dirname(__file__), "..", "data/research/ml_comparison.json"), "w"),
          ensure_ascii=False, indent=1)
print("\nOK -> data/research/ml_comparison.json")

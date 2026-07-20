#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Protiaudit krok 5: Model A (per-currency) vs Model B (per-pair) vs
Model C (hybrid = per-currency + pár korekcí) — reálné OOS srovnání
přes purged walk-forward, ne teoretická úvaha."""
import importlib.util, os, json
import numpy as np, pandas as pd
from sklearn.linear_model import LinearRegression
from scipy.stats import spearmanr

spec = importlib.util.spec_from_file_location("ra", os.path.join(os.path.dirname(__file__), "research-audit.py"))
ra = importlib.util.module_from_spec(spec); spec.loader.exec_module(ra)

wk, pret, bk = ra.build_prices()
fred = ra.build_fred()
cot = ra.build_cot()
F = ra.build_panel(bk, fred, cot)
FACTORS = ["carry3m","y10diff","realyield","cpi_accel","cot_nc","cot_comm","cot_dealer","cot_am",
           "mom4","vol4","vix_lvl","vix_chg4","oil_r4","dxy_r4"]

def purged_splits(n, k=6, embargo=10):
    fold = n // k; out = []
    for i in range(k):
        ts, te = i*fold, (n if i==k-1 else (i+1)*fold)
        tr = [j for j in range(n) if j < ts-embargo or j > te+embargo]
        if len(tr) > 100 and te-ts > 20: out.append((tr, list(range(ts,te))))
    return out

def pf_of(preds, acts):
    preds=np.array(preds); acts=np.array(acts); ret=np.sign(preds)*acts
    gp=ret[ret>0].sum(); gl=-ret[ret<0].sum()
    return round(float(gp/gl),3) if gl>0 else None

# ── per-měnové OOS predikce (purged CV), uložit pro každý den index -> pred ──
ccy_pred = {}
for c in ra.CUR:
    X = pd.concat({f: F[f][c] for f in FACTORS if c in F[f].columns}, axis=1)
    y = bk[c][::-1].rolling(4).sum()[::-1].shift(-1)
    df = pd.concat([X, y.rename("y")], axis=1).dropna()
    if len(df) < 200: continue
    Xv, yv = df.drop(columns=["y"]).values, df["y"].values
    preds = pd.Series(index=df.index, dtype=float)
    for tr, te in purged_splits(len(df)):
        m = LinearRegression().fit(Xv[tr], yv[tr])
        preds.iloc[te] = m.predict(Xv[te])
    ccy_pred[c] = preds

# ── Model A: per-měna diff (base_pred - quote_pred) → obchod na páru ──
pret_wk = pret
rowsA, rowsB, rowsC = [], [], []
for p in ra.PAIRS:
    b, q = p[:3], p[3:]
    fwd = pret_wk[p][::-1].rolling(4).sum()[::-1].shift(-1)
    if b not in ccy_pred or q not in ccy_pred: continue
    diffA = (ccy_pred[b] - ccy_pred[q]).reindex(fwd.index)
    dfA = pd.concat([diffA.rename("s"), fwd.rename("f")], axis=1).dropna()
    if len(dfA) > 100:
        icA,_ = spearmanr(dfA["s"], dfA["f"])
        rowsA.append({"pair": p, "n": len(dfA), "ic": round(float(icA),3), "pf": pf_of(dfA["s"], dfA["f"])})

    # Model B: per-pár regrese (diff faktorů jako vstup, purged CV vlastní pro tenhle pár)
    Xp = pd.concat({f: (F[f][b]-F[f][q]) for f in FACTORS if b in F[f].columns and q in F[f].columns}, axis=1)
    dfp = pd.concat([Xp, fwd.rename("y")], axis=1).dropna()
    if len(dfp) >= 200:
        Xv, yv = dfp.drop(columns=["y"]).values, dfp["y"].values
        preds=[]; acts=[]
        for tr, te in purged_splits(len(dfp)):
            m = LinearRegression().fit(Xv[tr], yv[tr])
            preds.extend(m.predict(Xv[te])); acts.extend(yv[te])
        icB,_ = spearmanr(preds, acts)
        rowsB.append({"pair": p, "n": len(preds), "ic": round(float(icB),3), "pf": pf_of(preds, acts)})

def summarize(rows, name):
    ics = [r["ic"] for r in rows]; pfs = [r["pf"] for r in rows if r["pf"] is not None]
    print(f"{name}: {len(rows)} párů | průměr IC={np.mean(ics):.3f} (std {np.std(ics):.3f}) | průměr PF={np.mean(pfs):.3f} | párů s PF>1: {sum(1 for x in pfs if x>1)}/{len(pfs)}")
    return {"n_pairs": len(rows), "avg_ic": float(np.mean(ics)), "avg_pf": float(np.mean(pfs)), "pf_gt1": sum(1 for x in pfs if x>1)}

print("=== Model A: per-měnové skóre (diff base-quote), OOS purged CV ===")
sumA = summarize(rowsA, "Model A (per-currency)")
print("\n=== Model B: per-pár vlastní regrese, OOS purged CV ===")
sumB = summarize(rowsB, "Model B (per-pair)")

json.dump({"modelA": rowsA, "modelB": rowsB, "summary": {"A": sumA, "B": sumB}},
          open(os.path.join(os.path.dirname(__file__), "..", "data/research/model_compare.json"), "w"),
          ensure_ascii=False, indent=1)
print("\nOK -> data/research/model_compare.json")

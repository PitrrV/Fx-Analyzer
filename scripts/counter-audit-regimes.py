#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Protiaudit krok 2: jemnější reference-based režimy (ne jen 4 hrubé
subperiody) pro faktory, které přežily FDR korekci (viz counter-audit-fdr.py).
Testuje: fungují tyto faktory NAPŘÍČ režimy, nebo jsou to artefakty jedné
epochy (typicky 2008 krize nebo 2020 covid, které dominují extrémy VIXu)?"""
import importlib.util, os, json
import numpy as np, pandas as pd
from scipy.stats import spearmanr

spec = importlib.util.spec_from_file_location("ra", os.path.join(os.path.dirname(__file__), "research-audit.py"))
ra = importlib.util.module_from_spec(spec); spec.loader.exec_module(ra)

wk, pret, bk = ra.build_prices()
fred = ra.build_fred()
cot = ra.build_cot()
F = ra.build_panel(bk, fred, cot)
fwd4 = {c: bk[c][::-1].rolling(4).sum()[::-1].shift(-1) for c in ra.CUR}

REGIMES = [
    ("Financial Crisis", "2008-01-01", "2009-06-30"),
    ("QE1-3 éra",         "2009-07-01", "2015-12-31"),
    ("Nízká inflace",     "2010-01-01", "2020-12-31"),
    ("Covid crash",       "2020-02-01", "2020-06-30"),
    ("Covid QE",          "2020-07-01", "2021-12-31"),
    ("Vysoká inflace",    "2021-06-01", "2023-06-30"),
    ("Hiking cycle (Fed)","2022-03-01", "2023-07-31"),
    ("Cutting cycle (Fed)","2024-09-01","2026-07-31"),
    ("Post-covid",        "2022-01-01", "2023-12-31"),
]

# faktory, co přežily FDR korekci na currency-level (q<=0.20) — testuj JEN tyhle
SURVIVORS = [
    ("AUD","vix_lvl"), ("JPY","cot_am"), ("CAD","cpi_accel"), ("CHF","cot_comm"),
    ("GBP","vix_lvl"), ("CHF","cot_dealer"), ("USD","dxy_r4"), ("CAD","realyield"),
]

def ic(sig, fw, mask):
    df = pd.concat([sig, fw], axis=1, keys=["s","f"]).dropna()
    df = df[mask.reindex(df.index).fillna(False)]
    if len(df) < 25: return None, len(df)
    r,_ = spearmanr(df["s"], df["f"]); return round(float(r),3), len(df)

print(f"{'Faktor':22s} | " + " | ".join(f"{n[:14]:14s}" for n,_,_ in REGIMES))
results = {}
for ccy, fac in SURVIVORS:
    key = f"{ccy}:{fac}"
    sig = F[fac][ccy] if ccy in F[fac].columns else None
    if sig is None: continue
    row = []
    for name, a, b in REGIMES:
        mask = pd.Series(True, index=bk.index).loc[a:b]
        r, n = ic(sig, fwd4[ccy], pd.Series(True, index=bk.loc[a:b].index))
        row.append((r, n))
    results[key] = row
    print(f"{key:22s} | " + " | ".join(f"{(str(r)+' n'+str(n)):14s}" for r,n in row))

# konzistence: v kolika režimech (s n>=25) má faktor STEJNÉ znaménko jako jeho celkové IC?
print("\nKonzistence znaménka napříč režimy (jen režimy s n>=25):")
consistency = {}
for ccy, fac in SURVIVORS:
    key = f"{ccy}:{fac}"
    overall_ic, _ = ic(F[fac][ccy], fwd4[ccy], pd.Series(True, index=bk.index))
    row = results.get(key, [])
    valid = [(name, r) for (name,_,_), (r,n) in zip(REGIMES, row) if n >= 25 and r is not None]
    agree = sum(1 for _, r in valid if np.sign(r) == np.sign(overall_ic))
    consistency[key] = {"overall_ic": overall_ic, "n_regimes_valid": len(valid), "n_agree": agree,
                         "regimes": {name: r for name, r in valid}}
    flag = "STABILNÍ" if len(valid) and agree == len(valid) else ("VĚTŠINOU" if len(valid) and agree >= len(valid)*0.7 else "NESTABILNÍ")
    print(f"  {key:22s} celkové IC={overall_ic:+.3f} shoda {agree}/{len(valid)} režimů → {flag}")

json.dump({"regimes": [r[0] for r in REGIMES], "results": {k: v for k,v in consistency.items()}},
          open(os.path.join(os.path.dirname(__file__), "..", "data/research/regime_breakdown.json"), "w"),
          ensure_ascii=False, indent=1)
print("\nOK -> data/research/regime_breakdown.json")

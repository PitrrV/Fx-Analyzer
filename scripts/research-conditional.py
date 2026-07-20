#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Podmíněné (režimové) testy nad stejným panelem jako research-audit.py:
ověřuje hypotézy "faktor funguje jen v režimu X" — carry|VIX, momentum|trend,
COT|extrém, VIX|volatilita — a redundanci sazbových/COT faktorů (korelace).
Jen měření, nic v enginu nemění."""
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
vix = fred["vix"].reindex(bk.index).ffill(limit=2)
vix_med = vix.expanding(min_periods=52).median()   # expanding medián, bez look-aheadu
hi_vix = vix > vix_med

def ic(sig, fw, mask=None):
    df = pd.concat([sig, fw], axis=1, keys=["s","f"]).dropna()
    if mask is not None: df = df[mask.reindex(df.index).fillna(False)]
    if len(df) < 80: return None, len(df)
    r,_ = spearmanr(df["s"], df["f"]); return round(float(r),3), len(df)

out = {}
def report(name, rows):
    out[name] = rows
    print(f"\n== {name} ==")
    for r in rows: print("  ", r)

# 1) carry — funguje jen při nízkém VIX?
rows=[]
for c in ra.CUR:
    s = F["carry3m"][c]; f = fwd4[c]
    lo,nl = ic(s,f,~hi_vix); hi,nh = ic(s,f,hi_vix)
    rows.append(f"{c}: carry IC lowVIX={lo} (n{nl}) | highVIX={hi} (n{nh})")
report("Carry podmíněně na VIX (h4)", rows)

# 2) momentum — funguje jen v trendu? (trend = |mom12| nad expandním mediánem)
rows=[]
for c in ra.CUR:
    m12 = F["mom12"][c]; trend = m12.abs() > m12.abs().expanding(min_periods=52).median()
    t,nt = ic(F["mom4"][c], fwd4[c], trend); r_,nr = ic(F["mom4"][c], fwd4[c], ~trend)
    rows.append(f"{c}: mom4 IC trend={t} (n{nt}) | range={r_} (n{nr})")
report("Momentum podmíněně na trend (h4)", rows)

# 3) COT — funguje jen v extrému? (|z 3y| > 1.28 vs střed)
rows=[]
for c in ra.CUR:
    s = F["cot_nc"][c]
    z = (s - s.rolling(156, min_periods=52).mean()) / s.rolling(156, min_periods=52).std()
    ext = z.abs() > 1.28
    e,ne = ic(s, fwd4[c], ext); m,nm = ic(s, fwd4[c], ~ext)
    rows.append(f"{c}: cot_nc IC extrém={e} (n{ne}) | střed={m} (n{nm})")
report("COT noncomm podmíněně na extrém (h4)", rows)

# 4) VIX efekt podmíněně na vol režim (vysoký vs nízký VIX sám)
rows=[]
for c in ["AUD","GBP","CHF","JPY"]:
    h,nh = ic(F["vix_lvl"][c], fwd4[c], hi_vix); l,nl = ic(F["vix_lvl"][c], fwd4[c], ~hi_vix)
    rows.append(f"{c}: vix_lvl IC highVIX={h} (n{nh}) | lowVIX={l} (n{nl})")
report("VIX úroveň podmíněně na režim (h4)", rows)

# 5) redundance: korelace sazbových a COT faktorů (průměr přes měny)
pairs = [("carry3m","y10diff"),("carry3m","realyield"),("y10diff","realyield"),
         ("cot_nc","cot_lev"),("cot_nc","cot_am"),("cot_comm","cot_nc"),("cot_dealer","cot_am")]
rows=[]
for a,b in pairs:
    cs=[]
    for c in ra.CUR:
        if c in F[a].columns and c in F[b].columns:
            df = pd.concat([F[a][c],F[b][c]],axis=1).dropna()
            if len(df)>100: cs.append(df.corr().iloc[0,1])
    rows.append(f"{a} × {b}: prům. korelace = {round(float(np.mean(cs)),2) if cs else None} (n měn {len(cs)})")
report("Redundance faktorů (korelace)", rows)

with open(os.path.join(os.path.dirname(__file__),"..","data/research/conditional_tests.json"),"w") as f:
    json.dump(out,f,ensure_ascii=False,indent=1)
print("\nOK → data/research/conditional_tests.json")

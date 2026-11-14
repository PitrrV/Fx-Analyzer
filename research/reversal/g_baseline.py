"""Nulová kontrola: je výsledek po Reverzálu lepší než po náhodném vstupu (stejný pár, směr, ATR horizont)? A vztah původního štítku k tradovatelnému výsledku."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, pandas as pd, lib, features as F
HERE = os.path.dirname(os.path.abspath(__file__)); rng = np.random.default_rng(3)
df = pd.read_csv(os.path.join(HERE, "out", "signals.csv")); df = df[df.win1atr.notna()]
DATA = {}
for p in lib.pairs():
    h4, _ = lib.load(p); t = np.array(h4["t"]); o, h, l, c = [np.array(h4[k], float) for k in "ohlc"]; _, atr = F.tr_atr(h, l, c); DATA[p] = dict(o=o, h=h, l=l, c=c, atr=atr)
def metrics(d, e, sg):
    a = d["atr"][e - 1]; p0 = d["o"][e]; hh, ll = d["h"][e:e + 12], d["l"][e:e + 12]
    fav = ((hh - p0) if sg > 0 else (p0 - ll)) / a; adv = ((p0 - ll) if sg > 0 else (hh - p0)) / a; win = 0
    for f, ad in zip(fav, adv):
        if ad >= 1: break
        if f >= 1: win = 1; break
    ret = ((d["c"][e + 11] - p0) if sg > 0 else (p0 - d["c"][e + 11])) / a
    return win, ret, fav.max(), adv.max()
out = []
for _, r in df.iterrows():
    d = DATA[r["pair"]]; sg = 1 if r["type"] == "LONG" else -1; e = int(r["entry_idx"]); n = len(d["c"]); nl = []
    while len(nl) < 40:
        k = int(rng.integers(40, n - 14))
        if abs(k - e) > 12: nl.append(metrics(d, k, sg))
    m = np.mean(nl, axis=0); out.append(dict(win=r.win1atr, ret=r.ret12, mfe=r.mfe12, mae=r.mae12, nwin=m[0], nret=m[1], nmfe=m[2], nmae=m[3], cluster=r.cluster, since=r.since, type=r.type))
O = pd.DataFrame(out)
def boot(x, cl, B=2000):
    u, inv = np.unique(cl, return_inverse=True); m = len(u); sx = np.bincount(inv, weights=x, minlength=m); sn = np.bincount(inv, minlength=m).astype(float)
    W = rng.multinomial(m, np.ones(m) / m, size=B).astype(float); v = (W @ sx) / np.maximum(W @ sn, 1); return np.percentile(v, 2.5), np.percentile(v, 97.5)
print(f"signálů {len(O)}")
for lab, sub in (("vše", O), ("vývoj", O[O.since < "2026-04-01"]), ("test", O[O.since >= "2026-04-01"]), ("LONG", O[O.type == "LONG"]), ("SHORT", O[O.type == "SHORT"])):
    for k, nk in (("win", "nwin"), ("ret", "nret"), ("mfe", "nmfe"), ("mae", "nmae")):
        d = (sub[k] - sub[nk]).values; lo, hi = boot(d, sub.cluster.values)
        print(f"{lab:6s} {k}: signál {sub[k].mean():+.3f} | náhoda {sub[nk].mean():+.3f} | rozdíl {d.mean():+.3f} [{lo:+.3f}; {hi:+.3f}] n={len(sub)}")
leg = df[df.legacy.isin(["CORRECT", "WRONG", "CHOP"])]
print("\nPůvodní štítek vs tradovatelný výsledek (win +1 ATR před −1 ATR do 48 h):")
print(leg.groupby("legacy").agg(n=("win1atr", "size"), win_tradeable=("win1atr", "mean"), ret12=("ret12", "mean"), dur=("dur_days", "mean")).round(3))

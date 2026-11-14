"""Etapa F (část 3): opakující se SEKVENCE struktur. Dva oddělené testy kvůli look-ahead:
 (A) sekvence dokončená PŘED/PŘI signálu (poslední žeton conf <= signální svíčka) -> výsledek od vstupu (win +1 ATR před −1 ATR do 48 h);
 (B) sekvence dokončená PO signálu (okno 12 svíček) -> vstup na otevření další svíčky, výsledek v R (stop = extrém pohybu, cíl 1,5 R, 24 sv., náklady 0,05 ATR) vs. náhodná doba vstupu.
Žetony: jen struktury ve směru signálu (+ neutrální). n-gramy délky 2–3 z po sobě jdoucích RŮZNÝCH událostí seřazených podle conf."""
import os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, pandas as pd
import lib, features as F
HERE = os.path.dirname(os.path.abspath(__file__)); rng = np.random.default_rng(5)
df = pd.read_csv(os.path.join(HERE, "out", "signals.csv"))
SPLIT = "2026-04-01"; COST, TP_R, HOLD = 0.05, 1.5, 24
DATA = {}
for p in lib.pairs():
    h4, _ = lib.load(p); t = np.array(h4["t"]); o, h, l, c = [np.array(h4[k], float) for k in "ohlc"]
    _, atr = F.tr_atr(h, l, c); DATA[p] = dict(o=o, h=h, l=l, c=c, atr=atr, ev=F.events_h4(t, o, h, l, c, atr))
NEUTRAL = {"NR7", "COMPRESSION", "TRIANGLE"}
def simulate(d, eb, sg, stop, a):
    n = len(d["c"]); p0 = d["o"][eb]; risk = (p0 - stop) if sg > 0 else (stop - p0)
    if eb + HOLD > n or risk < 0.3 * a or risk > 2.5 * a: return None
    tp = p0 + sg * TP_R * risk
    for j in range(eb, eb + HOLD):
        hi, lo = d["h"][j], d["l"][j]
        if (lo <= stop) if sg > 0 else (hi >= stop): return -1.0 - COST * a / risk
        if (hi >= tp) if sg > 0 else (lo <= tp): return TP_R - COST * a / risk
    return ((d["c"][eb + HOLD - 1] - p0) * sg / risk) - COST * a / risk
def grams(seq, k):
    return {tuple(x[1] for x in seq[i:i + k]): seq[i + k - 1][0] for i in range(len(seq) - k + 1)}  # n-gram -> conf dokončení (první výskyt přepíše později; bereme poslední)
A, B = [], []
for _, r in df.iterrows():
    d = DATA[r["pair"]]; sg = 1 if r["type"] == "LONG" else -1; e = int(r["entry_idx"]); s = e - 1; a = r["atr"]
    toks = sorted({(c_, nm) for c_, nm, dr in d["ev"] if (dr == sg or nm in NEUTRAL)})
    toks = sorted(toks, key=lambda x: (x[0], x[1]))
    pre = [x for x in toks if s - 23 <= x[0] <= s]
    for k in (2, 3):
        seen = set()
        for g, cf in grams(pre, k).items():
            if g in seen: continue
            seen.add(g); A.append(dict(gram=" → ".join(g), pair=r["pair"], since=r["since"], cluster=r["since"], win=r["win1atr"], ret12=r["ret12"]))
    post = [x for x in toks if e <= x[0] <= e + 11]
    for k in (2, 3):
        done = {}
        for g, cf in grams(post, k).items():
            if g in done: continue
            done[g] = cf; eb = cf + 1
            if eb >= len(d["c"]): continue
            lo_i = max(0, s - 2)
            stop = (d["l"][lo_i:cf + 1].min() - 0.1 * a) if sg > 0 else (d["h"][lo_i:cf + 1].max() + 0.1 * a)
            R = simulate(d, eb, sg, stop, a)
            if R is None: continue
            risk = abs(d["o"][eb] - stop); nl = []
            for _ in range(10):
                kk = int(rng.integers(40, len(d["c"]) - HOLD - 2))
                if abs(kk - e) <= 12: continue
                x = simulate(d, kk, sg, d["o"][kk] - sg * risk, a)
                if x is not None: nl.append(x)
            B.append(dict(gram=" → ".join(g), pair=r["pair"], since=r["since"], cluster=r["since"], R=R, null_R=float(np.mean(nl)) if nl else np.nan, bars_after=eb - e))
A, B = pd.DataFrame(A), pd.DataFrame(B)

def boot(x, cl, B_=1500):
    u, inv = np.unique(cl, return_inverse=True); m = len(u)
    sx = np.bincount(inv, weights=x, minlength=m); sn = np.bincount(inv, minlength=m).astype(float)
    W = rng.multinomial(m, np.ones(m) / m, size=B_).astype(float); v = (W @ sx) / np.maximum(W @ sn, 1)
    return float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5)), float(max(2 * min((v <= 0).mean(), (v >= 0).mean()), 1 / B_))
def bh(p, q=0.10):
    p = np.asarray(p); n = len(p); o = np.argsort(p); ok = p[o] <= q * np.arange(1, n + 1) / n; k = (np.where(ok)[0].max() + 1) if ok.any() else 0
    s = np.zeros(n, bool); s[o[:k]] = True; return s
base_dev = A[A.since < SPLIT].win.mean()
rows = []
for g, x in A[A.since < SPLIT].groupby("gram"):
    if len(x) < 30: continue
    y = x.win.values - base_dev; lo, hi, p = boot(y, x.cluster.values)
    t = A[(A.since >= SPLIT) & (A.gram == g)]
    rows.append(dict(gram=g, n=len(x), winrate=x.win.mean(), diff_vs_base=x.win.mean() - base_dev, lo=lo, hi=hi, p=p, test_n=len(t), test_winrate=t.win.mean() if len(t) else np.nan))
RA = pd.DataFrame(rows).sort_values("p"); RA["fdr_q10"] = bh(RA.p.values) if len(RA) else False
RA.to_csv(os.path.join(HERE, "out", "sequences_pre.csv"), index=False)
print(f"(A) sekvence před/při signálu: testovaných (n>=30 ve vývoji) {len(RA)}, FDR q=0.10 prošlo {int(RA.fdr_q10.sum())}; základ vývoje {base_dev:.3f}")
print(RA.head(8).round(3).to_string(index=False))
rows = []
for g, x in B[B.since < SPLIT].groupby("gram"):
    if len(x) < 20: continue
    ex = x.R.values - x.null_R.fillna(x.null_R.mean()).values; lo, hi, p = boot(ex, x.cluster.values)
    t = B[(B.since >= SPLIT) & (B.gram == g)]
    tex = (t.R - t.null_R.fillna(t.null_R.mean())).values if len(t) else np.array([])
    rows.append(dict(gram=g, n=len(x), exp_R=x.R.mean(), edge_vs_null=ex.mean(), lo=lo, hi=hi, p=p, bars_after=x.bars_after.mean(), test_n=len(t), test_exp_R=t.R.mean() if len(t) else np.nan, test_edge=tex.mean() if len(tex) else np.nan))
RB = pd.DataFrame(rows).sort_values("p"); RB["fdr_q10"] = bh(RB.p.values) if len(RB) else False
RB.to_csv(os.path.join(HERE, "out", "sequences_post.csv"), index=False)
print(f"\n(B) sekvence po signálu (vstup po dokončení): testovaných (n>=20 ve vývoji) {len(RB)}, FDR q=0.10 prošlo {int(RB.fdr_q10.sum())}")
print(RB.head(10).round(3).to_string(index=False))

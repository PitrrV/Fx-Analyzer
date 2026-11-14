"""Vyhodnocení štítků z Cowork (subjektivní Supply/Demand zóny) proti výsledkům signálů. SPOUŠTÍ SE AŽ PO DODÁNÍ labels_filled.csv.
Použití: python3 i_analyze_cowork_labels.py cowork/labels_filled.csv
Předem zapsané hypotézy (nesmí se měnit podle výsledků), cíl win = +1 ATR před −1 ATR do 48 h, sekundárně výsledek po 48 h v ATR:
 H1 cena je v zóně nebo u ní (≤0,25 ATR) na kterémkoli časovém rámci   H2 totéž na D1 nebo W1   H3 would_take = Y
 H4 volný prostor: protilehlá zóna je dál než 3 ATR nebo žádná   H5 liquidity sweep = Y   H6 zóna je čerstvá (fresh = Y) a cena je v ní/u ní
Nejistota: bootstrap po clusterech (den vzniku); korekce BH (12 testů); stabilita: první vs. druhá polovina; spolehlivost: 20 opakovaných signálů a shoda s algoritmickými zónami."""
import os, sys
import numpy as np, pandas as pd
H = os.path.dirname(os.path.abspath(__file__)); rng = np.random.default_rng(1)
lab = pd.read_csv(sys.argv[1] if len(sys.argv) > 1 else os.path.join(H, "cowork", "labels_filled.csv"))
key = pd.read_csv(os.path.join(H, "out", "cowork_key.csv")); sig = pd.read_csv(os.path.join(H, "out", "signals.csv"))
d = lab.merge(key, on="id", how="left").merge(sig[["pair", "since", "entry_price", "atr", "dist_zone_h4", "dist_zone_d1", "dist_zone_w1"]], on=["pair", "since"], how="left")
req = ["zone_w1", "zone_d1", "zone_h4", "would_take"]
print(f"řádků {len(d)}; kompletních (všechna povinná pole): {int(d[req].notna().all(axis=1).sum())}")
def yn(c): return d[c].astype(str).str.strip().str.upper().str[0].map({"Y": 1, "A": 1, "N": 0}).astype(float)
def dist(prefix):
    top, bot = pd.to_numeric(d[f"{prefix}_top"], errors="coerce"), pd.to_numeric(d[f"{prefix}_bottom"], errors="coerce")
    p = d.entry_price; inside = (p >= bot) & (p <= top); dd = np.where(inside, 0.0, np.minimum((p - top).abs(), (p - bot).abs()))
    out = pd.Series(dd / d.atr, index=d.index); out[(yn(f"zone_{prefix}") != 1) | top.isna() | bot.isna()] = np.inf; return out
dw, dd1, dh = dist("w1"), dist("d1"), dist("h4"); near = lambda x: x <= 0.25
opp_top, opp_bot = pd.to_numeric(d.opposing_zone_top, errors="coerce"), pd.to_numeric(d.opposing_zone_bottom, errors="coerce")
opp = np.where(d.type == "LONG", opp_bot - d.entry_price, d.entry_price - opp_top); room = pd.Series(opp / d.atr, index=d.index)
H_ = {
 "H1 v zóně/u zóny (jakýkoli TF)": near(dw) | near(dd1) | near(dh),
 "H2 v zóně/u zóny (D1 nebo W1)": near(dw) | near(dd1),
 "H3 would_take = Y": yn("would_take") == 1,
 "H4 volný prostor (protilehlá zóna >3 ATR nebo žádná)": room.isna() | (room > 3),
 "H5 liquidity sweep = Y": yn("liquidity_sweep_last12h4") == 1,
 "H6 čerstvá zóna a cena v ní/u ní": ((yn("w1_fresh") == 1) & near(dw)) | ((yn("d1_fresh") == 1) & near(dd1)) | ((yn("h4_fresh") == 1) & near(dh)),
}
main = d[d.repeat_of.isna() | (d.repeat_of == "")].copy()
def boot(mask, y, cl, B=3000):
    ucl, inv = np.unique(cl, return_inverse=True); m = len(ucl)
    a = np.bincount(inv, weights=mask.astype(float), minlength=m); aw = np.bincount(inv, weights=(mask * y).astype(float), minlength=m)
    b = np.bincount(inv, weights=(~mask).astype(float), minlength=m); bw = np.bincount(inv, weights=((~mask) * y).astype(float), minlength=m)
    W = rng.multinomial(m, np.ones(m) / m, size=B).astype(float); sa, saw, sb, sbw = W @ a, W @ aw, W @ b, W @ bw; ok = (sa > 0) & (sb > 0)
    x = saw[ok] / sa[ok] - sbw[ok] / sb[ok]; return np.percentile(x, 2.5), np.percentile(x, 97.5), max(2 * min((x <= 0).mean(), (x >= 0).mean()), 1 / B)
rows = []
for nm, m in H_.items():
    m = m.loc[main.index].fillna(False).values.astype(bool); y = main.win1atr.values; r12 = main.ret12.values; n = int(m.sum())
    if n < 20 or (len(m) - n) < 20: rows.append(dict(hypotéza=nm, n=n, poznámka="málo případů")); continue
    lo, hi, p = boot(m, y, main.since.values); lo2, hi2, p2 = boot(m, (r12 > 0).astype(float), main.since.values)
    tt = pd.to_datetime(main.since).astype('int64').values; half = tt <= np.median(tt); sh = []
    for hf in (half, ~half):
        mm, yy = m[hf], y[hf]; sh.append(yy[mm].mean() - yy[~mm].mean() if mm.sum() > 5 and (~mm).sum() > 5 else np.nan)
    rows.append(dict(hypotéza=nm, n=n, win_ano=y[m].mean(), win_ne=y[~m].mean(), rozdíl=y[m].mean() - y[~m].mean(), ci_lo=lo, ci_hi=hi, p=p, výsledek48h_ano=r12[m].mean(), výsledek48h_ne=r12[~m].mean(), p_vysledek=p2, polovina1=sh[0], polovina2=sh[1]))
R = pd.DataFrame(rows)
pp = np.sort(R.p.dropna().values) if "p" in R else []
def bh(ps, q=0.10):
    ps = np.array(ps); o = np.argsort(ps); k = len(ps); ok = ps[o] <= q * np.arange(1, k + 1) / k; kk = (np.where(ok)[0].max() + 1) if ok.any() else 0
    s = np.zeros(k, bool); s[o[:kk]] = True; return s
allp = pd.concat([R.p, R.p_vysledek]).dropna(); sel = bh(allp.values) if len(allp) else []
R["fdr_q10_win"] = False
if "p" in R:
    idx = R.p.dropna().index; flag = dict(zip(allp.index[:len(idx)], sel[:len(idx)])) if len(sel) else {}
    for i in idx: R.loc[i, "fdr_q10_win"] = bool(flag.get(i, False))
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 30); print(R.round(3).to_string(index=False))
# spolehlivost štítků: opakované signály
rep = d[d.repeat_of.notna() & (d.repeat_of != "")]
if len(rep):
    base = d.set_index("key_id"); agree = {}
    for c in ("zone_w1", "zone_d1", "zone_h4", "would_take", "liquidity_sweep_last12h4", "at_key_level"):
        a = [(str(base.loc[r.repeat_of, c]).strip().upper()[:1], str(r[c]).strip().upper()[:1]) for _, r in rep.iterrows() if r.repeat_of in base.index]
        agree[c] = np.mean([x == y for x, y in a]) if a else np.nan
    print("\nShoda při opakovaném označení téhož signálu (20 signálů):", {k: round(v, 2) for k, v in agree.items()})
# shoda s algoritmickými zónami (Cohenovo kappa)
def kappa(a, b):
    a, b = np.asarray(a, bool), np.asarray(b, bool); po = (a == b).mean(); pe = a.mean() * b.mean() + (1 - a.mean()) * (1 - b.mean()); return (po - pe) / (1 - pe) if pe < 1 else np.nan
for nm, mine, algo in (("D1", near(dd1), d.dist_zone_d1 <= 0.25), ("H4", near(dh), d.dist_zone_h4 <= 0.25), ("W1", near(dw), d.dist_zone_w1 <= 0.25)):
    ok = ~algo.isna(); print(f"shoda 'cena v zóně' Cowork × algoritmus ({nm}): kappa {kappa(mine[ok], algo[ok]):.2f}")

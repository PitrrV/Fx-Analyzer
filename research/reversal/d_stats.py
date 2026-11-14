"""Etapa F (část 1): univariátní srovnání ziskových a ztrátových Reverzálů na VÝVOJOVÉ části + ověření na NEZÁVISLÉ testovací části.
Primární cíl: win = +1 ATR dosaženo dřív než −1 ATR do 48 h (12 H4). Nejistota: bootstrap po clusterech (den vzniku). Vícenásobné testy: BH FDR."""
import os, sys, math, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__))
df = pd.read_csv(os.path.join(HERE, "out", "signals.csv"))
OUTCOME = os.environ.get("OUTCOME", "win1atr")
if OUTCOME == "legacy":      # kontrola robustnosti: původní (zpětně určené) štítky CORRECT/WRONG, CHOP vynechán
    df = df[df.legacy.isin(["CORRECT", "WRONG"])].copy(); df["win1atr"] = (df.legacy == "CORRECT").astype(float)
else:
    df = df[df.win1atr.notna()].copy()
SUFFIX = "" if OUTCOME == "win1atr" else "_" + OUTCOME
SPLIT = "2026-04-01"
dev, tst = df[df.since < SPLIT].copy(), df[df.since >= SPLIT].copy()
rng = np.random.default_rng(7)
print(f"signálů s výsledkem {len(df)} | vývoj {len(dev)} (do {SPLIT}) | test {len(tst)}")

# ---- binární vlastnosti
def add_flags(x):
    f = {}
    for c in x.columns:
        if c.startswith(("pre8_", "pre12_", "pre24_", "at_", "opp_pre12_")): f[c] = x[c] == 1
    for nm, col in (("h4", "dist_zone_h4"), ("d1", "dist_zone_d1"), ("w1", "dist_zone_w1")):
        f[f"zone_{nm}_in(<=0.25ATR)"] = x[col] <= 0.25
        f[f"zone_{nm}_near(<=1ATR)"] = x[col] <= 1.0
        f[f"oppzone_{nm}_blocks(<=1ATR)"] = x[f"dist_opp_{col[5:]}"] <= 1.0
    f["any_zone_in"] = (x.dist_zone_h4 <= 0.25) | (x.dist_zone_d1 <= 0.25) | (x.dist_zone_w1 <= 0.25)
    f["d1_or_w1_zone_in"] = (x.dist_zone_d1 <= 0.25) | (x.dist_zone_w1 <= 0.25)
    f["at_PDL_PDH(<=0.5ATR)"] = (x.dist_pdl_atr <= 0.5) | (x.dist_pdh_atr <= 0.5)
    f["sweep_PDL/PDH_6bars"] = (x.sweep_pdl_6 == 1) | (x.sweep_pdh_6 == 1)
    f["at_20d_extreme(<=0.5ATR)"] = x.dist_20d_extreme <= 0.5
    f["strength_s6_with_signal"] = x.s6_diff_signed > 0
    f["strength_s30_with_signal"] = x.s30_diff_signed > 0
    f["strength_s30_extreme(>=0.8)"] = x.s30_extreme_pct >= 0.8
    f["strength_turning_12h"] = x.s6_turning == 1
    for k in (4, 8, 12, 24): f[f"strength_slope_{k}h>0"] = x[f"s6_slope_{k}h"] > 0
    f["strength_divergence_s6<0&s30>0"] = (x.s6_diff_signed < 0) & (x.s30_diff_signed > 0)
    for v in ("diverg_agree", "diverg_contra", "both_strong", "both_weak", "mixed"): f[f"cot_{v}"] = x.cot_combo == v
    f["dir_LONG"] = x.type == "LONG"
    f["er_ge_0.65"] = x.er >= 0.65
    f["rp_extreme(<=0.05|>=0.95)"] = (x.rp <= 0.05) | (x.rp >= 0.95)
    return pd.DataFrame(f)
Fd, Ft = add_flags(dev), add_flags(tst)

def wilson(k, n, z=1.96):
    if n == 0: return (np.nan, np.nan)
    p = k / n; d = 1 + z * z / n; c = p + z * z / (2 * n); w = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - w) / d, (c + w) / d)

def boot_diff(mask, y, cl, B=2000):
    """Rozdíl win rate (přítomno − nepřítomno) a bootstrap po clusterech."""
    ucl, inv = np.unique(cl, return_inverse=True); m = len(ucl)
    np_ = np.bincount(inv, weights=mask.astype(float), minlength=m); wp = np.bincount(inv, weights=(mask * y).astype(float), minlength=m)
    na = np.bincount(inv, weights=(~mask).astype(float), minlength=m); wa = np.bincount(inv, weights=((~mask) * y).astype(float), minlength=m)
    W = rng.multinomial(m, np.ones(m) / m, size=B).astype(float)
    sp, spw, sa, saw = W @ np_, W @ wp, W @ na, W @ wa
    ok = (sp > 0) & (sa > 0)
    d = spw[ok] / sp[ok] - saw[ok] / sa[ok]
    if len(d) < 100: return np.nan, np.nan, np.nan
    p = 2 * min((d <= 0).mean(), (d >= 0).mean())
    return float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5)), float(min(1.0, max(p, 1 / B)))

def table(F, x, minn):
    y = x.win1atr.values; cl = x.cluster.values; rows = []
    base = y.mean()
    for c in F.columns:
        m = F[c].fillna(False).values.astype(bool); n = int(m.sum())
        if n < minn or (len(m) - n) < minn: continue
        k = int(y[m].sum()); lo, hi = wilson(k, n)
        dlo, dhi, p = boot_diff(m, y, cl)
        rows.append(dict(feature=c, n=n, wins=k, losses=n - k, winrate=k / n, ci_lo=lo, ci_hi=hi, winrate_absent=y[~m].mean(), diff=k / n - y[~m].mean(),
                         diff_lo=dlo, diff_hi=dhi, p_cluster=p, mfe12=x.mfe12.values[m].mean(), mae12=x.mae12.values[m].mean(),
                         median_ret12=float(np.median(x.ret12.values[m])), t_mfe_bars=float(np.nanmean(x.t_mfe_bars.values[m])), share_of_wins=float(y[m].sum() / y.sum()),
                         share_of_losses=float((1 - y)[m].sum() / (1 - y).sum())))
    t = pd.DataFrame(rows).sort_values("p_cluster")
    return t

def bh(p, q=0.10):
    p = np.asarray(p); n = len(p); o = np.argsort(p); thr = q * (np.arange(1, n + 1)) / n
    ok = p[o] <= thr; k = (np.where(ok)[0].max() + 1) if ok.any() else 0
    sel = np.zeros(n, bool); sel[o[:k]] = True; return sel

MINN = 30
Td = table(Fd, dev, MINN)
Td["fdr_q10"] = bh(Td.p_cluster.fillna(1).values, 0.10)
print(f"\nVÝVOJ: základní win rate {dev.win1atr.mean()*100:.1f} % (n={len(dev)}); testovaných hypotéz (n>={MINN}): {len(Td)}; prošlo FDR q=0.10: {int(Td.fdr_q10.sum())}")
Tt = table(Ft, tst, 15)
M = Td.merge(Tt[["feature", "n", "winrate", "diff", "diff_lo", "diff_hi", "p_cluster"]].rename(columns=lambda c: c if c == "feature" else "test_" + c), on="feature", how="left")
M["same_direction_in_test"] = np.sign(M["diff"]) == np.sign(M["test_diff"])
M.to_csv(os.path.join(HERE, "out", f"univariate{SUFFIX}.csv"), index=False)
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 30)
cols = ["feature", "n", "winrate", "diff", "diff_lo", "diff_hi", "p_cluster", "fdr_q10", "test_n", "test_winrate", "test_diff", "test_p_cluster"]
print("\nTOP 20 podle p (vývoj) a jejich chování v testu:")
print(M[cols].head(20).round(3).to_string(index=False))
print("\nProšlo FDR a v testu stejným směrem a p<0.05:")
sel = M[(M.fdr_q10) & (M.test_p_cluster < 0.05) & M.same_direction_in_test]
print(sel[cols].round(3).to_string(index=False) if len(sel) else "žádná")
json.dump(dict(dev_n=len(dev), test_n=len(tst), dev_base=dev.win1atr.mean(), test_base=tst.win1atr.mean(), hypotheses=len(Td), fdr_pass=int(Td.fdr_q10.sum())), open(os.path.join(HERE, "out", f"univariate_summary{SUFFIX}.json"), "w"))

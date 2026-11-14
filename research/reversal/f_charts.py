"""Etapa G: grafy z historických dat (generované, ne ručně vybrané podle dojmu): 10 nejlepších, 10 nejhorších Reverzálů (podle výsledku po 48 h),
10 případů s pohybem až po pozdějším potvrzení (CHOCH po signálu) a po 5 příkladů modelů M1 a M7. Zóny jsou algoritmické (H4 / D1 / W1)."""
import os, sys, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, pandas as pd
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
import lib, features as F
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, "charts"); os.makedirs(OUT, exist_ok=True)
for f in os.listdir(OUT): os.remove(os.path.join(OUT, f))
df = pd.read_csv(os.path.join(HERE, "out", "signals.csv")); df = df[df.win1atr.notna()].reset_index(drop=True)
M = pd.read_csv(os.path.join(HERE, "out", "model_trades.csv"))
PAIRS = lib.pairs(); CCY = sorted({p[:3] for p in PAIRS} | {p[3:] for p in PAIRS}); DATA = {}
for p in PAIRS:
    h4, d1 = lib.load(p); t = np.array(h4["t"]); o, h, l, c = [np.array(h4[k], float) for k in "ohlc"]; _, atr = F.tr_atr(h, l, c)
    t1 = np.array(d1["t"]); o1, h1, l1, c1 = [np.array(d1[k], float) for k in "ohlc"]; _, a1 = F.tr_atr(h1, l1, c1)
    wk = {}
    for i in range(len(t1)):
        d = lib.utc_date(t1[i]); wk.setdefault(d - dt.timedelta(days=d.weekday()), []).append(i)
    ks = sorted(wk); tw = np.array([int(dt.datetime(k.year, k.month, k.day, tzinfo=dt.timezone.utc).timestamp()) for k in ks])
    ow = np.array([o1[wk[k][0]] for k in ks]); hw = np.array([h1[wk[k]].max() for k in ks]); lw = np.array([l1[wk[k]].min() for k in ks]); cw = np.array([c1[wk[k][-1]] for k in ks]); _, aw = F.tr_atr(hw, lw, cw, 8)
    DATA[p] = dict(t=t, o=o, h=h, l=l, c=c, atr=atr, z4=F.build_zones(o, h, l, c, atr), t1=t1, z1=F.build_zones(o1, h1, l1, c1, a1), tw=tw, zw=F.build_zones(ow, hw, lw, cw, aw, k=2, look=4, imp=1.5))
allt = sorted(set(np.concatenate([DATA[p]["t"] for p in PAIRS]).tolist())); gi = {tt: i for i, tt in enumerate(allt)}
LOG = np.log(pd.DataFrame({p: pd.Series(DATA[p]["c"], index=DATA[p]["t"]) for p in PAIRS}).reindex(allt).ffill(limit=3)); R6 = LOG - LOG.shift(6)
def sdiff(p):
    b, q = p[:3], p[3:]; sb = pd.concat([R6[x] if x[:3] == b else -R6[x] for x in PAIRS if b in (x[:3], x[3:])], axis=1).mean(axis=1)
    sq = pd.concat([R6[x] if x[:3] == q else -R6[x] for x in PAIRS if q in (x[:3], x[3:])], axis=1).mean(axis=1); return (sb - sq) * 100
SD = {}
def draw(row, fname, title, trade=None):
    p = row["pair"]; d = DATA[p]; e = int(row["entry_idx"]); s = e - 1; sg = 1 if row["type"] == "LONG" else -1
    lo_i, hi_i = max(0, e - 40), min(len(d["c"]), e + 30); idx = np.arange(lo_i, hi_i)
    if p not in SD: SD[p] = sdiff(p)
    fig, (ax, ax2) = plt.subplots(2, 1, figsize=(11, 6.6), gridspec_kw=dict(height_ratios=[4, 1]), sharex=True)
    for j in idx:
        col = "#1f9d6b" if d["c"][j] >= d["o"][j] else "#d04a57"
        ax.plot([j, j], [d["l"][j], d["h"][j]], color=col, lw=0.8); ax.add_patch(Rectangle((j - 0.32, min(d["o"][j], d["c"][j])), 0.64, abs(d["c"][j] - d["o"][j]) or 1e-9, color=col))
    x0, x1 = lo_i - 0.5, hi_i + 0.5
    ymin, ymax = d['l'][lo_i:hi_i].min(), d['h'][lo_i:hi_i].max(); pad = (ymax - ymin) * 0.12; ymin -= pad; ymax += pad
    ov = lambda z: z['hi'] >= ymin and z['lo'] <= ymax   # kreslit jen zóny ve viditelném cenovém rozsahu
    for z in d["z4"]:
        if ov(z) and z["conf"] <= s and (z["inv"] is None or z["inv"] > s): ax.add_patch(Rectangle((max(z["origin"], lo_i), z["lo"]), x1 - max(z["origin"], lo_i), z["hi"] - z["lo"], color="#3b82f6" if z["kind"] == "demand" else "#f59e0b", alpha=0.18, lw=0))
    st = since_ts = int(row["since_ts"])
    for nm, zs, tt_conf, inv_t, col in (("D1", d["z1"], d["t1"], d["t1"], "#2563eb"), ("W1", d["zw"], d["tw"], d["tw"], "#7c3aed")):
        step = 86400 if nm == "D1" else 7 * 86400
        for z in zs:
            ct = tt_conf[z["conf"]] + step if z["conf"] < len(tt_conf) else None
            if ct is None or ct > st or not ov(z): continue
            if z["inv"] is not None and z["inv"] < len(tt_conf) and tt_conf[z["inv"]] + step <= st: continue
            ax.add_patch(Rectangle((lo_i, z["lo"]), hi_i - lo_i, z["hi"] - z["lo"], fill=False, ec=col, lw=1.4, ls="--" if nm == "D1" else "-", alpha=0.8))
            ax.text(lo_i + 0.5, z["hi"], f"{nm} {z['kind']}", color=col, fontsize=7, va="bottom")
    ax.set_ylim(ymin, ymax); ax.axvline(e - 0.5, color="#111", lw=1.2); ax.text(e - 0.4, ymax, " Reverzál " + row["type"], fontsize=8, va="top")
    if trade is not None:
        eb = int(trade["entry_bar"]); ax.axvline(eb - 0.5, color="#0ea5e9", lw=1.2, ls=":"); ax.text(eb - 0.4, ymin, " vstup po potvrzení", fontsize=8, color="#0369a1", va="bottom")
    ax.set_xlim(x0, x1); ax.set_title(title + f"  |  {p} {row['type']}  since {row['since']}  win48h={int(row['win1atr'])}  MFE12={row['mfe12']:.1f} MAE12={row['mae12']:.1f} ATR", fontsize=9)
    ax.set_ylabel("cena (H4)"); ts = d["t"][idx]
    ax2.plot(idx, SD[p].reindex(ts).values * sg, color="#0f172a", lw=1); ax2.axhline(0, color="#999", lw=0.6); ax2.axvline(e - 0.5, color="#111", lw=1.2)
    ax2.set_ylabel("síla měn\nve směru signálu (24 h, %)", fontsize=7)
    ticks = idx[::10]; ax2.set_xticks(ticks); ax2.set_xticklabels([dt.datetime.fromtimestamp(d["t"][i], dt.timezone.utc).strftime("%m-%d %H") for i in ticks], fontsize=7)
    plt.tight_layout(); fig.savefig(os.path.join(OUT, fname), dpi=62); plt.close(fig)
best = df.sort_values("ret12", ascending=False).head(10); worst = df.sort_values("ret12").head(10)
for k, (_, r) in enumerate(best.iterrows()): draw(r, f"best_{k+1:02d}_{r['pair']}_{r['since']}.png", f"NEJLEPŠÍ #{k+1} (48 h {r['ret12']:+.1f} ATR)")
for k, (_, r) in enumerate(worst.iterrows()): draw(r, f"worst_{k+1:02d}_{r['pair']}_{r['since']}.png", f"NEJHORŠÍ #{k+1} (48 h {r['ret12']:+.1f} ATR)")
m1 = M[(M.model.str.startswith("M1")) & (M.bars_after_signal >= 4)].sort_values("R", ascending=False)
for k, (_, tr) in enumerate(m1.head(10).iterrows()):
    r = df[(df.pair == tr["pair"]) & (df.since == tr["since"])].iloc[0]; draw(r, f"late_{k+1:02d}_{tr['pair']}_{tr['since']}.png", f"POZDNÍ POTVRZENÍ (CHOCH za {int(tr['bars_after_signal'])} sv., R={tr['R']:+.1f})", tr)
for tag, pref in (("M1", "M1"), ("M7", "M7")):
    x = M[M.model.str.startswith(pref)].sort_values("R", ascending=False).head(5)
    for k, (_, tr) in enumerate(x.iterrows()):
        r = df[(df.pair == tr["pair"]) & (df.since == tr["since"])].iloc[0]; draw(r, f"model{tag}_{k+1}_{tr['pair']}_{tr['since']}.png", f"PŘÍKLAD MODELU {tag} (nevalidovaný, R={tr['R']:+.1f})", tr)
print(len(os.listdir(OUT)), "grafů v", OUT, "| velikost kB", sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT)) // 1024)

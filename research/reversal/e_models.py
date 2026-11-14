"""Etapa F (část 2): entry modely, které vznikají AŽ PO signálu (potvrzení strukturou), a nulová kontrola.
Vstup po potvrzení = otevření následující H4 svíčky. Stop = extrém reverzního pohybu − 0,1 ATR, cíl 1,5 R, max. 24 svíček (4 dny), náklady 0,05 ATR.
Žádný look-ahead: struktura se použije až od svíčky, jejímž uzavřením je splněna. Rozdělení: vývoj (do 2026-04-01) / nezávislý test."""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, pandas as pd
import lib, features as F
HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(11)
df = pd.read_csv(os.path.join(HERE, "out", "signals.csv"))
DATA = {}
for p in lib.pairs():
    h4, _ = lib.load(p); t = np.array(h4["t"]); o, h, l, c = [np.array(h4[k], float) for k in "ohlc"]
    _, atr = F.tr_atr(h, l, c); DATA[p] = dict(t=t, o=o, h=h, l=l, c=c, atr=atr, ev=F.events_h4(t, o, h, l, c, atr))
COST, TP_R, HOLD, SPLIT = 0.05, 1.5, 24, "2026-04-01"

def simulate(d, entry_bar, sgn, stop, a):
    """Vrací (R, svíček držení, MFE v ATR, MAE v ATR) nebo None. Při zásahu stopu i cíle ve stejné svíčce platí stop."""
    n = len(d["c"]); p0 = d["o"][entry_bar]; risk = (p0 - stop) if sgn > 0 else (stop - p0)
    if entry_bar + HOLD > n or risk < 0.3 * a or risk > 2.5 * a: return None
    tp = p0 + sgn * TP_R * risk; mfe = mae = 0.0
    for j in range(entry_bar, entry_bar + HOLD):
        hi, lo = d["h"][j], d["l"][j]
        fav = ((hi - p0) if sgn > 0 else (p0 - lo)); adv = ((p0 - lo) if sgn > 0 else (hi - p0))
        mfe, mae = max(mfe, fav / a), max(mae, adv / a)
        hit_sl = lo <= stop if sgn > 0 else hi >= stop; hit_tp = hi >= tp if sgn > 0 else lo <= tp
        if hit_sl: return (-1.0 - COST * a / risk, j - entry_bar + 1, mfe, mae)
        if hit_tp: return (TP_R - COST * a / risk, j - entry_bar + 1, mfe, mae)
    r = (((d["c"][entry_bar + HOLD - 1] - p0) if sgn > 0 else (p0 - d["c"][entry_bar + HOLD - 1])) / risk) - COST * a / risk
    return (r, HOLD, mfe, mae)

def first_after(evs, name, sgn, lo, hi, after=None):
    for conf, nm, dr in evs:
        if nm == name and dr == sgn and lo <= conf <= hi and (after is None or conf > after): return conf
    return None

MODELS = {
    "M0 hned při signálu (kontrola, stop 1,5 ATR)": None,
    "M1 CHOCH po signálu": lambda ev, s, e, sg: first_after(ev, "CHOCH", sg, e, e + 11),
    "M2 BOS po signálu": lambda ev, s, e, sg: first_after(ev, "BOS", sg, e, e + 11),
    "M3 SWEEP po signálu": lambda ev, s, e, sg: first_after(ev, "SWEEP", sg, e, e + 11),
    "M4 DISPLACEMENT po signálu": lambda ev, s, e, sg: first_after(ev, "DISPLACEMENT", sg, e, e + 11),
    "M5 SWEEP → CHOCH (do 6 sv.)": lambda ev, s, e, sg: (lambda sw: None if sw is None else first_after(ev, "CHOCH", sg, sw, sw + 6, after=sw - 1))(first_after(ev, "SWEEP", sg, e - 3, e + 8)),
    "M6 CHOCH → retest FVG (do 8 sv.)": lambda ev, s, e, sg: (lambda ch: None if ch is None else first_after(ev, "FVG_RETEST", sg, ch + 1, ch + 8))(first_after(ev, "CHOCH", sg, e, e + 8)),
    "M7 DISPLACEMENT → FVG → retest": lambda ev, s, e, sg: (lambda dp: None if dp is None else (lambda fv: None if fv is None else first_after(ev, "FVG_RETEST", sg, fv + 1, fv + 10))(first_after(ev, "FVG", sg, dp, dp + 2)))(first_after(ev, "DISPLACEMENT", sg, e, e + 6)),
    "M8 ENGULF nebo PIN po signálu": lambda ev, s, e, sg: min([x for x in (first_after(ev, "ENGULF", sg, e, e + 11), first_after(ev, "PIN", sg, e, e + 11)) if x is not None], default=None),
    "M9 BOS + displacement současně (do 2 sv.)": lambda ev, s, e, sg: (lambda b: None if b is None else first_after(ev, "DISPLACEMENT", sg, b - 2, b + 2))(first_after(ev, "BOS", sg, e, e + 9)),
}
trades = []
for _, r in df.iterrows():
    d = DATA[r["pair"]]; sg = 1 if r["type"] == "LONG" else -1; e = int(r["entry_idx"]); s = e - 1; a = r["atr"]; ev = d["ev"]
    for name, rule in MODELS.items():
        if rule is None:
            eb = e; p0 = d["o"][e]; stop = p0 - sg * 1.5 * a
        else:
            trig = rule(ev, s, e, sg)
            if trig is None: continue
            eb = trig + 1
            if eb >= len(d["c"]): continue
            lo_i = max(0, s - 2)
            stop = (d["l"][lo_i:trig + 1].min() - 0.1 * a) if sg > 0 else (d["h"][lo_i:trig + 1].max() + 0.1 * a)
        res = simulate(d, eb, sg, stop, a)
        if res is None: continue
        # nulová kontrola: stejný pár, směr, vzdálenost stopu, ale náhodná doba vstupu (mimo ±12 svíček od signálu)
        n = len(d["c"]); nulls = []
        for _ in range(15):
            k = int(rng.integers(40, n - HOLD - 2))
            if abs(k - e) <= 12: continue
            pk = d["o"][k]; risk = abs(d["o"][eb] - stop)
            ns = simulate(d, k, sg, pk - sg * risk, a)
            if ns: nulls.append(ns[0])
        trades.append(dict(model=name, pair=r["pair"], type=r["type"], since=r["since"], cluster=r["since"], entry_bar=eb, bars_after_signal=eb - e,
                           R=res[0], held=res[1], mfe=res[2], mae=res[3], null_R=float(np.mean(nulls)) if nulls else np.nan))
T = pd.DataFrame(trades); T.to_csv(os.path.join(HERE, "out", "model_trades.csv"), index=False)

def boot_mean(x, cl, B=2000):
    ucl, inv = np.unique(cl, return_inverse=True); m = len(ucl)
    s_ = np.bincount(inv, weights=x, minlength=m); n_ = np.bincount(inv, minlength=m).astype(float)
    W = rng.multinomial(m, np.ones(m) / m, size=B).astype(float); sm = (W @ s_) / np.maximum(W @ n_, 1)
    return float(np.percentile(sm, 2.5)), float(np.percentile(sm, 97.5)), float(2 * min((sm <= 0).mean(), (sm >= 0).mean()))
out = []
for name in MODELS:
    for part, x in (("vývoj", T[(T.model == name) & (T.since < SPLIT)]), ("test", T[(T.model == name) & (T.since >= SPLIT)])):
        if len(x) < 10: out.append(dict(model=name, part=part, n=len(x))); continue
        R = x.R.values; ex = x.R.values - x.null_R.fillna(x.null_R.mean()).values
        lo, hi, p = boot_mean(R, x.cluster.values); dlo, dhi, dp = boot_mean(ex, x.cluster.values)
        out.append(dict(model=name, part=part, n=len(x), winrate=(R > 0).mean(), exp_R=R.mean(), exp_lo=lo, exp_hi=hi, null_R=x.null_R.mean(), edge_vs_null=ex.mean(), edge_lo=dlo, edge_hi=dhi, edge_p=dp,
                        mfe=x.mfe.mean(), mae=x.mae.mean(), held=x.held.mean(), bars_after=x.bars_after_signal.mean()))
O = pd.DataFrame(out); O.to_csv(os.path.join(HERE, "out", "model_results.csv"), index=False)
pd.set_option("display.width", 250); pd.set_option("display.max_columns", 30)
print(O.round(3).to_string(index=False))

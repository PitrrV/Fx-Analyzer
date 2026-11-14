"""Etapa C: dataset signálů (všech 28 párů) + tradovatelné výsledky + vlastnosti v okamžiku signálu + časování struktur po signálu.
Výstup: out/signals.csv, out/events_first_post.json. Vše point-in-time; produkční kód se nemění."""
import sys, os, json, math, datetime as dt, bisect
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, pandas as pd
import lib, features as F

PAIRS = lib.pairs()
CCY = sorted({p[:3] for p in PAIRS} | {p[3:] for p in PAIRS})
H4S = 4 * 3600

# ---------- načtení dat
D = {}
for p in PAIRS:
    h4, d1 = lib.load(p)
    t = np.array(h4["t"]); o, h, l, c = [np.array(h4[k], float) for k in "ohlc"]
    tr, atr = F.tr_atr(h, l, c)
    ev = F.events_h4(t, o, h, l, c, atr)
    zones4 = F.build_zones(o, h, l, c, atr)
    t1 = np.array(d1["t"]); o1, h1, l1, c1 = [np.array(d1[k], float) for k in "ohlc"]
    _, atr1 = F.tr_atr(h1, l1, c1)
    zones1 = F.build_zones(o1, h1, l1, c1, atr1)
    # týdenní svíčky z D1 (ISO týden)
    wk = {}
    for i in range(len(t1)):
        d = lib.utc_date(t1[i]); key = d - dt.timedelta(days=d.weekday())
        wk.setdefault(key, []).append(i)
    keys = sorted(wk); tw = np.array([int(dt.datetime(k.year, k.month, k.day, tzinfo=dt.timezone.utc).timestamp()) for k in keys])
    ow = np.array([o1[wk[k][0]] for k in keys]); hw = np.array([h1[wk[k]].max() for k in keys]); lw = np.array([l1[wk[k]].min() for k in keys]); cw = np.array([c1[wk[k][-1]] for k in keys])
    _, atrw = F.tr_atr(hw, lw, cw, 8)
    zonesw = F.build_zones(ow, hw, lw, cw, atrw, k=2, look=4, imp=1.5)
    evmap = {}
    for conf, name, d_ in ev: evmap.setdefault((name, d_), []).append(conf)
    D[p] = dict(t=t, o=o, h=h, l=l, c=c, atr=atr, ev=ev, evmap={k: np.array(v) for k, v in evmap.items()}, z4=zones4,
                t1=t1, o1=o1, h1=h1, l1=l1, c1=c1, atr1=atr1, z1=zones1, tw=tw, zw=zonesw)

# ---------- cenová síla měn (globální H4 osa)
allt = sorted(set(np.concatenate([D[p]["t"] for p in PAIRS]).tolist()))
gidx = {tt: i for i, tt in enumerate(allt)}
CL = pd.DataFrame({p: pd.Series(D[p]["c"], index=D[p]["t"]) for p in PAIRS}).reindex(allt).ffill(limit=3)
LOG = np.log(CL)
def strength(w):
    r = LOG - LOG.shift(w); out = {}
    for ccy in CCY:
        parts = [r[p] if p[:3] == ccy else -r[p] for p in PAIRS if ccy in (p[:3], p[3:])]
        out[ccy] = pd.concat(parts, axis=1).mean(axis=1)
    return pd.DataFrame(out)
S6, S30 = strength(6), strength(30)           # 24 h a 5 dní
def pct_rank(series, i, win=360):
    x = series.iloc[max(0, i - win):i + 1].abs().dropna()
    return float((x < abs(series.iloc[i])).mean()) if len(x) > 30 else np.nan

# ---------- COT (point-in-time: dostupné od soboty po úterním reportu)
cot = json.load(open(os.path.join(lib.ROOT, "data", "cot_hist.json")))["weeks"]
cotser = {}
for wkd in sorted(cot):
    for ccy, rr in (cot[wkd].get("raw") or {}).items():
        if rr and rr.get("levNet") is not None:
            avail = int(dt.datetime.fromisoformat(wkd).replace(tzinfo=dt.timezone.utc).timestamp()) + 4 * 86400
            cotser.setdefault(ccy, []).append((avail, rr["levNet"]))
def cot_state(ccy, ts):
    s = cotser.get(ccy)
    if not s: return None
    k = bisect.bisect_right([a for a, _ in s], ts)
    if k < 27: return None
    v = [x for _, x in s[:k]]; cur = v[-1]
    pr = 100 * sum(1 for x in v[:-1] if x < cur) / (len(v) - 1)
    return "STRONG" if pr >= 67 else "WEAK" if pr <= 33 else "NEUTRAL"

# ---------- zóny: nejbližší platná zóna v ATR
def zone_feat(zs, kind, price, atr_ref, valid):
    best = None
    for z in zs:
        if z["kind"] != kind or not valid(z): continue
        d = 0.0 if z["lo"] <= price <= z["hi"] else (price - z["hi"] if price > z["hi"] else z["lo"] - price)
        d /= atr_ref
        if best is None or d < best: best = d
    return best

rows, first_post = [], {}
ALIGNED = ["ENGULF", "PIN", "DISPLACEMENT", "RANGE_EXPANSION", "STREAK_EXHAUST", "WICK_CLUSTER", "FVG", "FVG_RETEST", "SWEEP", "BOS", "CHOCH", "EQUAL_HIGHS",
           "EQUAL_LOWS", "DOUBLE_BOTTOM", "DOUBLE_TOP", "TRIPLE_BOTTOM", "TRIPLE_TOP", "HEAD_SHOULDERS", "INV_HEAD_SHOULDERS", "RISING_WEDGE", "FALLING_WEDGE", "BREAKOUT", "FAILED_BREAKOUT"]
NEUTRAL = ["NR7", "COMPRESSION", "TRIANGLE"]
START = int(dt.datetime(2024, 12, 16, tzinfo=dt.timezone.utc).timestamp())

def path_metrics(d, e, p0, sgn, a, n):
    """Výsledky od vstupu v otevření svíčky e (cena p0), ATR a. Vrací MFE/MAE v ATR pro horizonty a first-touch ±1 ATR do 12 svíček."""
    out = {}
    hh, ll = d["h"], d["l"]
    for hz in (1, 2, 3, 6, 12):
        if e + hz > n: out[f"mfe{hz}"] = out[f"mae{hz}"] = np.nan; continue
        seg_h, seg_l = hh[e:e + hz], ll[e:e + hz]
        fav = (seg_h.max() - p0) / a if sgn > 0 else (p0 - seg_l.min()) / a
        adv = (p0 - seg_l.min()) / a if sgn > 0 else (seg_h.max() - p0) / a
        out[f"mfe{hz}"], out[f"mae{hz}"] = fav, adv
        out[f"ret{hz}"] = ((d["c"][e + hz - 1] - p0) if sgn > 0 else (p0 - d["c"][e + hz - 1])) / a   # výsledek na konci horizontu (close), v ATR
    win = np.nan; t_mfe = np.nan; t_imp = np.nan; pull = np.nan
    if e + 12 <= n:
        win = 0
        for j in range(e, e + 12):
            f = ((hh[j] - p0) if sgn > 0 else (p0 - ll[j])) / a; ad = ((p0 - ll[j]) if sgn > 0 else (hh[j] - p0)) / a
            if ad >= 1.0: win = 0; break           # při současném zásahu (stejná svíčka) bere konzervativně ztrátu
            if f >= 1.0: win = 1; break
        favs = [((hh[j] - p0) if sgn > 0 else (p0 - ll[j])) / a for j in range(e, e + 12)]
        t_mfe = int(np.argmax(favs)) + 1
        k1 = next((i for i, v in enumerate(favs) if v >= 1.0), None); t_imp = k1 + 1 if k1 is not None else np.nan
        upto = (k1 + 1) if k1 is not None else 12
        pull = max(((p0 - ll[j]) if sgn > 0 else (hh[j] - p0)) / a for j in range(e, e + upto))
    out.update(win1atr=win, t_mfe_bars=t_mfe, t_impulse_bars=t_imp, pullback_before_impulse=pull)
    return out

nsig = 0
for p in PAIRS:
    d = D[p]; n = len(d["c"]); t = d["t"]
    for ep in lib.episodes_d1(p):
        since_ts = int(dt.datetime.fromisoformat(ep["since"]).replace(tzinfo=dt.timezone.utc).timestamp())
        if since_ts < START: continue
        e = int(np.searchsorted(t, since_ts, side="left"))
        if e >= n or t[e] - since_ts > H4S or e < 40: continue
        s = e - 1; sgn = 1 if ep["type"] == "LONG" else -1; a = d["atr"][s]
        if not a or np.isnan(a): continue
        p0 = d["o"][e]
        row = dict(pair=p, type=ep["type"], since=ep["since"], since_ts=since_ts, rp=ep["rp"], er=ep["er"], entry_idx=e, entry_price=p0, atr=a,
                   atr_pct=a / p0 * 100, cluster=ep["since"], dur_days=(None if ep["ended_after_i"] is None else ep["ended_after_i"] - ep["i0"] + 1))
        row.update(path_metrics(d, e, p0, sgn, a, n))
        # legacy (zpětně určený) výsledek: změna ceny do dne zániku signálu
        i_end = (ep["ended_after_i"] + 1) if ep["ended_after_i"] is not None else None
        if i_end is not None and i_end < len(d["c1"]):
            pc = (d["c1"][i_end] / ep["onset_close"] - 1) * 100 * sgn
            row["legacy_pct"] = pc; row["legacy"] = "CORRECT" if pc > 0.05 else "WRONG" if pc < -0.05 else "CHOP"
        # --- struktury ve vlastnostech: PŘED (8/12/24), PŘI (poslední uzavřená svíčka), PO (první výskyt 1..12)
        for name in ALIGNED + NEUTRAL:
            for dr in ((sgn,) if name in ALIGNED else (0,)):
                arr = d["evmap"].get((name, dr))
                if arr is None: arr = np.array([], int)
                for w in (8, 12, 24):
                    row[f"pre{w}_{name}"] = int(((arr > s - w) & (arr <= s)).any())
                row[f"at_{name}"] = int((arr == s).any())
                fut = arr[(arr >= e) & (arr < e + 12)]
                row[f"post_first_{name}"] = int(fut[0] - e + 1) if len(fut) else 0   # 1 = svíčka vstupu, 0 = nenastalo
            if name in ALIGNED:  # protiběžný směr jako kontrola
                arr = d["evmap"].get((name, -sgn), np.array([], int))
                row[f"opp_pre12_{name}"] = int(((arr > s - 12) & (arr <= s)).any())
        # --- zóny
        px = d["c"][s]
        k_in, k_out = ("demand", "supply") if sgn > 0 else ("supply", "demand")
        zn = lambda zs, kind, valid, ar: zone_feat(zs, kind, px, ar, valid)
        v4 = lambda z: z["conf"] <= s and (z["inv"] is None or z["inv"] > s)
        ts1 = lambda z: True
        t1 = d["t1"]; i1 = int(np.searchsorted(t1, since_ts, side="left")) - 1   # poslední uzavřená D1 před vstupem
        a1 = d["atr1"][i1] if i1 >= 0 else np.nan
        v1 = lambda z: z["conf"] <= i1 and (z["inv"] is None or z["inv"] > i1)
        iw = int(np.searchsorted(d["tw"], since_ts, side="right")) - 2           # poslední UZAVŘENÝ týden
        vw = lambda z: z["conf"] <= iw and (z["inv"] is None or z["inv"] > iw)
        row["dist_zone_h4"] = zn(d["z4"], k_in, v4, a); row["dist_opp_zone_h4"] = zn(d["z4"], k_out, v4, a)
        row["dist_zone_d1"] = zn(d["z1"], k_in, v1, a); row["dist_opp_zone_d1"] = zn(d["z1"], k_out, v1, a)
        row["dist_zone_w1"] = zn(d["zw"], k_in, vw, a); row["dist_opp_zone_w1"] = zn(d["zw"], k_out, vw, a)
        # PDH/PDL (předchozí UTC den) a sweep
        if i1 >= 0:
            pdh, pdl = d["h1"][i1], d["l1"][i1]
            row["dist_pdl_atr"] = (px - pdl) / a; row["dist_pdh_atr"] = (pdh - px) / a
            seg = slice(max(0, s - 5), s + 1)
            row["sweep_pdl_6"] = int((d["l"][seg] < pdl).any() and d["c"][s] > pdl); row["sweep_pdh_6"] = int((d["h"][seg] > pdh).any() and d["c"][s] < pdh)
        # 20denní a 60denní extrém (v ATR)
        row["dist_20d_extreme"] = ((px - d["l"][max(0, s - 119):s + 1].min()) if sgn > 0 else (d["h"][max(0, s - 119):s + 1].max() - px)) / a
        # --- cenová síla měn
        gi = gidx[int(t[s])]; b, q = p[:3], p[3:]
        for nm, S in (("s6", S6), ("s30", S30)):
            sb, sq = S[b].iloc[gi], S[q].iloc[gi]
            row[f"{nm}_base"], row[f"{nm}_quote"] = sb * 100, sq * 100
            row[f"{nm}_diff_signed"] = (sb - sq) * 100 * sgn           # kladné = síla už jde ve směru signálu
        dif = (S6[b] - S6[q]) * sgn * 100
        for k in (1, 2, 3, 6):
            row[f"s6_slope_{k*4}h"] = dif.iloc[gi] - dif.iloc[gi - k]  # změna za 4/8/12/24 h do signálu (kladné = zlepšuje se ve směru signálu)
        row["s30_extreme_pct"] = pct_rank((S30[b] - S30[q]), gi)
        row["s6_turning"] = int(dif.iloc[gi] < 0 and dif.iloc[gi] - dif.iloc[gi - 3] > 0)   # síla proti signálu, ale už se obrací
        for k in (1, 2, 3, 6):
            row[f"s6_post_{k*4}h"] = (dif.iloc[min(len(dif) - 1, gi + k)] - dif.iloc[gi]) if gi + k < len(dif) else np.nan  # popis: změna po signálu
        # --- COT
        bC, qC = cot_state(b, since_ts), cot_state(q, since_ts)
        row["cot_base"], row["cot_quote"] = bC, qC
        if (bC == "STRONG" and qC == "WEAK") or (bC == "WEAK" and qC == "STRONG"):
            agrees = (bC == "STRONG") == (sgn > 0); row["cot_combo"] = "diverg_agree" if agrees else "diverg_contra"
        elif bC and qC: row["cot_combo"] = "both_strong" if bC == qC == "STRONG" else "both_weak" if bC == qC == "WEAK" else "mixed"
        else: row["cot_combo"] = None
        row["month"] = ep["since"][:7]
        rows.append(row); nsig += 1
df = pd.DataFrame(rows)
df.to_csv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "signals.csv"), index=False)
print("signálů", len(df), "| s kompletním 48h výsledkem", int(df.win1atr.notna().sum()), "| od", df.since.min(), "do", df.since.max())
print("win (+1 ATR před −1 ATR do 48 h):", round(df.win1atr.mean() * 100, 1), "%  (n =", int(df.win1atr.notna().sum()), ")")
print(df.groupby("type").win1atr.agg(["mean", "count"]).round(3))

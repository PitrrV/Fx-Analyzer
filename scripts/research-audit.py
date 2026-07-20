#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Per-měnový a per-párový statistický audit FX Analyzeru.

Vstupy (vše už v repu):
  data/fx_daily/*.json      denní ceny 28 párů (~2000/2003 → dnes)
  data/research/fred.json   FRED série (sazby, výnosy, CPI, VIX, komodity, DXY)
  data/research/cot_legacy.json  COT noncomm/commercial od ~1986
  data/research/cot_tff.json     TFF dealer/asset mgr/leveraged od 2006

Disciplína proti look-ahead:
  - měsíční makro série (sazby/CPI/výnosy) posunuty o 1 MĚSÍC (publikační lag)
  - COT posunut o 1 týden (páteční publikace úterních dat)
  - sezónnost walk-forward (expanding, jen minulé roky, min 5 let)
  - sign-trading test: signál z týdne T → return T→T+h
  - subperiody hodnoceny odděleně, "robustní" = shoda znaménka IC
    v ≥3 ze 4 posledních subperiod A |IC| celkově ≥ 0.03 A bootstrap p<0.10

Výstup: data/research/audit_results.json (+ stdout souhrn).
"""
import json, math, os, sys
import numpy as np
import pandas as pd
from scipy.stats import spearmanr

ROOT = os.path.join(os.path.dirname(__file__), "..")
CUR = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"]
PAIRS = ["EURUSD","USDJPY","GBPUSD","AUDUSD","USDCAD","USDCHF","NZDUSD","EURGBP",
         "EURCHF","EURAUD","EURCAD","EURJPY","EURNZD","GBPCHF","GBPJPY","GBPAUD",
         "GBPCAD","GBPNZD","AUDCAD","AUDJPY","AUDNZD","AUDCHF","NZDCAD","NZDJPY",
         "NZDCHF","CADJPY","CADCHF","CHFJPY"]
SUBPERIODS = [("2008-2012","2008-01-01","2012-12-31"),
              ("2012-2016","2012-01-01","2016-12-31"),
              ("2016-2020","2016-01-01","2020-12-31"),
              ("2020-2023","2020-01-01","2023-12-31"),
              ("2023-now","2023-01-01","2099-01-01")]
FCUR = {"US":"USD","EA":"EUR","GB":"GBP","JP":"JPY","AU":"AUD","CA":"CAD","CH":"CHF","NZ":"NZD"}

def load_json(p):
    with open(os.path.join(ROOT, p)) as f: return json.load(f)

# ── 1) denní ceny párů → weekly (pátek) log-return per pár + basket per měna ──
def build_prices():
    daily = {}
    for p in PAIRS:
        d = load_json(f"data/fx_daily/{p}.json")
        s = pd.Series(d["closes"], index=pd.to_datetime(d["dates"]))
        s = s[~s.index.duplicated()].sort_index()
        daily[p] = s
    px = pd.DataFrame(daily)
    wk = px.resample("W-FRI").last()
    ret = np.log(wk).diff()          # weekly log return per pair
    # basket: průměr sign-adjusted returnů párů obsahujících měnu
    basket = {}
    for c in CUR:
        cols = []
        for p in PAIRS:
            b, q = p[:3], p[3:]
            if b == c: cols.append(ret[p])
            elif q == c: cols.append(-ret[p])
        basket[c] = pd.concat(cols, axis=1).mean(axis=1)
    bk = pd.DataFrame(basket)
    return wk, ret, bk

# ── 2) FRED faktory ──
def build_fred():
    fred = load_json("data/research/fred.json")
    def ser(key):
        rows = fred.get(key) or []
        if not rows: return pd.Series(dtype=float)
        s = pd.Series([r["v"] for r in rows], index=pd.to_datetime([r["d"] for r in rows]))
        return s[~s.index.duplicated()].sort_index()
    out = {}
    # globální denní → weekly
    for k in ["vix","wti","dxy_broad","us2y","us10y","gold_pm"]:
        out[k] = ser(k).resample("W-FRI").last()
    # měsíční per měna: posun o 1 měsíc (publikační lag), pak weekly ffill
    def monthly_lagged(prefix):
        d = {}
        for code, ccy in FCUR.items():
            s = ser(f"{prefix}_{code}")
            if s.empty: continue
            s = s.shift(1, freq="MS") if False else s  # index už je začátek měsíce
            s.index = s.index + pd.DateOffset(months=1)   # známo až měsíc poté
            d[ccy] = s.resample("W-FRI").last().ffill()
        return pd.DataFrame(d)
    out["ir3m"] = monthly_lagged("ir3m")
    out["y10"] = monthly_lagged("y10")
    out["cpi"] = monthly_lagged("cpi")
    for k in ["copper","iron_ore","gold_imf"]:
        s = ser(k); s.index = s.index + pd.DateOffset(months=1)
        out[k] = s.resample("W-FRI").last().ffill()
    return out

# ── 3) COT faktory (net/OI; +1 týden lag) ──
def build_cot():
    legacy = load_json("data/research/cot_legacy.json")
    tff = load_json("data/research/cot_tff.json")
    def to_df(rows, cols):
        if not rows: return pd.DataFrame()
        df = pd.DataFrame(rows)
        df["d"] = pd.to_datetime(df["d"])
        df = df.sort_values("d").drop_duplicates("d", keep="last").set_index("d")
        return df
    nc, comm, dealer, am, lev = {}, {}, {}, {}, {}
    for c in CUR:
        df = to_df(legacy.get(c), None)
        if not df.empty:
            oi = df["oi"].replace(0, np.nan)
            nc[c] = ((df["ncl"] - df["ncs"]) / oi)
            comm[c] = ((df["cl"] - df["cs"]) / oi)
        df2 = to_df(tff.get(c), None)
        if not df2.empty:
            oi2 = df2["oi"].replace(0, np.nan)
            dealer[c] = ((df2["dl"] - df2["dsh"]) / oi2)
            am[c] = ((df2["aml"] - df2["ams"]) / oi2)
            lev[c] = ((df2["lml"] - df2["lms"]) / oi2)
    def weekly(d):
        df = pd.DataFrame(d)
        if df.empty: return df
        df = df.resample("W-FRI").last().ffill(limit=3)
        return df.shift(1)  # publikace v pátek po úterním reportu → bezpečně +1 týden
    return {"cot_nc": weekly(nc), "cot_comm": weekly(comm),
            "cot_dealer": weekly(dealer), "cot_am": weekly(am), "cot_lev": weekly(lev)}

# ── 4) panel faktorů per měna ──
def build_panel(bk, fred, cot):
    idx = bk.index
    others = {c: [x for x in CUR if x != c] for c in CUR}
    F = {}  # factor -> DataFrame[ccy]
    def rel(df):  # hodnota měny minus průměr ostatních
        if df.empty: return df
        df = df.reindex(idx).ffill(limit=8)
        out = {}
        for c in CUR:
            if c not in df.columns: continue
            oth = [o for o in others[c] if o in df.columns]
            out[c] = df[c] - df[oth].mean(axis=1)
        return pd.DataFrame(out)
    F["carry3m"] = rel(fred["ir3m"])
    F["y10diff"] = rel(fred["y10"])
    ry = fred["ir3m"] - fred["cpi"]
    F["realyield"] = rel(ry)
    F["cpi_accel"] = rel(fred["cpi"].diff(13))  # ~3 měsíce v týdnech po ffill → použij diff 13 týdnů
    for k in ["cot_nc","cot_comm","cot_dealer","cot_am","cot_lev"]:
        F[k] = cot[k].reindex(idx)
    F["mom4"] = bk.rolling(4).sum()
    F["mom12"] = bk.rolling(12).sum()
    F["vol4"] = bk.rolling(4).std()
    # globální faktory (stejné pro všechny měny — testují se per měna zvlášť)
    vix = fred["vix"].reindex(idx).ffill(limit=2)
    F["vix_lvl"] = pd.DataFrame({c: vix for c in CUR})
    F["vix_chg4"] = pd.DataFrame({c: vix.diff(4) for c in CUR})
    for k, name in [("wti","oil_r4"),("gold_pm","gold_r4"),("copper","copper_r4"),("dxy_broad","dxy_r4")]:
        s = np.log(fred[k].reindex(idx).ffill(limit=8)).diff(4)
        F[name] = pd.DataFrame({c: s for c in CUR})
    # walk-forward sezónnost: expanding průměr basket returnu daného měsíce (min 5 let)
    seas = {}
    for c in CUR:
        r = bk[c]
        vals = np.full(len(r), np.nan)
        # pro týden v měsíci m použij průměr měsíčních součtů z LET < aktuální rok
        monthly_sums = r.groupby([r.index.year, r.index.month]).sum()
        for i, (ts, val) in enumerate(r.items()):
            y, m = ts.year, ts.month
            hist = [monthly_sums.get((yy, m), np.nan) for yy in range(y - 25, y)]
            hist = [h for h in hist if not math.isnan(h)]
            if len(hist) >= 5: vals[i] = float(np.mean(hist))
        seas[c] = pd.Series(vals, index=r.index)
    F["seasonal_wf"] = pd.DataFrame(seas)
    return F

# ── 5) testy ──
def block_bootstrap_p(x, y, ic, n=500, block=8):
    """p-hodnota IC přes moving-block bootstrap (H0: nezávislost, zachovaná
    autokorelace y). Vektorizováno: spearman = pearson ranků; ranky y se
    přeuspořádají po blocích, korelace se počítá maticově pro všech n
    bootstrapů najednou (aproximace: ranky převzaté z plné řady)."""
    m = len(x)
    if m < 60: return None
    rng = np.random.default_rng(42)
    rx = pd.Series(x.values).rank().values
    ry = pd.Series(y.values).rank().values
    rx = (rx - rx.mean()) / rx.std()
    ry_c = (ry - ry.mean()) / ry.std()
    nblocks = math.ceil(m / block)
    starts = rng.integers(0, m - block, size=(n, nblocks))
    idx = (starts[:, :, None] + np.arange(block)[None, None, :]).reshape(n, -1)[:, :m]
    boots = ry_c[idx]                        # (n, m)
    boots = (boots - boots.mean(axis=1, keepdims=True)) / (boots.std(axis=1, keepdims=True) + 1e-12)
    corrs = boots @ rx / m                   # (n,)
    return float((np.abs(corrs) >= abs(ic)).mean())

def eval_factor(sig, fwd):
    df = pd.concat([sig, fwd], axis=1, keys=["s","f"]).dropna()
    if len(df) < 60: return None
    ic, _ = spearmanr(df["s"], df["f"])
    p = block_bootstrap_p(df["s"], df["f"], ic)
    # sign-trading PF
    d = np.sign(df["s"]); r = d * df["f"]
    gp = r[r > 0].sum(); gl = -r[r < 0].sum()
    pf = float(gp / gl) if gl > 0 else None
    subs = {}
    for name, a, b in SUBPERIODS:
        sl = df.loc[a:b]
        if len(sl) < 40: subs[name] = None; continue
        ric, _ = spearmanr(sl["s"], sl["f"])
        subs[name] = round(float(ric), 3)
    # robustnost: poslední 4 subperiody se známou hodnotou, shoda znaménka s celkovým IC
    known = [v for k, v in subs.items() if v is not None][-4:]
    agree = sum(1 for v in known if np.sign(v) == np.sign(ic)) if known else 0
    robust = bool(len(known) >= 3 and agree >= 3 and abs(ic) >= 0.03 and (p is not None and p < 0.10))
    return {"n": int(len(df)), "ic": round(float(ic), 4), "p_boot": (round(p, 3) if p is not None else None),
            "pf_sign": (round(pf, 3) if pf else None), "sub_ic": subs, "sub_agree": int(agree), "robust": robust}

def main():
    print("Načítám ceny…"); wk, pret, bk = build_prices()
    print("FRED…"); fred = build_fred()
    print("COT…"); cot = build_cot()
    print("Panel…"); F = build_panel(bk, fred, cot)
    # forward return: součet příštích h týdenních returnů (t+1 … t+h)
    fwd = {h: bk[::-1].rolling(h).sum()[::-1].shift(-1) for h in (1, 4)}

    results = {"currencies": {}, "pairs": {}}
    for c in CUR:
        res_c = {}
        for fname, df in F.items():
            if c not in df.columns: continue
            for h in (1, 4):
                r = eval_factor(df[c], fwd[h][c])
                if r: res_c[f"{fname}_h{h}"] = r
        results["currencies"][c] = res_c
        top = sorted(((k, v) for k, v in res_c.items() if v["robust"]), key=lambda kv: -abs(kv[1]["ic"]))
        print(f"\n{c}: robustní faktory: " + (", ".join(f"{k} IC={v['ic']}" for k, v in top[:6]) if top else "ŽÁDNÝ"))

    # páry: signál = diff faktorů base−quote, cíl = forward return páru
    pret_wk = pret  # weekly log returns per pair
    for p in PAIRS:
        b, q = p[:3], p[3:]
        fwd_p = {h: pret_wk[p][::-1].rolling(h).sum()[::-1].shift(-1) for h in (1, 4)}
        res_p = {}
        for fname, df in F.items():
            if b not in df.columns or q not in df.columns: continue
            sig = df[b] - df[q]
            if fname in ("vix_lvl","vix_chg4","oil_r4","gold_r4","copper_r4","dxy_r4"):
                sig = df[b]  # globální faktor: diff je 0 → testuj level přímo proti páru
            for h in (1, 4):
                r = eval_factor(sig, fwd_p[h])
                if r: res_p[f"{fname}_h{h}"] = r
        results["pairs"][p] = res_p

    out = os.path.join(ROOT, "data/research/audit_results.json")
    with open(out, "w") as f: json.dump({"updated": pd.Timestamp.utcnow().isoformat(),
                                          "subperiods": [s[0] for s in SUBPERIODS],
                                          "results": results}, f)
    print("\nOK →", out)

if __name__ == "__main__":
    main()

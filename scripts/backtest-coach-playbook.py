#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Backtest postupu z "Nedělní kouč" PDF, tak jak je popsaný — ne jednotlivé
faktory zvlášť (to už je hotové v research-audit.py), ale KOMBINACI, kterou má
uživatel skutečně použít: vlastní ověřený faktor měny (COT AM u JPY, VIX u
AUD/GBP, CPI akcelerace u CAD, COT commercials u CHF, DXY momentum u USD) +
RP+ER časování na konkrétním páru, ve STEJNÉM směru.

Co je VYNECHÁNO a proč (methodology, ne přehlédnutí):
  - Retail sentiment: appka sbírá historii teprve od svého spuštění, na
    víceletý point-in-time test není dost dat.
  - Kalendář (vyluč rizikové dny): data/calendar.json má jen ~1 rok zpětně
    (14denní forecast okno appky), ne dost na 20+ letý backtest.
Bez těchhle dvou složek je tenhle test OPTIMISTIČTĚJŠÍ než reálné použití
postupu (skutečný postup má dva další filtry navíc, co by některé kandidáty
vyřadily) — ber výsledek jako HORNÍ HRANICI, ne přesnou předpověď.

Vlastní faktor + směr (sign) per měna vychází PŘÍMO z data/research/audit_results.json
(currency-level IC, stejné jako v cheat sheet) — ne z nového hádání:
  AUD: vix_lvl, h4, IC>0 (vysoký VIX → AUD sílí)
  JPY: cot_am,   h4, IC<0 (extrém long JPY u Asset Mgr → JPY slábne, kontrariánsky)
  CAD: cpi_accel,h4, IC>0 (zrychlující CPI vs. ostatní → CAD sílí)
  CHF: cot_comm, h4, IC>0 (commercials extrém long CHF → CHF sílí)
  GBP: vix_lvl,  h4, IC<0 (nízký VIX → GBP sílí, opačně než AUD)
  USD: dxy_r4,   h1, IC>0 (krátkodobé DXY momentum)

RP+ER threshold přímo z engine.js (getEfficiencyRatio komentář, už dřív
backtestováno): RP>=0.80 & ER>0.5 → fade SHORT; RP<=0.20 & ER 0.20-0.65 → fade LONG.

Náklady: stejná spread/swap tabulka jako counter-audit-costs.js.
"""
import importlib.util, os, json
import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(__file__))
spec = importlib.util.spec_from_file_location("ra", os.path.join(os.path.dirname(__file__), "research-audit.py"))
ra = importlib.util.module_from_spec(spec); spec.loader.exec_module(ra)

CUR = ra.CUR
PAIRS = ra.PAIRS
PCT_WINDOW = 104  # týdnů, stejně jako COT_PCT_WINDOW v engine.js

SPREAD_PCT = {
    "EURUSD": 0.00015, "USDJPY": 0.00015, "GBPUSD": 0.0002, "AUDUSD": 0.0002, "USDCAD": 0.0002, "USDCHF": 0.0002, "NZDUSD": 0.00025,
    "EURGBP": 0.0002, "EURCHF": 0.00025, "EURAUD": 0.0003, "EURCAD": 0.0003, "EURJPY": 0.0002, "EURNZD": 0.00035,
    "GBPCHF": 0.0003, "GBPJPY": 0.00025, "GBPAUD": 0.00035, "GBPCAD": 0.00035, "GBPNZD": 0.0004,
    "AUDCAD": 0.0003, "AUDJPY": 0.00025, "AUDNZD": 0.00035, "AUDCHF": 0.0003,
    "NZDCAD": 0.00035, "NZDJPY": 0.0003, "NZDCHF": 0.00035, "CADJPY": 0.00025, "CADCHF": 0.0003, "CHFJPY": 0.0003,
}
SWAP_PCT_PER_DAY = 0.00008

# faktor, horizont (týdny), práh percentilu, per-měna reprezentativní pár
FACTORS = {
    "AUD": {"factor": "vix_lvl", "h": 4, "kind": "vix", "vix_hi": 20.0, "vix_lo": None, "pair": "AUDUSD"},
    "GBP": {"factor": "vix_lvl", "h": 4, "kind": "vix", "vix_hi": None, "vix_lo": 14.0, "pair": "GBPUSD"},
    "JPY": {"factor": "cot_am", "h": 4, "kind": "pct", "hi": 85, "lo": 15, "pair": "USDJPY"},
    "CAD": {"factor": "cpi_accel", "h": 4, "kind": "pct", "hi": 80, "lo": 20, "pair": "USDCAD"},
    "CHF": {"factor": "cot_comm", "h": 4, "kind": "pct", "hi": 80, "lo": 20, "pair": "USDCHF"},
    "USD": {"factor": "dxy_r4", "h": 1, "kind": "pct", "hi": 80, "lo": 20, "pair": "EURUSD"},
}
HORIZON_DAYS = {1: 5, 4: 20}  # týdny -> obchodní dny


def load_daily_prices():
    out = {}
    for p in PAIRS:
        d = json.load(open(os.path.join(ROOT, f"data/fx_daily/{p}.json")))
        s = pd.Series(d["closes"], index=pd.to_datetime(d["dates"]))
        out[p] = s[~s.index.duplicated()].sort_index()
    return out


def rolling_percentile(s, window=PCT_WINDOW, min_periods=52):
    """Percentil POSLEDNÍ hodnoty vůči předchozím (window-1) — stejná metoda
    jako _cotPctSeries/getCOTPercentile v engine.js (rank <= current)."""
    vals = s.values
    out = np.full(len(vals), np.nan)
    for i in range(len(vals)):
        if np.isnan(vals[i]): continue
        lo = max(0, i - window + 1)
        hist = vals[lo:i]
        hist = hist[~np.isnan(hist)]
        if len(hist) < min_periods: continue
        out[i] = (hist <= vals[i]).sum() / len(hist) * 100
    return pd.Series(out, index=s.index)


def range_position_and_er(daily, asof, days=10):
    s = daily[daily.index <= asof].tail(days)
    if len(s) < days: return None, None
    mn, mx = s.min(), s.max()
    if mx <= mn: return None, None
    rp = (s.iloc[-1] - mn) / (mx - mn)
    diffs = s.diff().dropna()
    sum_abs = diffs.abs().sum()
    if sum_abs == 0: return rp, None
    er = abs(s.iloc[-1] - s.iloc[0]) / sum_abs
    return rp, er


def fade_signal(rp, er):
    if rp is None or er is None: return None
    if rp >= 0.80 and er > 0.5: return "SHORT"
    if rp <= 0.20 and 0.20 <= er <= 0.65: return "LONG"
    return None


def main():
    print("Načítám ceny/FRED/COT/panel (sdíleno s research-audit.py)…")
    wk, pret, bk = ra.build_prices()
    fred = ra.build_fred()
    cot = ra.build_cot()
    F = ra.build_panel(bk, fred, cot)
    daily = load_daily_prices()

    audit = json.load(open(os.path.join(ROOT, "data/research/audit_results.json")))["results"]["currencies"]

    # percentily / VIX série pro každou měnu
    pct_series = {}
    for ccy, cfg in FACTORS.items():
        if cfg["kind"] == "pct":
            pct_series[ccy] = rolling_percentile(F[cfg["factor"]][ccy])
    vix = fred["vix"].reindex(F["vix_lvl"].index).ffill(limit=2)

    fridays = F["vix_lvl"].index
    trades = []
    detail_rows = []

    for ccy, cfg in FACTORS.items():
        ic_sign = np.sign(audit[ccy][f"{cfg['factor']}_h{cfg['h']}"]["ic"])
        pair = cfg["pair"]
        base, quote = pair[:3], pair[3:]
        hdays = HORIZON_DAYS[cfg["h"]]
        pxs = daily[pair]

        for t in fridays:
            dirC = 0
            if cfg["kind"] == "vix":
                v = vix.get(t, np.nan)
                if pd.isna(v): continue
                if cfg["vix_hi"] is not None and v >= cfg["vix_hi"]:
                    dirC = ic_sign
                elif cfg["vix_lo"] is not None and v < cfg["vix_lo"]:
                    dirC = -ic_sign
                else:
                    continue
            else:
                p = pct_series[ccy].get(t, np.nan)
                if pd.isna(p): continue
                if p >= cfg["hi"]:
                    dirC = ic_sign
                elif p <= cfg["lo"]:
                    dirC = -ic_sign
                else:
                    continue
            if dirC == 0: continue

            expected_pair_dir = dirC if base == ccy else -dirC
            rp, er = range_position_and_er(pxs, t)
            sig = fade_signal(rp, er)
            need = "LONG" if expected_pair_dir > 0 else "SHORT"
            if sig != need: continue

            # vstup: první obchodní den PO t (pondělí po páteční COT/VIX kontrole)
            after = pxs[pxs.index > t]
            if len(after) < hdays + 1: continue
            entry_px = after.iloc[0]
            entry_date = after.index[0]
            if len(after) <= hdays: continue
            exit_px = after.iloc[hdays]
            exit_date = after.index[hdays]

            log_ret = np.log(exit_px / entry_px) * expected_pair_dir
            cost = (SPREAD_PCT.get(pair, 0.00035)) + SWAP_PCT_PER_DAY * hdays
            net_ret = log_ret - cost

            trades.append({"ccy": ccy, "pair": pair, "date": str(t.date()), "entry": str(entry_date.date()),
                            "exit": str(exit_date.date()), "dir": int(expected_pair_dir),
                            "gross_ret": round(float(log_ret), 5), "net_ret": round(float(net_ret), 5)})

    df = pd.DataFrame(trades)
    print(f"\nCelkem kandidátů (COT/VIX/CPI extrém + RP+ER souhlasí): {len(df)}")

    def boot_ci(vals, n_boot=3000, seed=42):
        rng = np.random.default_rng(seed)
        vals = np.asarray(vals, dtype=float)
        if len(vals) < 5: return None
        idx = rng.integers(0, len(vals), size=(n_boot, len(vals)))
        means = vals[idx].mean(axis=1)
        lo, hi = np.percentile(means, [5, 95])
        return round(float(lo) * 100, 3), round(float(hi) * 100, 3)

    def agg(sub, label):
        n = len(sub)
        if n == 0:
            print(f"  {label}: n=0"); return {"n": 0}
        wr = round((sub["net_ret"] > 0).mean() * 100, 1)
        gp = sub.loc[sub["net_ret"] > 0, "net_ret"].sum()
        gl = -sub.loc[sub["net_ret"] < 0, "net_ret"].sum()
        pf = round(float(gp / gl), 3) if gl > 0 else None
        avg = round(float(sub["net_ret"].mean()) * 100, 3)
        ci = boot_ci(sub["net_ret"].values)
        ci_excl_zero = bool(ci and (ci[0] > 0 or ci[1] < 0))
        flag = "⚠ n<20 — NEDOSTATEČNÉ pro spolehlivý závěr" if n < 20 else ("△ n<40 — orientační, ne průkazné" if n < 40 else "OK velikost vzorku")
        sig = "★ 90% CI nezahrnuje 0 (pravděpodobně reálný efekt)" if ci_excl_zero else "○ 90% CI zahrnuje 0 — nelze odlišit od šumu"
        print(f"  {label}: n={n} · win rate={wr}% · PF={pf} · avg net ret/obchod={avg}% · 90% CI [{ci[0] if ci else '—'}%, {ci[1] if ci else '—'}%] · {flag} · {sig}")
        return {"n": n, "win_rate": wr, "pf": pf, "avg_net_ret_pct": avg, "ci90_pct": ci, "ci_excludes_zero": ci_excl_zero, "sample_flag": flag}

    print("\n=== Souhrn (net po nákladech), per měna ===")
    out = {"overall": {}, "per_currency": {}}
    out["overall"] = agg(df, "CELKEM") if len(df) else {"n": 0}
    if len(df):
        for ccy in FACTORS:
            sub = df[df["ccy"] == ccy]
            out["per_currency"][ccy] = agg(sub, ccy)

    # bonus: GBPAUD jako reprezentativní pár pro VIX signál — VIX zóny jsou vzájemně
    # výlučné (nemůže být >=20 i <14 zároveň), takže "dvojité potvrzení" ve smyslu
    # PDF (obě strany páru bez konfliktu podporují stejný směr) platí automaticky,
    # kdykoliv je VIX v JEDNÉ ze dvou zón — testuje se tedy GBPAUD misto AUDUSD/GBPUSD.
    print("\n=== Bonus: GBPAUD jako reprezentativní pár pro VIX signál (mimo hlavní test) ===")
    ic_aud = np.sign(audit["AUD"]["vix_lvl_h4"]["ic"]); ic_gbp = np.sign(audit["GBP"]["vix_lvl_h4"]["ic"])
    gbpaud = daily["GBPAUD"]
    dbl_trades = []
    for t in fridays:
        v = vix.get(t, np.nan)
        if pd.isna(v): continue
        if v >= 20.0:
            dA = ic_aud  # AUD sílí -> GBPAUD (AUD je quote) klesá
            exp = -dA
        elif v < 14.0:
            dG = -ic_gbp  # GBP sílí -> GBPAUD (GBP je base) roste
            exp = dG
        else:
            continue
        rp, er = range_position_and_er(gbpaud, t)
        sig = fade_signal(rp, er)
        need = "LONG" if exp > 0 else "SHORT"
        if sig != need: continue
        after = gbpaud[gbpaud.index > t]
        if len(after) < 21: continue
        entry_px, entry_date = after.iloc[0], after.index[0]
        exit_px, exit_date = after.iloc[20], after.index[20]
        log_ret = np.log(exit_px / entry_px) * exp
        cost = SPREAD_PCT.get("GBPAUD", 0.00035) + SWAP_PCT_PER_DAY * 20
        dbl_trades.append({"date": str(t.date()), "net_ret": round(float(log_ret - cost), 5)})
    dfd = pd.DataFrame(dbl_trades)
    out["gbpaud_double_confirm"] = agg(dfd, "GBPAUD dvojité potvrzení") if len(dfd) else {"n": 0}

    outpath = os.path.join(ROOT, "data/research/coach_playbook_backtest.json")
    json.dump({"trades": trades, "summary": out,
               "methodology": "COT/VIX/CPI extrém (own-factor, IC sign z audit_results.json) + RP+ER (RP>=0.80&ER>0.5 fade SHORT / RP<=0.20&ER 0.20-0.65 fade LONG) na reprezentativním páru vs USD. BEZ retail (krátká historie) a BEZ kalendáře (jen ~1 rok dat) — výsledek je horní hranice, ne přesná předpověď reálného použití."},
              open(outpath, "w"), ensure_ascii=False, indent=1)
    print(f"\nOK -> {outpath}")


if __name__ == "__main__":
    main()

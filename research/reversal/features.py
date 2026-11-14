"""Algoritmické detektory struktur a zón (point-in-time). Každá událost nese `conf` = index H4 svíčky, jejímž UZAVŘENÍM je podmínka
splněna. Před tímto indexem se událost nesmí použít. Jen výzkum; produkční kód se nemění."""
import numpy as np

def tr_atr(h, l, c, n=14):
    pc = np.r_[c[0], c[:-1]]
    tr = np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))
    atr = np.full(len(c), np.nan)
    cs = np.cumsum(np.r_[0, tr])
    for i in range(n - 1, len(c)):
        atr[i] = (cs[i + 1] - cs[i + 1 - n]) / n
    return tr, atr

def swings(h, l, k):
    """Potvrzené swingy: swing high v i, když h[i] > všech k vlevo a >= všech k vpravo; potvrzen až uzavřením svíčky i+k."""
    n = len(h); sh, sl = [], []
    for i in range(k, n - k):
        if h[i] > h[i - k:i].max() and h[i] >= h[i + 1:i + k + 1].max(): sh.append((i, h[i], i + k))
        if l[i] < l[i - k:i].min() and l[i] <= l[i + 1:i + k + 1].min(): sl.append((i, l[i], i + k))
    return sh, sl

def build_zones(o, h, l, c, atr, k=3, look=8, imp=1.5):
    """Algoritmické Supply/Demand zóny. Demand = swing low (potvrzený), zóna = [low, horní hrana těla svíčky], platná po impulzu
    >= imp*ATR nahoru do `look` svíček; potvrzení = max(swing potvrzení, bar impulzu). Zrušena prvním close skrz zónu.
    Vrací seznam dict(kind, lo, hi, conf, inv). Je to náhrada za subjektivní zóny, ne zaznamenaná historie."""
    sh, sl = swings(h, l, k); n = len(c); zones = []
    for kind, sw in (("demand", sl), ("supply", sh)):
        for i, px, cf in sw:
            a = atr[i] if not np.isnan(atr[i]) else None
            if a is None or a <= 0: continue
            body = max(o[i], c[i]) if kind == "demand" else min(o[i], c[i])
            lo, hi = (px, min(body, px + 1.5 * a)) if kind == "demand" else (max(body, px - 1.5 * a), px)
            dep = None
            for j in range(i + 1, min(n, i + 1 + look)):
                if kind == "demand" and h[j] - hi >= imp * a: dep = j; break
                if kind == "supply" and lo - l[j] >= imp * a: dep = j; break
            if dep is None: continue
            conf = max(cf, dep); inv = None
            for j in range(i + 1, n):
                if (kind == "demand" and c[j] < lo) or (kind == "supply" and c[j] > hi):
                    inv = j; break
            if inv is not None and inv <= conf: continue
            zones.append(dict(kind=kind, lo=float(lo), hi=float(hi), conf=int(conf), inv=inv, origin=int(i)))
    return zones

def events_h4(t, o, h, l, c, atr):
    """Všechny struktury jako (conf, jméno, směr +1 býčí / -1 medvědí). conf = index svíčky, jejíž close podmínku potvrdí."""
    n = len(c); ev = []
    tr, _ = tr_atr(h, l, c, 14)
    rng = h - l; body = abs(c - o)
    sh, sl = swings(h, l, 2)
    shc = np.array([s[2] for s in sh]) if sh else np.array([], int); slc = np.array([s[2] for s in sl]) if sl else np.array([], int)
    def last_sw(sw, confs, j, within=60):
        m = np.searchsorted(confs, j, side="right")  # potvrzené s conf <= j
        return [(sw[x][0], sw[x][1], sw[x][2]) for x in range(max(0, m - 4), m) if j - sw[x][2] <= within]
    # --- jednosvíčkové: engulfing, pin/rejection, displacement, range expansion, NR7
    for j in range(1, n):
        a = atr[j - 1] if j >= 1 and not np.isnan(atr[j - 1]) else None
        if a is None: continue
        if c[j] > o[j] and c[j - 1] < o[j - 1] and o[j] <= c[j - 1] and c[j] >= o[j - 1] and body[j] > body[j - 1]: ev.append((j, "ENGULF", 1))
        if c[j] < o[j] and c[j - 1] > o[j - 1] and o[j] >= c[j - 1] and c[j] <= o[j - 1] and body[j] > body[j - 1]: ev.append((j, "ENGULF", -1))
        if rng[j] >= 0.5 * a:
            lw = min(o[j], c[j]) - l[j]; uw = h[j] - max(o[j], c[j])
            if lw >= 2 * body[j] and lw >= 0.6 * rng[j] and c[j] >= l[j] + 0.6 * rng[j]: ev.append((j, "PIN", 1))
            if uw >= 2 * body[j] and uw >= 0.6 * rng[j] and c[j] <= h[j] - 0.6 * rng[j]: ev.append((j, "PIN", -1))
        if rng[j] >= 1.8 * a and body[j] >= 0.7 * rng[j]: ev.append((j, "DISPLACEMENT", 1 if c[j] > o[j] else -1))
        if j >= 10 and tr[j] >= 2.0 * np.mean(tr[j - 10:j]): ev.append((j, "RANGE_EXPANSION", 1 if c[j] > o[j] else -1))
        if j >= 7 and rng[j] <= rng[j - 6:j].min(): ev.append((j, "NR7", 0))
        if j >= 30 and np.mean(tr[j - 4:j + 1]) < 0.6 * np.mean(tr[j - 29:j + 1]): ev.append((j, "COMPRESSION", 0))
    # --- řady: streak (vyčerpání), wick cluster
    for j in range(5, n):
        if all(c[x] > c[x - 1] for x in range(j - 4, j + 1)): ev.append((j, "STREAK_EXHAUST", -1))  # 5 vzestupných closes -> kontext pro SHORT
        if all(c[x] < c[x - 1] for x in range(j - 4, j + 1)): ev.append((j, "STREAK_EXHAUST", 1))
    pins = {}
    for e in ev:
        if e[1] == "PIN": pins.setdefault(e[2], []).append(e[0])
    for d, lst in pins.items():
        for x in range(1, len(lst)):
            if lst[x] - lst[x - 1] <= 6 and abs((l if d > 0 else h)[lst[x]] - (l if d > 0 else h)[lst[x - 1]]) <= 0.3 * (atr[lst[x] - 1] or 1): ev.append((lst[x], "WICK_CLUSTER", d))
    # --- FVG a retest
    fvgs = []
    for j in range(2, n):
        a = atr[j - 1] if not np.isnan(atr[j - 1]) else None
        if a is None: continue
        if l[j] > h[j - 2] and l[j] - h[j - 2] >= 0.2 * a: ev.append((j, "FVG", 1)); fvgs.append((j, 1, h[j - 2], l[j]))
        if h[j] < l[j - 2] and l[j - 2] - h[j] >= 0.2 * a: ev.append((j, "FVG", -1)); fvgs.append((j, -1, h[j], l[j - 2]))
    for j0, d, glo, ghi in fvgs:
        for j in range(j0 + 1, min(n, j0 + 25)):
            if (d > 0 and c[j] < glo) or (d < 0 and c[j] > ghi): break   # gap vyplněn skrz
            if l[j] <= ghi and h[j] >= glo: ev.append((j, "FVG_RETEST", d)); break
    # --- swing-based: sweep, equal H/L, BOS/CHOCH, breakout/failed, double/triple/H&S, wedge/triangle
    broken = set()
    for j in range(5, n):
        hs = last_sw(sh, shc, j - 1); ls = last_sw(sl, slc, j - 1)
        a = atr[j - 1] if not np.isnan(atr[j - 1]) else None
        if a is None: continue
        if ls:
            i_, p_, c_ = ls[-1]
            if l[j] < p_ and c[j] > p_: ev.append((j, "SWEEP", 1))
        if hs:
            i_, p_, c_ = hs[-1]
            if h[j] > p_ and c[j] < p_: ev.append((j, "SWEEP", -1))
        # trend ze dvou posledních swingů
        if len(hs) >= 2 and len(ls) >= 2:
            up = hs[-1][1] > hs[-2][1] and ls[-1][1] > ls[-2][1]; dn = hs[-1][1] < hs[-2][1] and ls[-1][1] < ls[-2][1]
            if c[j] > hs[-1][1] and ("H", hs[-1][0]) not in broken:
                broken.add(("H", hs[-1][0])); ev.append((j, "BOS" if up else "CHOCH", 1))
            if c[j] < ls[-1][1] and ("L", ls[-1][0]) not in broken:
                broken.add(("L", ls[-1][0])); ev.append((j, "BOS" if dn else "CHOCH", -1))
        # rovné maxima/minima: dva potvrzené swingy do 0.15 ATR, potvrzení druhého = tato svíčka
        hs2 = last_sw(sh, shc, j); ls2 = last_sw(sl, slc, j)   # včetně swingu potvrzeného právě touto svíčkou
        if len(hs2) >= 2 and hs2[-1][2] == j and abs(hs2[-1][1] - hs2[-2][1]) <= 0.15 * a and hs2[-1][0] - hs2[-2][0] >= 3: ev.append((j, "EQUAL_HIGHS", -1))
        if len(ls2) >= 2 and ls2[-1][2] == j and abs(ls2[-1][1] - ls2[-2][1]) <= 0.15 * a and ls2[-1][0] - ls2[-2][0] >= 3: ev.append((j, "EQUAL_LOWS", 1))
        # double / triple top-bottom (potvrzení = close skrz neckline), H&S
        if len(ls) >= 2:
            (i1, p1, _), (i2, p2, _) = ls[-2], ls[-1]
            mid = h[i1:i2 + 1].max() if i2 > i1 else None
            if mid is not None and 6 <= i2 - i1 <= 48 and abs(p1 - p2) <= 0.25 * a and mid - max(p1, p2) >= 1.0 * a and c[j] > mid and c[j - 1] <= mid and j - i2 <= 24: ev.append((j, "DOUBLE_BOTTOM", 1))
        if len(hs) >= 2:
            (i1, p1, _), (i2, p2, _) = hs[-2], hs[-1]
            mid = l[i1:i2 + 1].min() if i2 > i1 else None
            if mid is not None and 6 <= i2 - i1 <= 48 and abs(p1 - p2) <= 0.25 * a and min(p1, p2) - mid >= 1.0 * a and c[j] < mid and c[j - 1] >= mid and j - i2 <= 24: ev.append((j, "DOUBLE_TOP", -1))
        if len(ls) >= 3:
            (i1, p1, _), (i2, p2, _), (i3, p3, _) = ls[-3], ls[-2], ls[-1]
            if i3 - i1 <= 72 and max(p1, p2, p3) - min(p1, p2, p3) <= 0.3 * a:
                nk = h[i1:i3 + 1].max()
                if c[j] > nk and c[j - 1] <= nk and j - i3 <= 24: ev.append((j, "TRIPLE_BOTTOM", 1))
                if p2 < min(p1, p3) - 0.3 * a: pass
            if p2 < min(p1, p3) - 0.3 * a and abs(p1 - p3) <= 0.5 * a and i3 - i1 <= 80:   # inverzní H&S
                nk = max(h[i1:i2 + 1].max(), h[i2:i3 + 1].max())
                if c[j] > nk and c[j - 1] <= nk and j - i3 <= 24: ev.append((j, "INV_HEAD_SHOULDERS", 1))
        if len(hs) >= 3:
            (i1, p1, _), (i2, p2, _), (i3, p3, _) = hs[-3], hs[-2], hs[-1]
            if i3 - i1 <= 72 and max(p1, p2, p3) - min(p1, p2, p3) <= 0.3 * a:
                nk = l[i1:i3 + 1].min()
                if c[j] < nk and c[j - 1] >= nk and j - i3 <= 24: ev.append((j, "TRIPLE_TOP", -1))
            if p2 > max(p1, p3) + 0.3 * a and abs(p1 - p3) <= 0.5 * a and i3 - i1 <= 80:
                nk = min(l[i1:i2 + 1].min(), l[i2:i3 + 1].min())
                if c[j] < nk and c[j - 1] >= nk and j - i3 <= 24: ev.append((j, "HEAD_SHOULDERS", -1))
        # klínové a trojúhelníkové útvary: 3 poslední swing highs a lows, formace potvrzena posledním potvrzeným swingem
        if len(hs2) >= 3 and len(ls2) >= 3 and (hs2[-1][2] == j or ls2[-1][2] == j):
            xh = np.array([s[0] for s in hs2[-3:]]); yh = np.array([s[1] for s in hs2[-3:]]); xl = np.array([s[0] for s in ls2[-3:]]); yl = np.array([s[1] for s in ls2[-3:]])
            if max(xh[-1], xl[-1]) - min(xh[0], xl[0]) <= 60:
                sH = np.polyfit(xh, yh, 1)[0]; sL = np.polyfit(xl, yl, 1)[0]; thr = 0.02 * a
                if sH > thr and sL > thr and sL > sH: ev.append((j, "RISING_WEDGE", -1))
                if sH < -thr and sL < -thr and sH < sL: ev.append((j, "FALLING_WEDGE", 1))
                if sH < -thr and sL > thr: ev.append((j, "TRIANGLE", 0))
    # --- breakout / failed breakout (20 svíček), failed auction vůči předchozímu dennímu rozsahu doplní build_dataset
    for j in range(21, n):
        hh = h[j - 20:j].max(); ll = l[j - 20:j].min()
        if c[j] > hh and c[j - 1] <= hh: ev.append((j, "BREAKOUT", 1))
        if c[j] < ll and c[j - 1] >= ll: ev.append((j, "BREAKOUT", -1))
    bo = [(e[0], e[2]) for e in ev if e[1] == "BREAKOUT"]
    for j0, d in bo:
        lvl = h[j0 - 20:j0].max() if d > 0 else l[j0 - 20:j0].min()
        for j in range(j0 + 1, min(n, j0 + 4)):
            if (d > 0 and c[j] < lvl) or (d < 0 and c[j] > lvl): ev.append((j, "FAILED_BREAKOUT", -d)); break
    ev.sort(key=lambda e: (e[0], e[1]))
    return ev

EVENT_NAMES = ["ENGULF", "PIN", "DISPLACEMENT", "RANGE_EXPANSION", "NR7", "COMPRESSION", "STREAK_EXHAUST", "WICK_CLUSTER", "FVG", "FVG_RETEST",
               "SWEEP", "BOS", "CHOCH", "EQUAL_HIGHS", "EQUAL_LOWS", "DOUBLE_BOTTOM", "DOUBLE_TOP", "TRIPLE_BOTTOM", "TRIPLE_TOP", "HEAD_SHOULDERS",
               "INV_HEAD_SHOULDERS", "RISING_WEDGE", "FALLING_WEDGE", "TRIANGLE", "BREAKOUT", "FAILED_BREAKOUT"]

"""Sdílené funkce výzkumu Reverzálu. Jen výzkum; produkční kód se nemění."""
import json, os, datetime as dt
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OHLC = os.path.join(ROOT, "data", "research", "ohlc")

def pairs():
    return sorted(f[:-5] for f in os.listdir(OHLC) if f.endswith(".json") and not f.startswith("_"))

def load(pair):
    d = json.load(open(os.path.join(OHLC, pair + ".json")))
    return d["h4"], d["d1"]

def utc_date(t):
    return dt.datetime.fromtimestamp(t, tz=dt.timezone.utc).date()

def rp_er(closes, i, n=10):
    """RP(n) a ER(n) přesně jako engine.js getRangePosition/getEfficiencyRatio, nad uzavřenými denními closes do indexu i."""
    if i < n:
        return None
    w = closes[i - n + 1:i + 1]
    mn, mx = min(w), max(w)
    if not mx > mn:
        return None
    rp = (closes[i] - mn) / (mx - mn)
    s = sum(abs(closes[k] - closes[k - 1]) for k in range(i - n + 1, i + 1))
    if s == 0:
        return None
    er = abs(closes[i] - closes[i - n]) / s
    return rp, er

def signal(rp, er):
    """getRPERSignal: SHORT RP>=0.8 & ER>0.5; LONG RP<=0.2 & 0.2<=ER<0.65."""
    if rp >= 0.8 and er > 0.5:
        return "SHORT"
    if rp <= 0.2 and 0.2 <= er < 0.65:
        return "LONG"
    return None

def episodes_d1(pair):
    """Epizody podle živé definice (signál trvá, dokud platí obě podmínky). since = den po dni, jehož close signál vyvolal."""
    _, d1 = load(pair)
    c, t = d1["c"], d1["t"]
    out, cur = [], None
    for i in range(len(c)):
        r = rp_er(c, i)
        s = signal(*r) if r else None
        day = utc_date(t[i])
        if s and cur and cur["type"] == s:
            cur["last_i"] = i
        else:
            if cur:
                cur["ended_after_i"] = cur["last_i"]; out.append(cur); cur = None
            if s:
                cur = {"pair": pair, "type": s, "i0": i, "last_i": i, "calc_day": str(day), "since": str(day + dt.timedelta(days=1)),
                       "rp": round(r[0], 3), "er": round(r[1], 3), "onset_close": c[i]}
    if cur:
        cur["ended_after_i"] = None; out.append(cur)
    return out

"""Etapa B: rekonstrukce Reverzál epizod z D1 (UTC) a validace proti reálně logovaným signálům (git historie bias_alert_state.json).
Vstup logovaných: data/backtest_rper_lastmonth.json (vyrobil scripts/backtest-rper-alerts-month.py)."""
import json, os, sys, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib
logged = json.load(open(os.path.join(lib.ROOT, "data", "backtest_rper_lastmonth.json")))
logged = [r for r in logged if r["pair"] in lib.pairs()]
start, end = "2026-10-14", "2026-11-13"
rec = [e for p in lib.pairs() for e in lib.episodes_d1(p) if start <= e["since"] <= end]
print(f"okno {start}..{end}: logovaných {len(logged)}, rekonstruovaných {len(rec)}")
def dd(a, b): return abs((dt.date.fromisoformat(a) - dt.date.fromisoformat(b)).days)
matched, used = 0, set()
miss = []
for r in logged:
    d0 = r["onset"][:10]
    hit = None
    for k, e in enumerate(rec):
        if k in used or e["pair"] != r["pair"] or e["type"] != r["type"]: continue
        if dd(e["since"], d0) <= 1: hit = k; break
    if hit is None: miss.append(r)
    else: used.add(hit); matched += 1
extra = [e for k, e in enumerate(rec) if k not in used]
print(f"shoda (pár, směr, vznik ±1 den): {matched}/{len(logged)} = {100*matched/len(logged):.0f} % logovaných")
print(f"rekonstruované bez logu: {len(extra)} z {len(rec)}")
# shoda dnů
print("\nnejčastější neshody (logovaný, nenalezen):")
from collections import Counter
print(Counter(r["pair"] for r in miss).most_common(6))
print("ukázka nenalezených:", [(r["pair"], r["type"], r["onset"][:10]) for r in miss[:8]])
print("ukázka navíc:", [(e["pair"], e["type"], e["since"]) for e in extra[:8]])

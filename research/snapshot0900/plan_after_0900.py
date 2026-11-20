#!/usr/bin/env python3
"""Plán událostí po 09:00 (pražský den) — jen to, co bylo ráno veřejně známé: čas, měna, událost, dopad, forecast, previous.
Bere calendar.json z posledního commitu <= 09:00 Praha. Hodnota actual ani BEAT/MISS se NEUKLÁDÁ."""
import json, subprocess, datetime as dt, os, sys
from zoneinfo import ZoneInfo
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
PRG = ZoneInfo("Europe/Prague")
cache = json.load(open(os.environ.get("COMMITS_CACHE", "/tmp/commits_cache.json")))["data/calendar.json"]
def nine(d):
    return dt.datetime.fromisoformat(d + "T09:00:00").replace(tzinfo=PRG).astimezone(dt.timezone.utc)
rows = []; meta = {}
d0, d1 = dt.date(2026, 8, 3), dt.date(2026, 11, 20)
while d0 <= d1:
    d = d0.isoformat(); d0 += dt.timedelta(days=1)
    cut = nine(d); cms = cut.timestamp() * 1000
    c = next(x for x in cache if x["ts"] <= cms)
    cal = json.loads(subprocess.check_output(f"git show {c['h']}:data/calendar.json", shell=True, cwd=ROOT))
    snap = dt.datetime.fromtimestamp(c["ts"] / 1000, dt.timezone.utc).strftime("%Y-%m-%d %H:%M")
    n = 0
    for e in cal["events"]:
        t = dt.datetime.fromisoformat(e["date"].replace("Z", "+00:00")).astimezone(dt.timezone.utc)
        tp = t.astimezone(PRG)
        if tp.date().isoformat() != d or t <= cut: continue
        rows.append([d, tp.strftime("%H:%M"), e["country"], e["title"], e.get("impact") or "", e.get("forecast") or None, e.get("previous") or None, snap + " UTC"]); n += 1
    meta[d] = (snap, n)
rows.sort(key=lambda r: (r[0], r[1]))
json.dump({"rows": rows, "meta": meta}, open("/tmp/plan.json", "w"))
print(len(rows), "událostí,", len(meta), "dní")

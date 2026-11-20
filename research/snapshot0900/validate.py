#!/usr/bin/env python3
"""Validace rekonstrukce proti SKUTEČNÉMU záznamu (data/engine_hist.json ve verzi z git commitu <= 09:00 Praha).
Pro náhodné dny: vezme záznam, přehraje engine přesně v čase záznamu (ts) ze vstupů commitnutých <= ts a porovná
skóre i všechny komponenty a COT percentil u 8 měn."""
import json, random, subprocess, sys, datetime as dt, os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
sh = lambda c: subprocess.check_output(c, shell=True, text=True, cwd=ROOT)
def prague_nine(d):
    from zoneinfo import ZoneInfo
    return dt.datetime.fromisoformat(d + "T09:00:00").replace(tzinfo=ZoneInfo("Europe/Prague")).astimezone(dt.timezone.utc)
random.seed(int(sys.argv[1]) if len(sys.argv) > 1 else 7)
n = int(sys.argv[2]) if len(sys.argv) > 2 else 12
days = []
d0 = dt.date(2026, 7, 13)
while d0 <= dt.date(2026, 11, 12): days.append(d0.isoformat()); d0 += dt.timedelta(days=1)
res = []
for day in sorted(random.sample(days, n)):
    cut = prague_nine(day).strftime("%Y-%m-%dT%H:%M:%SZ")
    h = sh(f"git log origin/main --until={cut} -1 --format=%H -- data/engine_hist.json").strip()
    eh = json.loads(sh(f"git show {h}:data/engine_hist.json"))["days"]
    k = max(eh, key=lambda x: eh[x]["ts"]); e = eh[k]           # nejnovější záznam v tomto commitu
    out = f"/tmp/val_{day}.json"
    subprocess.run(["node", "research/snapshot0900/replay0900.js", f"--cutoff={e['ts']}", f"--out={out}"] + (["--producer=engine_hist"] if os.environ.get("PRODUCER")=="engine_hist" else []), cwd=ROOT, capture_output=True)
    try: r = json.load(open(out))
    except Exception: res.append((day, e["ts"], None, None)); continue
    cur = r["state"]["cur"]
    ok = sum(1 for c in cur if e["cur"][c]["score"] == cur[c]["score"] and e["cur"][c]["comp"] == {a: b["value"] for a, b in cur[c]["comp"].items()} and e["cur"][c].get("cot_pct") == cur[c]["cot_pct"])
    mx = max(abs(e["cur"][c]["score"] - cur[c]["score"]) for c in cur)
    res.append((day, e["ts"], ok, round(mx, 2), r["audit"]["lookahead_free"], r["provenance"]["engine_mode"][:7]))
tot = 0
for x in res: print(x); tot += (x[2] == 8)
print(f"dnů se 100% shodou (8/8 měn, skóre+komponenty+cot_pct): {tot}/{len(res)}")

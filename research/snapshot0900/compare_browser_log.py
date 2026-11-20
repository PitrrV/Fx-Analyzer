#!/usr/bin/env python3
"""Porovnání rekonstrukce s logem, který si appka sama ukládá v prohlížeči (engine_log v cloudu app_state):
záznam = poslední zápis dne (ts), skóre 8 měn. Rekonstrukce běží přesně v čase ts, ze vstupů commitnutých <= ts."""
import json, subprocess, sys, os, datetime as dt
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
rows = [l.strip().split("|") for l in open(os.path.join(os.path.dirname(__file__), sys.argv[1] if len(sys.argv) > 1 else "browser_log_sample.txt")) if l.strip()]
tot = []; 
for day, ms, sc in rows:
    ts = dt.datetime.fromtimestamp(int(ms) / 1000, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    out = f"/tmp/bl_{day}.json"
    subprocess.run(["node", "research/snapshot0900/replay0900.js", f"--cutoff={ts}", f"--out={out}"], cwd=ROOT, capture_output=True)
    try: r = json.load(open(out))["state"]["cur"]
    except Exception: print(day, "CHYBA"); continue
    real = {a.split("=")[0]: float(a.split("=")[1]) for a in sc.split(",")}
    d = {c: round(r[c]["score"] - real[c], 2) for c in real}
    mx = max(abs(v) for v in d.values()); tot.append(mx)
    print(day, ts[11:16] + "Z", "max|Δ|=%.2f" % mx, "n_shodných=%d/8" % sum(1 for v in d.values() if v == 0), {c: v for c, v in d.items() if v})
tot.sort(); n = len(tot)
print(f"\ndnů: {n} | úplná shoda všech 8 měn: {sum(1 for x in tot if x==0)} | max|Δ| ≤0.05: {sum(1 for x in tot if x<=0.05)} | ≤0.15: {sum(1 for x in tot if x<=0.15)} | medián {tot[n//2]:.2f} | nejhorší {tot[-1]:.2f}")

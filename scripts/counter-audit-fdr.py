#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Protiaudit krok 1: Benjamini-Hochberg FDR korekce nad VŠEMI testy
z data/research/audit_results.json (1368 testů: 304 currency-level +
1064 pair-level). Cíl: kolik "robustních" nálezů z minulého auditu
přežije formální kontrolu false discovery rate, ne jen subperiodový
souhlas + p<0.10 (což při ~1400 testech samo o sobě generuje desítky
falešných pozitiv)."""
import json
import numpy as np

d = json.load(open("/tmp/claude-0/audit_results.json"))
r = d["results"]

rows = []
for ccy, res in r["currencies"].items():
    for k, v in res.items():
        if v.get("p_boot") is not None:
            rows.append({"scope": "currency", "id": ccy, "factor": k, "ic": v["ic"], "p": v["p_boot"],
                         "sub_agree": v["sub_agree"], "prior_robust": v["robust"]})
for pair, res in r["pairs"].items():
    for k, v in res.items():
        if v.get("p_boot") is not None:
            rows.append({"scope": "pair", "id": pair, "factor": k, "ic": v["ic"], "p": v["p_boot"],
                         "sub_agree": v["sub_agree"], "prior_robust": v["robust"]})

print(f"Celkem testů s bootstrap p-hodnotou: {len(rows)}")
n_prior_robust = sum(1 for x in rows if x["prior_robust"])
print(f"Minulý audit označil jako 'robustní' (|IC|>=0.03, p<0.10, sub_agree>=3): {n_prior_robust}")

# Pod nulovou hypotézou (žádný faktor nic nepredikuje) při 1368 testech s p<0.10
# bychom OČEKÁVALI ~137 "náhodných" hitů jen z p-hodnoty samotné.
p_lt_10 = sum(1 for x in rows if x["p"] is not None and x["p"] < 0.10)
print(f"Testů s p<0.10 (bez ohledu na subperiody): {p_lt_10} (očekáváno náhodou: ~{int(len(rows)*0.10)})")

# Benjamini-Hochberg FDR na VŠECH p-hodnotách
def bh_correct(pvals, q=0.10):
    idx = np.argsort(pvals)
    m = len(pvals)
    thresh = 0
    for rank, i in enumerate(idx, start=1):
        if pvals[i] <= (rank / m) * q:
            thresh = rank
    if thresh == 0: return set()
    return set(idx[:thresh].tolist())

pvals = np.array([x["p"] if x["p"] is not None else 1.0 for x in rows])
for q in (0.05, 0.10, 0.20):
    survivors = bh_correct(pvals, q)
    surv_rows = [rows[i] for i in survivors]
    surv_and_prior_robust = [x for x in surv_rows if x["prior_robust"]]
    print(f"\nBH FDR q={q}: {len(survivors)} testů přežije korekci "
          f"({len(surv_and_prior_robust)} z nich bylo i v seznamu 'robustních' minulého auditu)")
    if q == 0.10:
        print("  Přeživší nálezy (faktor, scope, IC, p, byl_už_robustní):")
        for x in sorted(surv_rows, key=lambda z: abs(z["ic"]), reverse=True)[:40]:
            print(f"   {x['scope']:9s} {x['id']:8s} {x['factor']:16s} IC={x['ic']:+.3f} p={x['p']:.3f} "
                  f"sub_agree={x['sub_agree']} prior_robust={x['prior_robust']}")

out = {"n_tests": len(rows), "n_prior_robust": n_prior_robust, "p_lt_10_raw": p_lt_10,
       "bh_survivors": {str(q): len(bh_correct(pvals, q)) for q in (0.05, 0.10, 0.20)}}
json.dump(out, open("/home/user/Fx-Analyzer/data/research/fdr_correction.json", "w"), indent=1)
print("\nOK -> data/research/fdr_correction.json")

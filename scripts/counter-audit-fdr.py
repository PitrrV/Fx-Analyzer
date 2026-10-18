#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Protiaudit krok 1: Benjamini-Hochberg FDR korekce nad testy
z data/research/audit_results.json (1368 testů: 304 currency-level +
1064 pair-level). Cíl: kolik "robustních" nálezů z minulého auditu
přežije formální kontrolu false discovery rate, ne jen subperiodový
souhlas + p<0.10 (což při ~1400 testech samo o sobě generuje desítky
falešných pozitiv).

Počítá DVĚ verze, ať jde jednoznačně ověřit obě čísla, co appka o sobě
tvrdí na různých místech (docs/COUNTER_AUDIT_2026-07.md §"Multiple
testing bias" cituje "7" pro měny, dřívější verze tohodle skriptu
psala do fdr_correction.json jen pooled "16" — bez jasného rozlišení
metodiky to vypadalo jako rozpor, ne dvě různé, obě platné otázky):

  1) POOLED (všech 1368 testů najednou, currency+pair pohromadě) — to
     je metodika, kterou COUNTER_AUDIT sám označuje za PŘÍLIŠ PŘÍSNOU
     (bias č. 2 v dokumentu): 28 párových testů AUD (AUDUSD, EURAUD,
     GBPAUD…) testuje ve skutečnosti pořád ten samý AUD-VIX efekt, ne
     28 nezávislých hypotéz — to umí vyždímat FDR budget a vytlačit
     platné, ale slabší nálezy (přesně to se stalo CAD-CPI akceleraci).
  2) CURRENCY-LEVEL (jen těch 304 currency-scope testů, bez 1064
     redundantních párových) — metodika, kterou COUNTER_AUDIT navrhuje
     jako opravu bias č. 2, a na kterou se odkazuje frází "7 nálezů na
     úrovni měn" v §"Multiple testing bias".

Číslo, které appka/dokumenty citují jako AUTORITATIVNÍ, je (2), ne (1).
(1) zůstává v outputu jen jako transparentní reference k dřívější,
appkou samou zpochybněné metodice.
"""
import json
import os

ROOT = os.path.join(os.path.dirname(__file__), "..")
d = json.load(open(os.path.join(ROOT, "data/research/audit_results.json")))
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

print(f"Celkem testů s bootstrap p-hodnotou: {len(rows)} "
      f"({sum(1 for x in rows if x['scope']=='currency')} currency-level + "
      f"{sum(1 for x in rows if x['scope']=='pair')} pair-level)")
n_prior_robust = sum(1 for x in rows if x["prior_robust"])
print(f"Minulý audit označil jako 'robustní' (|IC|>=0.03, p<0.10, sub_agree>=3): {n_prior_robust}")

p_lt_10 = sum(1 for x in rows if x["p"] is not None and x["p"] < 0.10)
print(f"Testů s p<0.10 (bez ohledu na subperiody): {p_lt_10} (očekáváno náhodou: ~{int(len(rows)*0.10)})")


# Benjamini-Hochberg FDR — čistý Python, bez numpy (appka ho jinde nepoužívá,
# BH korekce je jen seřazení p-hodnot + lineární průchod).
def bh_correct(pvals, q=0.10):
    order = sorted(range(len(pvals)), key=lambda i: pvals[i])
    m = len(pvals)
    thresh = 0
    for rank, i in enumerate(order, start=1):
        if pvals[i] <= (rank / m) * q:
            thresh = rank
    if thresh == 0:
        return set()
    return set(order[:thresh])


def summarize(scope_rows, label, verbose_at=0.10):
    pvals = [x["p"] if x["p"] is not None else 1.0 for x in scope_rows]
    result = {}
    print(f"\n### {label} — {len(scope_rows)} testů ###")
    for q in (0.05, 0.10, 0.20):
        survivors = bh_correct(pvals, q)
        surv_rows = [scope_rows[i] for i in survivors]
        surv_and_prior_robust = [x for x in surv_rows if x["prior_robust"]]
        print(f"BH FDR q={q}: {len(survivors)} testů přežije korekci "
              f"({len(surv_and_prior_robust)} z nich bylo i v seznamu 'robustních' minulého auditu)")
        if q == verbose_at:
            for x in sorted(surv_rows, key=lambda z: abs(z["ic"]), reverse=True)[:40]:
                print(f"   {x['scope']:9s} {x['id']:8s} {x['factor']:16s} IC={x['ic']:+.3f} p={x['p']:.3f} "
                      f"sub_agree={x['sub_agree']} prior_robust={x['prior_robust']}")
        result[str(q)] = len(survivors)
    return result


pooled_survivors = summarize(rows, "POOLED (1368, currency+pair dohromady) — appkou označeno za PŘÍLIŠ PŘÍSNÉ, jen pro referenci")
currency_rows = [x for x in rows if x["scope"] == "currency"]
currency_survivors = summarize(currency_rows, "CURRENCY-LEVEL (304, autoritativní — na tohle se odkazuje COUNTER_AUDIT)")

out = {
    "n_tests": len(rows),
    "n_prior_robust": n_prior_robust,
    "p_lt_10_raw": p_lt_10,
    "pooled_1368": {
        "note": "Naivní FDR přes všech 1368 testů najednou (currency+pair). COUNTER_AUDIT_2026-07.md bias #2: příliš přísné, protože desítky párových testů (např. 28× AUD) testují týž efekt vícekrát a vyždímají FDR budget. Ponecháno pro transparentnost, NENÍ autoritativní číslo appky.",
        "bh_survivors": pooled_survivors,
    },
    "currency_level_304": {
        "note": "FDR jen přes 304 currency-scope testů (bez redundantních párových). Tohle je metodika, na kterou se COUNTER_AUDIT_2026-07.md odkazuje v §'Multiple testing bias' ('7 nálezů na úrovni měn').",
        "bh_survivors": currency_survivors,
    },
}
out_path = os.path.join(ROOT, "data/research/fdr_correction.json")
json.dump(out, open(out_path, "w"), ensure_ascii=False, indent=1)
print("\nOK ->", out_path)

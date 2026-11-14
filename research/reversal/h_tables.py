"""Generuje markdown tabulky z out/*.csv pro závěrečné dokumenty."""
import os, json
import pandas as pd
H = os.path.dirname(os.path.abspath(__file__)); O = lambda f: os.path.join(H, "out", f)
def md(df, cols, fmt):
    lines = ["| " + " | ".join(h for h, _ in cols) + " |", "|" + "|".join("---" for _ in cols) + "|"]
    for _, r in df.iterrows(): lines.append("| " + " | ".join(("—" if pd.isna(r[c]) else fmt.get(c, str).__call__(r[c])) for _, c in cols) + " |")
    return "\n".join(lines)
pc = lambda x: f"{100*x:.1f} %"; f2 = lambda x: f"{x:.2f}"; f3 = lambda x: f"{x:.3f}"; i0 = lambda x: f"{int(x)}"; sg = lambda x: f"{100*x:+.1f} p.b."
U = pd.read_csv(O("univariate.csv")); S = json.load(open(O("univariate_summary.json")))
out = []
cols = [("faktor", "feature"), ("n", "n"), ("výhry", "wins"), ("ztráty", "losses"), ("win rate", "winrate"), ("95% CI", "ci"), ("rozdíl vs. nepřítomno", "diff"), ("p (clustery)", "p_cluster"), ("FDR", "fdr_q10"),
        ("MFE12", "mfe12"), ("MAE12", "mae12"), ("medián výsl. 48 h (ATR)", "median_ret12"), ("test: n", "test_n"), ("test: win rate", "test_winrate")]
U["ci"] = U.apply(lambda r: f"{100*r.ci_lo:.0f}–{100*r.ci_hi:.0f} %", axis=1); U["fdr_q10"] = U.fdr_q10.map({True: "ano", False: "ne"})
fm = dict(n=i0, wins=i0, losses=i0, winrate=pc, diff=sg, p_cluster=f3, mfe12=f2, mae12=f2, median_ret12=f2, test_n=i0, test_winrate=pc)
out.append("### Univariátní tabulka (vývoj, seřazeno podle p; plná tabulka v `out/univariate.csv`)\n")
out.append(f"Vývoj: n = {S['dev_n']}, základní win rate {100*S['dev_base']:.1f} %; test: n = {S['test_n']}, základ {100*S['test_base']:.1f} %. Testováno hypotéz: {S['hypotheses']}, prošlo FDR (q = 0,10): **{S['fdr_pass']}**.\n")
out.append(md(U.head(25), cols, fm))
for grp, pat in (("Zóny", "zone_|any_zone|d1_or_w1"), ("Úrovně", "PDL|20d|sweep_PDL"), ("Síla měn", "strength"), ("COT", "cot_")):
    out.append(f"\n### {grp}\n"); out.append(md(U[U.feature.str.contains(pat)].sort_values("p_cluster"), cols, fm))
M = pd.read_csv(O("model_results.csv")); M = M[M.n >= 10]
mc = [("model", "model"), ("část", "part"), ("n", "n"), ("win rate", "winrate"), ("očekávané R", "exp_R"), ("95% CI R", "ci"), ("náhodný vstup R", "null_R"), ("edge vs. náhoda", "edge_vs_null"), ("p", "edge_p"), ("MFE (ATR)", "mfe"), ("MAE (ATR)", "mae"), ("průměrná doba (sv.)", "held"), ("vstup za (sv. po signálu)", "bars_after")]
M["ci"] = M.apply(lambda r: "—" if pd.isna(r.exp_lo) else f"{r.exp_lo:+.2f} až {r.exp_hi:+.2f}", axis=1)
out.append("\n### Entry modely po signálu\n"); out.append(md(M, mc, dict(n=i0, winrate=pc, exp_R=f2, null_R=f2, edge_vs_null=f2, edge_p=f3, mfe=f2, mae=f2, held=lambda x: f"{x:.1f}", bars_after=lambda x: f"{x:.1f}")))
A = pd.read_csv(O("sequences_pre.csv")); B = pd.read_csv(O("sequences_post.csv"))
out.append(f"\n### Sekvence před/při signálu (testováno {len(A)}, FDR prošlo {int(A.fdr_q10.sum())})\n")
out.append(md(A.head(10), [("sekvence", "gram"), ("n", "n"), ("win rate", "winrate"), ("rozdíl vs. základ", "diff_vs_base"), ("p", "p"), ("test: n", "test_n"), ("test: win rate", "test_winrate")], dict(n=i0, winrate=pc, diff_vs_base=sg, p=f3, test_n=i0, test_winrate=pc)))
out.append(f"\n### Sekvence po signálu (testováno {len(B)}, FDR prošlo {int(B.fdr_q10.sum())})\n")
out.append(md(B.head(10), [("sekvence", "gram"), ("n", "n"), ("očekávané R", "exp_R"), ("edge vs. náhoda", "edge_vs_null"), ("p", "p"), ("test: n", "test_n"), ("test: R", "test_exp_R"), ("test: edge", "test_edge")], dict(n=i0, exp_R=f2, edge_vs_null=f2, p=f3, test_n=i0, test_exp_R=f2, test_edge=f2)))
open(O("tables.md"), "w").write("\n".join(out)); print("tables.md", len("\n".join(out)), "znaků")

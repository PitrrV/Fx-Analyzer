#!/usr/bin/env python3
"""Složí denní snímky k 09:00 Praha (výstupy replay0900.js v /tmp/days) do jednoho Excelu."""
import json, glob, os, subprocess, datetime as dt, sys
import xlsxwriter
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "export-0900", "Analyzer_snapshot_0900_Praha.xlsx")
sh = lambda c: subprocess.check_output(c, shell=True, text=True, cwd=ROOT)
files = sorted(glob.glob("/tmp/days/20??-??-??.json"))
days = {}
for f in files:
    try: days[os.path.basename(f)[:10]] = json.load(open(f))
    except Exception: pass
def typ(d):
    if d >= "2026-07-13": return "A"
    if d >= "2026-06-22": return "B"
    return "C"
TYP_TXT = {"A": "A: vstupy i engine.js z git k 09:00 (+ k dispozici serverový záznam)", "B": "B: vstupy z git k 09:00, ale dnešní engine.js", "C": "C: přepočet z oříznutých historií dnešním enginem; chybí VIX/ropa/retail"}
CUR = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"]
# serverový záznam (engine_hist.json ve verzi posledního commitu <= cutoff)
real = {}
for d, r in days.items():
    if d < "2026-07-11": continue
    cut = r["provenance"]["cutoff_utc"]
    try:
        h = sh(f"git log origin/main --until={cut} -1 --format=%H -- data/engine_hist.json").strip()
        eh = json.loads(sh(f"git show {h}:data/engine_hist.json"))["days"]
        k = max(eh, key=lambda x: eh[x]["ts"]); real[d] = eh[k]
    except Exception: pass
wb = xlsxwriter.Workbook(OUT)
H = wb.add_format({"bold": True, "bg_color": "#1f2937", "font_color": "#ffffff", "border": 1, "text_wrap": True, "valign": "top"})
W = wb.add_format({"text_wrap": True, "valign": "top"}); B = wb.add_format({"bold": True, "font_size": 14})
N2 = wb.add_format({"num_format": "0.00"}); N3 = wb.add_format({"num_format": "0.000"})
def sheet(name, cols, widths):
    ws = wb.add_worksheet(name)
    for i, (c, w) in enumerate(zip(cols, widths)): ws.write(0, i, c, H); ws.set_column(i, i, w)
    ws.freeze_panes(1, 0); ws.set_row(0, 32); return ws
# README
ws = wb.add_worksheet("README"); ws.set_column(0, 0, 130)
first, last = min(days), max(days)
lines = [("Snímek Analyzeru k 09:00 Europe/Prague (s letním časem) — zpětně po dnech", B),
 (f"Rozsah: {first} až {last}, {len(days)} dní. Každý řádek = stav, jaký by Analyzer ukázal ten den v 09:00 pražského času (UTC 07:00 v létě, 08:00 v zimě).", W),
 ("", W), ("SKUTEČNÝ ZÁZNAM, NEBO PŘEPOČET? Je to PŘEPOČET: skutečný engine.js a stejný skript jako produkční snímek se spustí nad vstupy z posledního commitu s časem <= 09:00 Praha, se zmrazeným časem (Date shim). Skutečný záznam enginu je jen od 2026-07-11 (server) a ukázal jsem ho vedle (sloupce „záznam“).", W),
 ("TYPY DNŮ (sloupec typ): " + " | ".join(TYP_TXT.values()), W),
 ("DŮKAZ BEZ POHLEDU DO BUDOUCNOSTI: list Provenance — u každého dne commity použitých souborů a audit nejpozdějších časových razítek (sloupec lookahead_free). Test s úmyslným únikem (+24 h) změní skóre až o 1,4 a audit ho označí.", W),
 ("VALIDACE: (1) serverový záznam engine_hist: 12/12 náhodných dnů shoda 8/8 měn včetně všech složek (přehráním producerem z té doby). (2) záznam prohlížeče (engine_log): od 22. 10. 2026 max rozdíl 0,11; před 19. 10. 2026 rozdíly 0,35–1,85, protože prohlížeč skóroval z lokální historie zařízení (oprava #288). (3) výhled %: směr 28/28 shodný s prohlížečem, pravděpodobnost ±1–2 b.", W),
 ("LIMITY: DXY se nikam neukládá (sloupec prázdný). VIX před 2026-08-02, ropa před 2026-06-29 a retail před 2026-06-22 v repu nejsou → složky risk/ropa/sentiment jsou před tím 0 a skóre je zkreslené. Kalendář před 2026-06-19 má finální (revidované) hodnoty, ne první otisk. Pro dny typu C engine.js z té doby neexistuje (CB sazby konvergují z defaultů ~12 týdnů). Výhled % a RP/ER nejsou v žádném záznamu (přepočet z cen). Hvězdy/směr/rozdíl párů u C jsou jen přepočet.", W),
 ("COT: list COT má datum REPORTU (úterý), datum ZVEŘEJNĚNÍ dle pravidla CFTC (pátek 15:30 New York; po svátku později) a kdy se týden poprvé objevil v repu (jen od 2026-06-27). V denních listech se použije jen to, co bylo do 09:00 zveřejněno/staženo.", W),
 ("Kalendář: jen události dne (pražského) vydané před 09:00, s actual. BEAT/MISS je směr, který počítá engine; bez forecastu nebo mimo pravidla enginu nejde určit (např. Philly Fed).", W),
 ("Reprodukce: research/snapshot0900/replay0900.js <YYYY-MM-DD>; složení: build_excel.py. Párů je 28 FX + XAUUSD + US100 (zvlášť).", W)]
for i, (t, f) in enumerate(lines): ws.write(i, 0, t, f); ws.set_row(i, 62 if len(t) > 140 else 20)
# Měny
ws = sheet("Měny_09h", ["datum", "typ", "měna", "pořadí", "skóre", "COT", "risk", "ropa", "politika bank", "fundamenty (kalendář)", "reálný výnos", "retail sentiment", "sezónnost", "COT percentil", "skóre záznam (server)", "ts záznamu (UTC)", "rozdíl přepočet−záznam"], [11, 5, 7, 7, 8, 8, 8, 8, 10, 12, 10, 10, 9, 9, 11, 22, 11])
r = 1
for d in sorted(days):
    cur = days[d]["state"]["cur"]; order = sorted(CUR, key=lambda c: -cur[c]["score"]); rec = real.get(d)
    for i, c in enumerate(order):
        v = {k: x["value"] for k, x in cur[c]["comp"].items()}; sc = cur[c]["score"]
        row = [d, typ(d), c, i + 1, sc, v.get("cot"), v.get("risk"), v.get("oil"), v.get("policy"), v.get("fund_data"), v.get("yield"), v.get("sent"), v.get("season"), cur[c].get("cot_pct")]
        for j, x in enumerate(row): ws.write(r, j, x) if j < 4 or j == 13 else ws.write(r, j, x, N2)
        if rec and c in rec["cur"]:
            ws.write(r, 14, rec["cur"][c]["score"], N2); ws.write(r, 15, rec["ts"]); ws.write(r, 16, round(sc - rec["cur"][c]["score"], 2), N2)
        r += 1
ws.autofilter(0, 0, r - 1, 16)
# Páry
ws = sheet("Páry_09h", ["datum", "typ", "pár", "směr", "rozdíl skóre", "hvězdy", "výhled směr", "výhled %", "RP10", "ER10", "COT % base", "COT % quote", "RP+ER signál (od)"], [11, 5, 9, 7, 10, 7, 9, 9, 8, 8, 9, 9, 30])
r = 1
for d in sorted(days):
    ex = days[d]["extras"]; rv = ex.get("reversal_active") or {}
    for p in ex.get("pairs", []):
        sig = rv.get(p["pair"]); row = [d, typ(d), p["pair"], p["dir"], p["diff"], p["stars"], p["outlook_dir"], p["outlook_prob_pct"], p["RP10"], p["ER10"], p["cot_pct_base"], p["cot_pct_quote"], (sig["type"] + " od " + sig["since"][:16]) if sig else None]
        for j, x in enumerate(row): ws.write(r, j, x)
        r += 1
    u = ex.get("us100")
    if u: ws.write_row(r, 0, [d, typ(d), "US100", u["dir"], u["score"], None, None, None, u["RP10"], u["ER10"]]); r += 1
ws.autofilter(0, 0, r - 1, 12)
# COT
cot = json.load(open(os.path.join(ROOT, "data/cot_hist.json")))["weeks"]
seen = {}
try:
    cs = sh("git log origin/main --format='%H %cI' --reverse -- data/cot_hist.json").strip().split("\n")
    for l in cs:
        h, t = l.split(); 
        try: wk = json.loads(sh(f"git show {h}:data/cot_hist.json"))["weeks"]
        except Exception: continue
        for w in wk: seen.setdefault(w, t)
except Exception: pass
def cftc(w):
    d0 = dt.datetime.fromisoformat(w) + dt.timedelta(days=3)
    from zoneinfo import ZoneInfo
    return dt.datetime(d0.year, d0.month, d0.day, 15, 30, tzinfo=ZoneInfo("America/New_York")).astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
ws = sheet("COT", ["datum reportu (úterý)", "zveřejněno dle CFTC (UTC, pravidlo)", "poprvé v repu (UTC)"] + CUR, [14, 22, 24] + [7] * 8)
for i, w in enumerate(sorted(cot)):
    sc = cot[w].get("scores", {}); ws.write_row(i + 1, 0, [w, cftc(w), seen.get(w) if w >= "2026-06-27" else None] + [sc.get(c) for c in CUR])
ws.autofilter(0, 0, len(cot), 10)
# Kalendář
ws = sheet("Kalendář_před_09h", ["datum", "typ", "čas (Praha)", "měna", "událost", "dopad", "actual", "forecast", "previous", "BEAT/MISS", "zdroj hodnot"], [11, 5, 9, 7, 36, 8, 10, 10, 10, 24, 40])
r = 1
for d in sorted(days):
    ex = days[d]["extras"]; src = ex.get("calendar_source", "calendar_hist (finální hodnoty)")
    for e in ex.get("calendar_before_cutoff", []):
        ws.write_row(r, 0, [d, typ(d), e["time_prague"], e["ccy"], e["event"], e["impact"], e["actual"], e["forecast"], e["previous"], e["beat_miss"], src]); r += 1
ws.autofilter(0, 0, max(r - 1, 1), 10)
# Trh
ws = sheet("Trh_09h", ["datum", "typ", "VIX", "VIX režim", "VIX aktualizováno (UTC)", "WTI", "WTI před 4 týdny", "WTI před 13 týdny", "ropa aktualizováno", "DXY", "retail bod (UTC)"] + [f"retail long % {c}" for c in CUR] + ["ceny aktualizovány (UTC)"], [11, 5, 7, 11, 22, 8, 10, 10, 22, 9, 22] + [9] * 8 + [22])
r = 1
for d in sorted(days):
    m = days[d]["extras"].get("market", {}) or {}; v = m.get("vix") or {}; o = m.get("oil_wti") or {}; rt = m.get("retail_sentiment") or {}; cl = rt.get("ccy_long_pct") or {}
    ws.write_row(r, 0, [d, typ(d), v.get("value"), v.get("regime"), v.get("updated"), o.get("current"), o.get("w4ago"), o.get("w13ago"), o.get("as_of"), "nedostupné", rt.get("point_time")] + [cl.get(c) for c in CUR] + [m.get("prices_updated")]); r += 1
ws.autofilter(0, 0, r - 1, 19)
# Provenance
ws = sheet("Provenance", ["datum", "typ", "cutoff 09:00 Praha (UTC)", "engine", "commit engine.js", "commit cot_hist", "commit calendar", "commit retail_hist", "commit prices", "commit vix", "commit oil", "COT nejnovější report", "COT nejpozději zveřejněn (pravidlo)", "retail nejnovější bod", "události s actual po cutoffu", "lookahead_free", "poznámky vstupů"], [11, 5, 22, 30, 12, 12, 12, 12, 12, 12, 12, 14, 22, 24, 12, 11, 60])
for i, d in enumerate(sorted(days)):
    p, a = days[d]["provenance"], days[d]["audit"]; fl = p["files"]; g = lambda k: (fl.get(k) or {}).get("commit") or ("záloha: " + (fl.get(k) or {}).get("fallback", "")[:40] if fl.get(k) else "—")
    notes = "; ".join(f"{k.split('/')[-1]}: {v['fallback']}" for k, v in fl.items() if v and v.get("fallback"))
    ws.write_row(i + 1, 0, [d, typ(d), p["cutoff_utc"], p["engine_mode"], g("engine.js"), g("data/cot_hist.json"), g("data/calendar.json") if fl.get("data/calendar.json") else g("data/calendar_hist.json"), g("data/retail_hist.json"), g("data/prices.json"), g("data/vix.json"), g("data/oil.json"), a.get("cot_newest_report_week"), a.get("cot_latest_publication_by_cftc_rule"), a.get("retail_newest_point"), a.get("calendar_events_with_actual_after_cutoff"), a.get("lookahead_free"), notes])
ws.autofilter(0, 0, len(days), 16)
wb.close(); print("OK", OUT, len(days), "dní")

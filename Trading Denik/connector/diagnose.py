"""Diagnostika MT5 (JEN ČTENÍ, nic se neposílá na server). Spuštění: python diagnose.py --config config.json --out diag_report.json

Vytvoří soubor s tím, co by konektor viděl: účet (číslo účtu zamaskované), režim hedging/netting, deals, objednávky, otevřené pozice, specifikace symbolů a tvary surových polí.
Slouží k ověření konektoru na skutečném MT5 (E6): report se dá offline přehrát skriptem tests/replay_diag.mjs. Obsahuje historii obchodů, ale ne hesla ani komentáře k dealům.
"""
import argparse
import collections
import datetime as dt
import json
import sys

from collector import Collector


def _shape(o):
    f = getattr(o, "_asdict", None)
    try:
        return sorted(f().keys()) if f else sorted(k for k in dir(o) if not k.startswith("_"))
    except Exception:
        return []


def build_report(mt5, collector, max_deals=5000):
    ti = mt5.terminal_info()
    acc = collector.account()
    login = str(acc.get("login") or "")
    acc["login"] = ("***" + login[-3:]) if login else None
    start, end = collector._history_window(None)
    raw_deals = mt5.history_deals_get(start, end) or []
    raw_orders = mt5.history_orders_get(start, end) or []
    raw_pos = mt5.positions_get() or []
    batches = collector.batches(None)
    deals, orders, positions, specs = [], [], [], {}
    for payload, _ in batches:
        deals += payload["deals"]
        specs.update(payload.get("specs") or {})
        if "orders" in payload:
            orders = payload["orders"]
        if "positions" in payload:
            positions = payload["positions"]
    for d in deals:
        d.pop("comment", None)          # komentáře k obchodům do reportu nedávat
    warns = []
    if ti is not None and getattr(ti, "trade_allowed", False):
        warns.append("V terminálu je zapnuté Algo Trading. Konektor ho nepotřebuje; doporučeno vypnout.")
    if not deals:
        warns.append("Ve zvoleném okně nejsou žádné deals.")
    known_types = {"BUY", "SELL", "BALANCE", "CREDIT", "CHARGE", "CORRECTION", "BONUS", "COMMISSION", "INTEREST"}
    unknown = sorted({d["type"] for d in deals if d["type"] not in known_types and not str(d["type"]).startswith(("COMMISSION", "BUY_CANCELED", "SELL_CANCELED"))})
    if unknown:
        warns.append("Neznámé typy dealů: " + ", ".join(unknown))
    return {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(),
        "mt5_package_version": getattr(sys.modules.get("MetaTrader5"), "__version__", None),
        "terminal_version": list(mt5.version() or []) if hasattr(mt5, "version") else None,
        "terminal": {"connected": getattr(ti, "connected", None), "trade_allowed": getattr(ti, "trade_allowed", None),
                     "tradeapi_disabled": getattr(ti, "tradeapi_disabled", None), "company": getattr(ti, "company", None)} if ti is not None else None,
        "account": acc,
        "window": {"from": start.isoformat(), "to": end.isoformat()},
        "counts": {"deals": len(deals), "orders": len(orders), "open_positions": len(positions)},
        "deal_types": dict(collections.Counter(d["type"] for d in deals)),
        "deal_entries": dict(collections.Counter(str(d["entry"]) for d in deals)),
        "raw_shapes": {"deal": _shape(raw_deals[0]) if len(raw_deals) else [], "order": _shape(raw_orders[0]) if len(raw_orders) else [],
                       "position": _shape(raw_pos[0]) if len(raw_pos) else []},
        "warnings": warns,
        "deals": deals[:max_deals], "orders": orders[:max_deals], "positions": positions, "specs": specs,
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--out", default="diag_report.json")
    a = ap.parse_args(argv)
    with open(a.config, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    from mt5_readonly import open_real
    mt5 = open_real()
    kw = {"path": cfg["terminal_path"]} if cfg.get("terminal_path") else {}
    if not mt5.initialize(**kw):
        raise SystemExit(f"MT5 initialize selhalo: {mt5.last_error()}")
    try:
        rep = build_report(mt5, Collector(mt5, initial_days=int(cfg.get("history_days_initial", 365))))
    finally:
        mt5.shutdown()
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(rep, f, ensure_ascii=False, indent=1, default=str)
    c = rep["counts"]
    print(f"OK: {a.out} · účet {rep['account']['login']} · {rep['account']['margin_mode']} · {rep['account']['currency']} · deals {c['deals']} · otevřené pozice {c['open_positions']}")
    for w in rep["warnings"]:
        print("UPOZORNĚNÍ:", w)


if __name__ == "__main__":
    sys.exit(main())

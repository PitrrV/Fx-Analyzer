"""Sběr dat z MT5 (jen čtení) a sestavení dávek pro mt5-ingest.

Používá výhradně ReadOnlyMT5. Žádné obchodní funkce, žádné přihlašování (terminál je přihlášený sám).
Kurzor (čas posledního úspěšně odeslaného dealu) se posouvá až PO potvrzení serverem; při výpadku se
při dalším průchodu historie přečte znovu od kurzoru, takže se žádný obchod neztratí. Server je
idempotentní, takže opakované odeslání nevadí.
"""
import datetime as dt

DEAL_TYPE = {0: "BUY", 1: "SELL", 2: "BALANCE", 3: "CREDIT", 4: "CHARGE", 5: "CORRECTION", 6: "BONUS",
             7: "COMMISSION", 8: "COMMISSION_DAILY", 9: "COMMISSION_MONTHLY", 10: "COMMISSION_AGENT_DAILY",
             11: "COMMISSION_AGENT_MONTHLY", 12: "INTEREST", 13: "BUY_CANCELED", 14: "SELL_CANCELED"}
DEAL_ENTRY = {0: "IN", 1: "OUT", 2: "INOUT", 3: "OUT_BY"}
ORDER_TYPE = {0: "BUY", 1: "SELL", 2: "BUY_LIMIT", 3: "SELL_LIMIT", 4: "BUY_STOP", 5: "SELL_STOP",
              6: "BUY_STOP_LIMIT", 7: "SELL_STOP_LIMIT", 8: "CLOSE_BY"}
ORDER_STATE = {0: "STARTED", 1: "PLACED", 2: "CANCELED", 3: "PARTIAL", 4: "FILLED", 5: "REJECTED", 6: "EXPIRED"}
POS_TYPE = {0: "BUY", 1: "SELL"}
MARGIN_MODE = {0: "netting", 1: "exchange", 2: "hedging"}
OVERLAP_MS = 10 * 60 * 1000
BATCH_DEALS = 1000
EQUITY_EVERY_S = 60


def _g(o, name, default=None):
    return getattr(o, name, default)


class Collector:
    def __init__(self, mt5, initial_days=365, now_fn=None):
        self.mt5 = mt5
        self.initial_days = initial_days
        self.now = now_fn or (lambda: dt.datetime.now(dt.timezone.utc))
        self._spec_cache = {}
        self._last_eq = None  # equity vzorek nejvýš 1× za EQUITY_EVERY_S (jinak by tabulka rostla zbytečně)

    # --- jednotlivé části -------------------------------------------------
    def account(self):
        a = self.mt5.account_info()
        if a is None:
            raise RuntimeError("MT5: account_info() nevrátilo data (je terminál přihlášený?)")
        return {"login": _g(a, "login"), "currency": _g(a, "currency"), "balance": _g(a, "balance"),
                "equity": _g(a, "equity"), "margin": _g(a, "margin"), "free_margin": _g(a, "margin_free"),
                "profit": _g(a, "profit"), "margin_mode": MARGIN_MODE.get(_g(a, "margin_mode"))}

    def _deal(self, d):
        return {"ticket": int(d.ticket), "position_id": int(_g(d, "position_id", 0)), "order": int(_g(d, "order", 0)),
                "time_msc": int(d.time_msc), "symbol": _g(d, "symbol", ""), "type": DEAL_TYPE.get(_g(d, "type"), str(_g(d, "type"))),
                "entry": DEAL_ENTRY.get(_g(d, "entry")), "volume": _g(d, "volume", 0), "price": _g(d, "price"),
                "profit": _g(d, "profit", 0), "commission": _g(d, "commission", 0), "swap": _g(d, "swap", 0),
                "fee": _g(d, "fee", 0), "comment": _g(d, "comment", ""), "reason": str(_g(d, "reason", "")), "magic": _g(d, "magic")}

    def _order(self, o, pending=False):
        return {"ticket": int(o.ticket), "position_id": int(_g(o, "position_id", 0)), "symbol": _g(o, "symbol", ""),
                "type": ORDER_TYPE.get(_g(o, "type"), str(_g(o, "type"))), "state": ORDER_STATE.get(_g(o, "state"), str(_g(o, "state"))),
                "is_pending": pending, "time_setup_msc": _g(o, "time_setup_msc"), "time_done_msc": _g(o, "time_done_msc"),
                "volume_initial": _g(o, "volume_initial"), "volume_current": _g(o, "volume_current"),
                "price_open": _g(o, "price_open"), "sl": _g(o, "sl"), "tp": _g(o, "tp")}

    def positions(self):
        out = []
        for p in (self.mt5.positions_get() or []):
            out.append({"ticket": int(p.ticket), "symbol": p.symbol, "type": POS_TYPE.get(p.type), "volume": p.volume,
                        "price_open": p.price_open, "sl": _g(p, "sl", 0), "tp": _g(p, "tp", 0), "profit": _g(p, "profit", 0),
                        "swap": _g(p, "swap", 0), "time_msc": _g(p, "time_msc"), "time_update_msc": _g(p, "time_update_msc")})
        return out

    def pending_orders(self):
        return [self._order(o, pending=True) for o in (self.mt5.orders_get() or [])]

    def specs(self, symbols):
        out = {}
        for s in sorted({x for x in symbols if x}):
            if s not in self._spec_cache:
                i = self.mt5.symbol_info(s)
                if i is None:
                    continue
                self._spec_cache[s] = {"tick_size": _g(i, "trade_tick_size"), "tick_value": _g(i, "trade_tick_value"),
                                       "contract_size": _g(i, "trade_contract_size"), "digits": _g(i, "digits")}
            out[s] = self._spec_cache[s]
        return out

    def _history_window(self, cursor_ms):
        now = self.now()
        if cursor_ms is None:
            start = now - dt.timedelta(days=self.initial_days)
        else:
            start = dt.datetime.fromtimestamp((cursor_ms - OVERLAP_MS) / 1000, tz=dt.timezone.utc)
        return start, now + dt.timedelta(days=1)

    # --- sestavení dávek --------------------------------------------------
    def batches(self, cursor_ms):
        """Vrací seznam dávek (payload, nový_kurzor). Kurzor se smí uložit až po úspěšném odeslání dávky."""
        start, end = self._history_window(cursor_ms)
        deals = [self._deal(d) for d in (self.mt5.history_deals_get(start, end) or [])]
        orders = [self._order(o) for o in (self.mt5.history_orders_get(start, end) or [])]
        open_pos = self.positions()
        # Otevřené pozice: vždy znovu celá historie jejich dealů/orderů (aby šlo složit vstup i po dlouhém výpadku).
        have = {d["ticket"] for d in deals}
        for p in open_pos:
            for d in (self.mt5.history_deals_get(position=p["ticket"]) or []):
                dd = self._deal(d)
                if dd["ticket"] not in have:
                    deals.append(dd); have.add(dd["ticket"])
            for o in (self.mt5.history_orders_get(position=p["ticket"]) or []):
                orders.append(self._order(o))
        seen, uniq = set(), []
        for o in orders:
            if o["ticket"] not in seen:
                seen.add(o["ticket"]); uniq.append(o)
        orders = uniq + self.pending_orders()
        deals.sort(key=lambda d: (d["time_msc"], d["ticket"]))
        acc = self.account()
        specs = self.specs([d["symbol"] for d in deals] + [p["symbol"] for p in open_pos])
        equity = {"ts": self.now().isoformat(), "balance": acc["balance"], "equity": acc["equity"], "margin": acc["margin"],
                  "free_margin": acc["free_margin"], "profit": acc["profit"]}
        chunks = [deals[i:i + BATCH_DEALS] for i in range(0, len(deals), BATCH_DEALS)] or [[]]
        out = []
        for i, ch in enumerate(chunks):
            last = i == len(chunks) - 1
            # Bez nových dealů je historie do "teď" kompletní => kurzor na teď (jinak by se při prvním běhu
            # bez obchodů četlo od roku 1970).
            new_cursor = max([cursor_ms or 0] + [d["time_msc"] for d in ch]) if ch else max(cursor_ms or 0, int(self.now().timestamp() * 1000))
            payload = {"account": acc, "deals": ch, "specs": specs}
            if last:  # pozorování (otevřené pozice, pending, equity) jen v poslední dávce
                payload.update({"orders": orders, "positions": open_pos})
                if self._last_eq is None or (self.now() - self._last_eq).total_seconds() >= EQUITY_EVERY_S:
                    payload["equity"] = equity
                    self._last_eq = self.now()
            else:
                payload["orders"] = orders
            out.append((payload, new_cursor))
        return out

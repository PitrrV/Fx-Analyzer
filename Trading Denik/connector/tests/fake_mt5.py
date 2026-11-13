"""Falešný MT5 backend (bez Windows a bez skutečného terminálu) pro testy konektoru."""
from types import SimpleNamespace as NS


class FakeMT5:
    def __init__(self, login=111111, currency="USD", margin_mode=2):
        self.deals, self.orders, self.positions, self.pending = [], [], [], []
        self.acc = NS(login=login, currency=currency, balance=100000.0, equity=100000.0, margin=0.0, margin_free=100000.0, profit=0.0, margin_mode=margin_mode)
        self.calls, self.order_send_calls = [], 0

    # čtecí funkce, které obálka propustí
    def account_info(self): return self.acc
    def positions_get(self, **k): return list(self.positions)
    def orders_get(self, **k): return list(self.pending)
    def symbol_info(self, s): return NS(trade_tick_size=0.00001, trade_tick_value=1.0, trade_contract_size=100000, digits=5)
    def history_deals_get(self, a=None, b=None, position=None):
        self.calls.append(("deals", a, b, position))
        if position is not None: return [d for d in self.deals if d.position_id == position]
        t0, t1 = a.timestamp() * 1000, b.timestamp() * 1000
        return [d for d in self.deals if t0 <= d.time_msc <= t1]
    def history_orders_get(self, a=None, b=None, position=None):
        if position is not None: return [o for o in self.orders if o.position_id == position]
        return list(self.orders)
    # zakázaná funkce — kdyby ji někdo zavolal, test to zaznamená
    def order_send(self, *a, **k): self.order_send_calls += 1


def deal(ticket, pos, t_ms, typ=0, entry=0, vol=1.0, price=1.1, profit=0.0, order=None, symbol="EURUSD"):
    return NS(ticket=ticket, position_id=pos, order=order or ticket + 1000, time_msc=t_ms, symbol=symbol, type=typ, entry=entry,
              volume=vol, price=price, profit=profit, commission=-7.0, swap=0.0, fee=0.0, comment="", reason=0, magic=0)

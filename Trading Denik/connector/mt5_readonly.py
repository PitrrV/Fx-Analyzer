"""Čtecí obálka nad MetaTrader5. Konektor smí používat JEN tuto třídu, nikdy `MetaTrader5` přímo.

Proč: ForTraders (a možná další) nedává investor heslo, takže "jen pro čtení" musí zaručit
kód. Obálka propustí pouze funkce ze ALLOWED. Cokoli jiného (order_send, order_check,
position_close... i překlep či budoucí funkce) vyhodí ReadOnlyViolation dřív, než se
zavolá MT5. Test test_readonly.py navíc hlídá, že se v kódu konektoru nikde neobjeví
jména obchodních funkcí a že se nikde nevolá login() (konektor se připojuje k už
přihlášenému terminálu, hesla nepotřebuje a neukládá).
"""

ALLOWED = frozenset({
    "initialize", "shutdown", "version", "last_error",
    "terminal_info", "account_info",
    "symbol_info", "symbol_info_tick", "symbols_total", "symbols_get",
    "positions_total", "positions_get", "orders_total", "orders_get",
    "history_orders_total", "history_orders_get",
    "history_deals_total", "history_deals_get",
    "copy_rates_from", "copy_rates_from_pos", "copy_rates_range",
})

# Seznam pro test; obálka je stejně allow-list, tohle je druhá, nezávislá pojistka.
FORBIDDEN = ("order_send", "order_check", "order_calc_margin", "order_calc_profit",
             "login", "market_book_add", "symbol_select")


def open_real():
    """Jediné místo, kde se načítá balíček MetaTrader5 (Windows). Vrací už jen čtecí obálku."""
    import importlib
    return ReadOnlyMT5(importlib.import_module("MetaTrader5"))


class ReadOnlyViolation(RuntimeError):
    pass


class ReadOnlyMT5:
    def __init__(self, backend):
        object.__setattr__(self, "_backend", backend)

    def __getattr__(self, name):
        if name not in ALLOWED:
            raise ReadOnlyViolation(f"MT5 funkce '{name}' není povolená (konektor je jen pro čtení)")
        return getattr(object.__getattribute__(self, "_backend"), name)

    def __setattr__(self, name, value):
        raise ReadOnlyViolation("obálka je neměnná")

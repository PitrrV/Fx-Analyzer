import pathlib, re, sys
import pytest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from mt5_readonly import ReadOnlyMT5, ReadOnlyViolation, ALLOWED, FORBIDDEN


class Fake:
    def __init__(self): self.sent = []
    def positions_get(self): return ["pos"]
    def order_send(self, req): self.sent.append(req); return "SENT"
    def login(self, *a, **k): self.sent.append(("login", a)); return True


def test_read_functions_pass_through():
    assert ReadOnlyMT5(Fake()).positions_get() == ["pos"]


@pytest.mark.parametrize("name", FORBIDDEN + ("order_modify", "position_close", "anything_new"))
def test_trading_and_unknown_functions_blocked_before_reaching_backend(name):
    fake = Fake()
    with pytest.raises(ReadOnlyViolation):
        getattr(ReadOnlyMT5(fake), name)
    assert fake.sent == []


def test_wrapper_cannot_be_modified():
    with pytest.raises(ReadOnlyViolation):
        ReadOnlyMT5(Fake()).order_send = lambda r: None


def test_allow_list_contains_no_trading_function():
    for bad in FORBIDDEN:
        assert bad not in ALLOWED


def test_connector_source_never_mentions_trading_calls_or_imports_mt5_directly():
    root = pathlib.Path(__file__).resolve().parents[1]
    for f in root.glob("*.py"):
        if f.name == "mt5_readonly.py":  # jediný soubor, který smí jména uvést (seznam zákazů)
            continue
        src = f.read_text(encoding="utf-8")
        for bad in FORBIDDEN + ("position_close", "order_modify"):
            assert not re.search(r"\b" + bad + r"\b", src), f"{f.name} obsahuje {bad}"
        assert not re.search(r"^\s*import MetaTrader5|^\s*from MetaTrader5", src, re.M), \
            f"{f.name} importuje MetaTrader5 přímo; použij ReadOnlyMT5"

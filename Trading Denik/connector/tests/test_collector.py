import datetime as dt, json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pytest
from fake_mt5 import FakeMT5, deal
from types import SimpleNamespace as NS
from collector import Collector
from main import run_cycle, load_state
from mt5_readonly import ReadOnlyMT5
from uploader import UploadError, post_batch

NOW = dt.datetime(2026, 11, 13, 12, 0, tzinfo=dt.timezone.utc)
T0 = int(dt.datetime(2026, 11, 13, 9, 0, tzinfo=dt.timezone.utc).timestamp() * 1000)
URL, TOKEN = "https://x.example/functions/v1/mt5-ingest", "mt5_" + "a" * 64


def mk(fake=None):
    f = fake or FakeMT5()
    return f, Collector(ReadOnlyMT5(f), now_fn=lambda: NOW)


class Server:
    """Falešný server: ukládá dealy podle ticketu (idempotentně) a umí 'vypadnout'."""
    def __init__(self): self.deals, self.batches, self.down = {}, [], False
    def __call__(self, url, token, payload):
        if self.down: raise UploadError("výpadek")
        self.batches.append(payload)
        for d in payload["deals"]: self.deals[(token, d["ticket"])] = d
        return {"ok": True, "positions": len(payload.get("positions", []))}


def test_open_and_close_trade_is_mapped(tmp_path):
    f, c = mk()
    f.deals = [deal(1, 7, T0, typ=0, entry=0), deal(2, 7, T0 + 3600000, typ=1, entry=1, price=1.105, profit=500.0)]
    f.orders = [NS(ticket=1001, position_id=7, symbol="EURUSD", type=0, state=4, time_setup_msc=T0, time_done_msc=T0, volume_initial=1.0, volume_current=0.0, price_open=1.1, sl=1.095, tp=1.11)]
    (payload, cur), = c.batches(None)
    assert [d["type"] for d in payload["deals"]] == ["BUY", "SELL"] and [d["entry"] for d in payload["deals"]] == ["IN", "OUT"]
    assert payload["orders"][0]["sl"] == 1.095 and payload["account"]["margin_mode"] == "hedging"
    assert payload["specs"]["EURUSD"]["tick_value"] == 1.0 and cur == T0 + 3600000


def test_open_position_observed_with_sl_tp():
    f, c = mk()
    f.positions = [NS(ticket=7, symbol="EURUSD", type=0, volume=1.0, price_open=1.1, sl=1.095, tp=1.11, profit=12.0, swap=0.0, time_msc=T0, time_update_msc=T0 + 5)]
    (payload, _), = c.batches(None)
    assert payload["positions"][0] == {"ticket": 7, "symbol": "EURUSD", "type": "BUY", "volume": 1.0, "price_open": 1.1, "sl": 1.095, "tp": 1.11, "profit": 12.0, "swap": 0.0, "time_msc": T0, "time_update_msc": T0 + 5}


def test_outage_loses_nothing_and_cursor_moves_only_after_server_ok(tmp_path):
    f, c = mk(); sp = str(tmp_path / "s.json"); srv = Server()
    f.deals = [deal(1, 7, T0)]
    state = load_state(sp)
    srv.down = True
    with pytest.raises(UploadError): run_cycle(c, state, sp, URL, TOKEN, post=srv, log=lambda *_: None)
    assert state["cursor_ms"] is None and not srv.deals            # nic se neposunulo
    f.deals.append(deal(2, 8, T0 + 60000))                          # mezitím další obchod
    srv.down = False
    run_cycle(c, state, sp, URL, TOKEN, post=srv, log=lambda *_: None)
    assert {k[1] for k in srv.deals} == {1, 2}                      # po obnovení spojení jsou oba
    assert state["cursor_ms"] == T0 + 60000


def test_restart_resumes_from_saved_cursor_and_duplicates_are_harmless(tmp_path):
    f, c = mk(); sp = str(tmp_path / "s.json"); srv = Server()
    f.deals = [deal(1, 7, T0)]
    run_cycle(c, load_state(sp), sp, URL, TOKEN, post=srv, log=lambda *_: None)
    c2 = Collector(ReadOnlyMT5(f), now_fn=lambda: NOW)              # "restart": nový objekt, stav ze souboru
    st2 = load_state(sp); assert st2["cursor_ms"] == T0
    f.deals.append(deal(2, 7, T0 + 1000))
    run_cycle(c2, st2, sp, URL, TOKEN, post=srv, log=lambda *_: None)
    assert len(srv.deals) == 2                                      # deal 1 poslán znovu (překryv), ale uložen jen jednou


def test_large_history_is_split_into_batches():
    f, c = mk()
    f.deals = [deal(i, i, T0 + i) for i in range(1, 2501)]
    bs = c.batches(None)
    assert [len(p["deals"]) for p, _ in bs] == [1000, 1000, 500]
    assert "positions" not in bs[0][0] and "positions" in bs[-1][0]  # pozorování jen v poslední dávce


def test_no_deals_does_not_rewind_to_1970():
    f, c = mk()
    (_, cur), = c.batches(None)
    assert cur == int(NOW.timestamp() * 1000)


def test_two_accounts_never_mix(tmp_path):
    fa, ca = mk(FakeMT5(login=1)); fb, cb = mk(FakeMT5(login=2))
    fa.deals = [deal(1, 7, T0, symbol="EURUSD")]; fb.deals = [deal(1, 7, T0, symbol="GBPUSD")]  # stejné tickety, jiné účty
    srv = Server()
    run_cycle(ca, load_state(str(tmp_path / "a.json")), str(tmp_path / "a.json"), URL, "mt5_" + "a" * 64, post=srv, log=lambda *_: None)
    run_cycle(cb, load_state(str(tmp_path / "b.json")), str(tmp_path / "b.json"), URL, "mt5_" + "b" * 64, post=srv, log=lambda *_: None)
    assert srv.deals[("mt5_" + "a" * 64, 1)]["symbol"] == "EURUSD" and srv.deals[("mt5_" + "b" * 64, 1)]["symbol"] == "GBPUSD"
    assert json.load(open(tmp_path / "a.json"))["cursor_ms"] == T0


def test_netting_account_mode_and_pending_orders():
    f, c = mk(FakeMT5(margin_mode=0))
    f.pending = [NS(ticket=55, position_id=0, symbol="EURUSD", type=2, state=1, time_setup_msc=T0, time_done_msc=0, volume_initial=1.0, volume_current=1.0, price_open=1.05, sl=1.04, tp=1.07)]
    (payload, _), = c.batches(None)
    assert payload["account"]["margin_mode"] == "netting"
    p = [o for o in payload["orders"] if o["ticket"] == 55][0]
    assert p["is_pending"] and p["type"] == "BUY_LIMIT"


def test_connector_never_trades_and_token_is_never_stored(tmp_path):
    f, c = mk(); sp = str(tmp_path / "s.json"); logs = []
    f.deals = [deal(1, 7, T0)]
    run_cycle(c, load_state(sp), sp, URL, TOKEN, post=Server(), log=logs.append)
    assert f.order_send_calls == 0
    assert TOKEN not in open(sp).read() and TOKEN not in " ".join(logs)


def test_uploader_requires_https_and_does_not_retry_auth_errors():
    with pytest.raises(UploadError): post_batch("http://x", TOKEN, {})
    import urllib.error, io
    calls = []
    def opener(req, timeout=0):
        calls.append(1); raise urllib.error.HTTPError(URL, 401, "no", {}, io.BytesIO(b""))
    with pytest.raises(UploadError, match="401"): post_batch(URL, TOKEN, {}, opener=opener, sleep=lambda s: None)
    assert len(calls) == 1
    calls.clear()
    def flaky(req, timeout=0):
        calls.append(1); raise OSError("down")
    with pytest.raises(UploadError): post_batch(URL, TOKEN, {}, opener=flaky, sleep=lambda s: None)
    assert len(calls) == 3

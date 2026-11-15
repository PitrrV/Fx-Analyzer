import datetime as dt, json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from fake_mt5 import FakeMT5, deal
from collector import Collector
from mt5_readonly import ReadOnlyMT5
from diagnose import build_report

NOW = dt.datetime(2026, 11, 13, 12, 0, tzinfo=dt.timezone.utc)
T0 = int(dt.datetime(2026, 11, 13, 9, 0, tzinfo=dt.timezone.utc).timestamp() * 1000)

def test_report_masks_login_drops_comments_and_warns_about_algo_trading():
    f = FakeMT5(login=123456789)
    f.deals = [deal(1, 7, T0), deal(2, 7, T0 + 3600000, typ=1, entry=1, price=1.105, profit=500.0)]
    rep = build_report(ReadOnlyMT5(f), Collector(ReadOnlyMT5(f), now_fn=lambda: NOW))
    s = json.dumps(rep)
    assert rep["account"]["login"] == "***789" and "123456789" not in s
    assert all("comment" not in d for d in rep["deals"])
    assert rep["counts"]["deals"] == 2 and rep["deal_types"] == {"BUY": 1, "SELL": 1}
    assert any("Algo Trading" in w for w in rep["warnings"])
    assert rep["raw_shapes"]["deal"] and f.order_send_calls == 0

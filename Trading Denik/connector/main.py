"""AT Trading MT5 konektor (READ-ONLY). Spuštění: python main.py --config config.json

Jeden proces = jeden MT5 terminál = jeden účet. Více účtů: více instalací terminálu (portable) a
u každého vlastní config.json (jiný token, state_file, terminal_path).
"""
import argparse
import json
import os
import sys
import time

from collector import Collector
from uploader import UploadError, post_batch


def load_state(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"cursor_ms": None}


def save_state(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, path)  # atomicky: při pádu nezůstane rozepsaný soubor


def read_token(cfg):
    tok = os.environ.get(cfg.get("token_env", "MT5_JOURNAL_TOKEN"), "").strip()
    if not tok and cfg.get("token_file"):
        with open(cfg["token_file"], "r", encoding="utf-8") as f:
            tok = f.read().strip()
    if not tok:
        raise SystemExit("Chybí token konektoru (proměnná prostředí nebo token_file).")
    return tok


def run_cycle(collector, state, state_path, url, token, post=post_batch, log=print):
    """Jeden průchod. Kurzor se posune až po potvrzení serverem => výpadek nic neztratí."""
    for payload, new_cursor in collector.batches(state.get("cursor_ms")):
        res = post(url, token, payload)
        state["cursor_ms"] = new_cursor
        save_state(state_path, state)
        log(f"OK deals={len(payload['deals'])} -> {json.dumps({k: res.get(k) for k in ('positions', 'events', 'sl_tp_changes', 'snapshots', 'snapshots_pending')})}")
    return state


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--once", action="store_true", help="jeden průchod a konec")
    a = ap.parse_args(argv)
    with open(a.config, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    token = read_token(cfg)
    from mt5_readonly import open_real
    mt5 = open_real()
    kw = {"path": cfg["terminal_path"]} if cfg.get("terminal_path") else {}
    if not mt5.initialize(**kw):
        raise SystemExit(f"MT5 initialize selhalo: {mt5.last_error()}")
    ti = mt5.terminal_info()
    if ti is not None and getattr(ti, "trade_allowed", False):
        print("UPOZORNĚNÍ: v terminálu je zapnuté Algo Trading. Konektor nikdy neobchoduje; doporučeno ho vypnout jako druhou pojistku.")
    collector = Collector(mt5, initial_days=int(cfg.get("history_days_initial", 365)))
    state_path = cfg.get("state_file", "state.json")
    state = load_state(state_path)
    poll = max(5, int(cfg.get("poll_seconds", 10)))
    while True:
        try:
            run_cycle(collector, state, state_path, cfg["api_url"], token)
        except UploadError as e:
            print(f"Odeslání selhalo, zkusím znovu (data se nenačtou jinak než od kurzoru, nic se neztratí): {e}")
        except Exception as e:  # nespadnout kvůli jednomu špatnému průchodu
            print(f"Chyba průchodu: {type(e).__name__}: {e}")
        if a.once:
            break
        time.sleep(poll)
    mt5.shutdown()


if __name__ == "__main__":
    sys.exit(main())

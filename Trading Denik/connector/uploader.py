"""HTTPS odesílání dávek na mt5-ingest. Jen stdlib. Token se nikdy neloguje ani neukládá do stavu."""
import json
import time
import urllib.error
import urllib.request


class UploadError(RuntimeError):
    pass


def post_batch(url, token, payload, timeout=30, retries=3, sleep=time.sleep, opener=urllib.request.urlopen):
    if not url.startswith("https://"):
        raise UploadError("api_url musí být HTTPS")
    body = json.dumps(payload).encode("utf-8")
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/json", "x-mt5-token": token})
        try:
            with opener(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):   # špatný/zrušený token nebo vypnutá synchronizace — opakování nepomůže
                raise UploadError(f"server odmítl přístup (HTTP {e.code})")
            last = f"HTTP {e.code}"
        except Exception as e:  # síť, timeout, DNS…
            last = type(e).__name__
        sleep(min(2 ** attempt * 2, 30))
    raise UploadError(f"odeslání selhalo po {retries} pokusech ({last})")

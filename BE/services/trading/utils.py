import base64
import hashlib
import hmac
import json
import os
import threading
import time
import traceback
import urllib.parse
from typing import Optional

from config import KRAKEN_BASE, KRAKEN_PAIR_MAP, HAS_REQUESTS, HAS_PANDAS

# ── Runtime key store (set via UI; lives for the server session) ─────────────
_runtime_keys: dict = {"api_key": "", "api_secret": ""}

# ── Bot state ─────────────────────────────────────────────────────────────────
_bot_lock = threading.Lock()
_bot: dict = {
    "running":       False,
    "strategy_id":   None,
    "strategy_name": "",
    "strategy_code": None,
    "pair":          None,
    "interval":      1440,
    "allocation":    10.0,
    "position":      None,
    "position_qty":  0.0,
    "entry_price":   None,
    "entry_time":    None,
    "order_id":      None,
    "realized_pnl":  0.0,
    "logs":          [],
    "_thread":       None,
    "_stop_event":   threading.Event(),
    "started_at":    None,
    "last_tick":     None,
    "last_signal":   None,
}


# ── Logging ───────────────────────────────────────────────────────────────────

def bot_log(level: str, msg: str, meta: dict = None):
    entry = {"ts": int(time.time()), "level": level, "msg": msg, "meta": meta or {}}
    with _bot_lock:
        _bot["logs"].append(entry)
        if len(_bot["logs"]) > 300:
            _bot["logs"] = _bot["logs"][-300:]
    try:
        from services.trading.service import persist_bot_log
        persist_bot_log(entry)
    except Exception:
        pass


# ── Kraken helpers ────────────────────────────────────────────────────────────

def kraken_sign(urlpath: str, data: dict, secret: str) -> str:
    postdata = urllib.parse.urlencode(data)
    encoded  = (str(data["nonce"]) + postdata).encode()
    message  = urlpath.encode() + hashlib.sha256(encoded).digest()
    mac      = hmac.new(base64.b64decode(secret), message, hashlib.sha512)
    return base64.b64encode(mac.digest()).decode()


def kraken_private(endpoint: str, data: dict = None) -> dict:
    api_key    = _runtime_keys["api_key"] or os.environ.get("KRAKEN_API_KEY", "").strip()
    api_secret = _runtime_keys["api_secret"] or os.environ.get("KRAKEN_API_SECRET", "").strip()
    if not api_key or not api_secret:
        return {"error": ["Kraken API keys not configured"]}
    if not HAS_REQUESTS:
        return {"error": ["requests library not installed"]}

    import requests as http_req
    data          = data or {}
    data["nonce"] = str(int(time.time() * 1000))
    urlpath       = f"/0/private/{endpoint}"
    signature     = kraken_sign(urlpath, data, api_secret)
    headers       = {
        "API-Key":      api_key,
        "API-Sign":     signature,
        "Content-Type": "application/x-www-form-urlencoded",
    }
    try:
        resp = http_req.post(f"{KRAKEN_BASE}{urlpath}", data=data, headers=headers, timeout=10)
        return resp.json()
    except Exception as e:
        return {"error": [str(e)]}


def kraken_public(endpoint: str, params: dict = None) -> dict:
    if not HAS_REQUESTS:
        return {"error": ["requests library not installed"]}
    import requests as http_req
    try:
        resp = http_req.get(f"{KRAKEN_BASE}/0/public/{endpoint}", params=params or {}, timeout=5)
        return resp.json()
    except Exception as e:
        return {"error": [str(e)]}


# ── Live signal computation ───────────────────────────────────────────────────

def get_live_signal(code: str, pair: str, interval: int) -> Optional[str]:
    if not HAS_PANDAS:
        return None
    try:
        import numpy as np
        import pandas as pd
        from database import db

        conn = db()
        rows = conn.execute(
            "SELECT ts AS time, open, high, low, close, volume, vwap, trades "
            "FROM ohlcvt WHERE pair=? AND interval=? ORDER BY ts DESC LIMIT 1000",
            (pair, interval),
        ).fetchall()
        unlock_rows = conn.execute(
            "SELECT date AS time, daily_new_tokens, cumulative_tokens, "
            "has_cliff_event, cliff_event_tokens, inflation_pct_of_supply "
            "FROM token_unlocks WHERE pair=? ORDER BY date ASC", (pair,)
        ).fetchall()
        conn.close()

        if not rows:
            return None

        df      = pd.DataFrame([dict(r) for r in rows]).sort_values("time").reset_index(drop=True)
        unlocks = pd.DataFrame([dict(r) for r in unlock_rows])

        try:
            import ta as _ta
        except ImportError:
            _ta = None

        ns = {"__builtins__": __builtins__, "pd": pd, "pandas": pd, "np": np, "numpy": np}
        if _ta:
            ns["ta"] = _ta
        exec(compile(code, "<strategy>", "exec"), ns)
        if "strategy" not in ns:
            return None

        trades = ns["strategy"](df.copy(), unlocks.copy())
        if not trades:
            return "flat"

        now = time.time()
        for t in trades:
            e, x = t.get("entry", 0), t.get("exit", 0)
            if e <= now < x:
                return str(t.get("side", "flat")).lower()

        last = max(trades, key=lambda t: t.get("entry", 0))
        if last.get("exit", 0) > now:
            return str(last.get("side", "flat")).lower()

        return "flat"
    except Exception as e:
        bot_log("error", f"Strategy signal error: {e}")
        return None


# ── Bot runner thread ─────────────────────────────────────────────────────────

def bot_runner():
    bot_log("info", f"🤖 Bot started — {_bot['pair']} @ {_bot['interval']}min "
            f"| Allocation: ${_bot['allocation']:.2f}")

    sleep_secs = max(_bot["interval"] * 60, 60)

    while not _bot["_stop_event"].is_set():
        tick_start = time.time()
        try:
            _bot["last_tick"] = int(tick_start)
            signal = get_live_signal(_bot["strategy_code"], _bot["pair"], _bot["interval"])

            if signal is None:
                bot_log("warn", "Could not compute signal — skipping tick")
            else:
                _bot["last_signal"] = signal
                desired  = signal if signal in ("long", "short") else None
                current  = _bot["position"]
                kraken_p = KRAKEN_PAIR_MAP.get(_bot["pair"], _bot["pair"])

                bot_log("info",
                        f"Tick — signal: {signal} | position: {current or 'flat'}",
                        {"pair": _bot["pair"], "signal": signal})

                if desired != current:
                    if current is not None and _bot["position_qty"] > 0:
                        close_type = "sell" if current == "long" else "buy"
                        bot_log("info", f"Closing {current} ({_bot['position_qty']:.6f})")
                        close_resp = kraken_private("AddOrder", {
                            "pair":      kraken_p,
                            "type":      close_type,
                            "ordertype": "market",
                            "volume":    f"{_bot['position_qty']:.6f}",
                        })
                        if close_resp.get("error") and close_resp["error"]:
                            bot_log("error", f"Close error: {close_resp['error']}")
                        else:
                            ticker = kraken_public("Ticker", {"pair": kraken_p})
                            if not (ticker.get("error") and ticker["error"]):
                                td = list((ticker.get("result") or {}).values())
                                if td:
                                    cp = float(td[0]["c"][0])
                                    pnl = (
                                        (_bot["position_qty"] * cp) - _bot["allocation"]
                                        if current == "long"
                                        else _bot["allocation"] - (_bot["position_qty"] * cp)
                                    )
                                    _bot["realized_pnl"] += pnl
                                    bot_log("success", f"Closed @ ${cp:.4f} | P&L: ${pnl:.4f}")
                            _bot["position"]     = None
                            _bot["position_qty"] = 0.0
                            _bot["entry_price"]  = None

                    if desired is not None:
                        ticker = kraken_public("Ticker", {"pair": kraken_p})
                        if ticker.get("error") and ticker["error"]:
                            bot_log("error", f"Ticker error: {ticker['error']}")
                        else:
                            td = list((ticker.get("result") or {}).values())
                            if td:
                                ask   = float(td[0]["a"][0])
                                bid   = float(td[0]["b"][0])
                                price = ask if desired == "long" else bid
                                qty   = _bot["allocation"] / price

                                bot_log("info",
                                        f"Opening {desired} — qty: {qty:.6f} @ ~${price:.4f}",
                                        {"side": desired, "qty": qty, "price": price})

                                order = kraken_private("AddOrder", {
                                    "pair":      kraken_p,
                                    "type":      "buy" if desired == "long" else "sell",
                                    "ordertype": "market",
                                    "volume":    f"{qty:.6f}",
                                })
                                if order.get("error") and order["error"]:
                                    bot_log("error", f"Open order error: {order['error']}")
                                else:
                                    txids                = (order.get("result") or {}).get("txid", [])
                                    _bot["position"]     = desired
                                    _bot["position_qty"] = qty
                                    _bot["entry_price"]  = price
                                    _bot["entry_time"]   = int(time.time())
                                    _bot["order_id"]     = txids[0] if txids else None
                                    bot_log("success",
                                            f"✅ {desired.upper()} opened @ ${price:.4f} "
                                            f"(txid: {_bot['order_id']})",
                                            {"side": desired, "price": price, "qty": qty})

        except Exception as exc:
            bot_log("error", f"Bot tick exception: {exc}\n{traceback.format_exc()}")

        _bot["_stop_event"].wait(timeout=sleep_secs)

    bot_log("info", "🛑 Bot stopped")

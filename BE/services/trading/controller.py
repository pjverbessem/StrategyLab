import os
import threading
from typing import Optional

from pydantic import BaseModel

from config import HAS_REQUESTS
from services.trading import service
from services.trading.utils import (
    _bot, _bot_lock, _runtime_keys,
    bot_log, bot_runner,
    kraken_private, kraken_public,
)
from services.market_data.service import fetch_live_price


class BotStartRequest(BaseModel):
    strategy_id: Optional[str] = None
    code:        Optional[str] = None
    pair:        str           = "ARBUSD"
    interval:    int           = 1440
    allocation:  float         = 10.0


class SetKeysRequest(BaseModel):
    api_key:    str
    api_secret: str


def bot_start(req: BotStartRequest):
    with _bot_lock:
        if _bot["running"]:
            return {"error": "Bot is already running. Stop it first."}

    code = req.code or ""
    name = "Custom Strategy"

    if req.strategy_id:
        code, name = service.fetch_strategy_by_id(req.strategy_id)
        if code is None:
            return {"error": f"Strategy {req.strategy_id} not found"}

    if not code.strip():
        return {"error": "No strategy code provided"}

    _bot["_stop_event"].clear()
    _bot.update({
        "running":       True,
        "strategy_id":   req.strategy_id,
        "strategy_name": name,
        "strategy_code": code,
        "pair":          req.pair.upper(),
        "interval":      req.interval,
        "allocation":    req.allocation,
        "position":      None,
        "position_qty":  0.0,
        "entry_price":   None,
        "entry_time":    None,
        "order_id":      None,
        "realized_pnl":  0.0,
        "logs":          [],
        "started_at":    __import__("time").time().__int__(),
        "last_tick":     None,
        "last_signal":   None,
    })
    t = threading.Thread(target=bot_runner, daemon=True)
    _bot["_thread"] = t
    t.start()
    return {"started": True, "pair": req.pair, "allocation": req.allocation}


def bot_stop():
    with _bot_lock:
        if not _bot["running"]:
            return {"error": "Bot is not running"}
    _bot["_stop_event"].set()
    _bot["running"] = False
    return {"stopped": True}


def bot_status():
    with _bot_lock:
        s = dict(_bot)
    s.pop("_thread", None)
    s.pop("_stop_event", None)
    s.pop("strategy_code", None)

    unrealized_pnl = 0.0
    if s["position"] and s["entry_price"] and HAS_REQUESTS:
        ticker = fetch_live_price(s["pair"])
        if "last" in ticker:
            price = ticker["last"]
            if s["position"] == "long":
                unrealized_pnl = (price - s["entry_price"]) * s["position_qty"]
            else:
                unrealized_pnl = (s["entry_price"] - price) * s["position_qty"]

    s["unrealized_pnl"] = round(unrealized_pnl, 4)
    s["logs"] = list(reversed(s.get("logs", [])))[:50]
    return s


def bot_logs(limit: int = 100):
    with _bot_lock:
        logs = list(reversed(_bot.get("logs", [])))
    return logs[:limit]


def kraken_balance():
    resp = kraken_private("Balance")
    if resp.get("error") and resp["error"]:
        return {"error": str(resp["error"])}
    balances = resp.get("result", {})
    cleaned  = {k: round(float(v), 8) for k, v in balances.items() if float(v) > 0.000001}
    return {"balances": cleaned, "raw": balances}


def kraken_status():
    api_key    = _runtime_keys["api_key"] or os.environ.get("KRAKEN_API_KEY", "").strip()
    api_secret = _runtime_keys["api_secret"] or os.environ.get("KRAKEN_API_SECRET", "").strip()
    if not api_key or not api_secret:
        return {"connected": False, "error": "No API keys configured"}
    if not HAS_REQUESTS:
        return {"connected": False, "error": "requests library not installed"}
    resp = kraken_private("Balance")
    if resp.get("error") and resp["error"]:
        return {"connected": False, "error": str(resp["error"])}
    return {"connected": True, "key_prefix": api_key[:8] + "…"}


def kraken_set_keys(req: SetKeysRequest):
    _runtime_keys["api_key"]    = req.api_key.strip()
    _runtime_keys["api_secret"] = req.api_secret.strip()
    if not _runtime_keys["api_key"] or not _runtime_keys["api_secret"]:
        return {"ok": False, "error": "Both api_key and api_secret are required"}
    resp = kraken_private("Balance")
    if resp.get("error") and resp["error"]:
        _runtime_keys["api_key"]    = ""
        _runtime_keys["api_secret"] = ""
        return {"ok": False, "error": str(resp["error"])}
    return {"ok": True, "key_prefix": req.api_key[:8] + "…"}

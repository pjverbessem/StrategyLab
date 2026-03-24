import inspect
import json
import urllib.request
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

from database import db
from config import HAS_DS, KRAKEN_BASE
from services.backtest.utils import precompute_indicators


def _http_get_json(url: str) -> dict:
    """HTTP GET with JSON response, using requests if available else urllib (ssl-unverified)."""
    try:
        import requests as _req
        resp = _req.get(url, timeout=15)
        return resp.json()
    except ImportError:
        pass
    import ssl
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(url, timeout=15, context=ctx) as resp:
        return json.loads(resp.read())


def _fetch_from_kraken_api(pair: str, interval: int, start_ts: int, end_ts: int) -> pd.DataFrame:
    """Fetch OHLCV from Kraken public REST API (paginated, up to 20 pages)."""
    rows: list = []
    since = start_ts

    for _ in range(20):
        url = f"{KRAKEN_BASE}/0/public/OHLC?pair={pair}&interval={interval}&since={since}"
        try:
            data = _http_get_json(url)
        except Exception:
            break

        if data.get("error"):
            break

        result = data.get("result", {})
        pair_key = next((k for k in result if k != "last"), None)
        if not pair_key:
            break

        candles = result[pair_key]
        last = int(result.get("last", 0))

        for c in candles:
            if int(c[0]) <= end_ts:
                rows.append(c)

        if not candles or last <= since or last >= end_ts:
            break
        since = last

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows, columns=["time", "open", "high", "low", "close", "vwap", "volume", "trades"])
    for col in ["open", "high", "low", "close", "vwap", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df["trades"] = pd.to_numeric(df["trades"], errors="coerce")
    df["time"] = df["time"].astype(int)
    return df.drop_duplicates("time").sort_values("time").reset_index(drop=True)


def fetch_kraken_data(pair: str, interval: int, start: Optional[str], end: Optional[str]):
    conn  = db()
    conds = ["pair = ?", "interval = ?"]
    parms: list = [pair, interval]

    start_ts = int(datetime.fromisoformat(start).replace(tzinfo=timezone.utc).timestamp()) if start else 0
    end_ts   = int(datetime.fromisoformat(end).replace(tzinfo=timezone.utc).timestamp()) + 86400 if end else int(datetime.now(timezone.utc).timestamp())

    if start:
        parms.append(start_ts)
        conds.append("ts >= ?")
    if end:
        parms.append(end_ts)
        conds.append("ts <= ?")

    where = " AND ".join(conds)

    try:
        ohlcvt_rows = conn.execute(
            f"SELECT ts AS time, open, high, low, close, volume, vwap, trades "
            f"FROM ohlcvt WHERE {where} ORDER BY ts ASC", parms
        ).fetchall()
    except Exception:
        ohlcvt_rows = []

    try:
        unlock_rows = conn.execute(
            "SELECT date AS time, daily_new_tokens, cumulative_tokens, "
            "has_cliff_event, cliff_event_tokens, inflation_pct_of_supply "
            "FROM token_unlocks WHERE pair = ? ORDER BY date ASC", (pair,)
        ).fetchall()
    except Exception:
        unlock_rows = []

    try:
        fg_rows = conn.execute(
            "SELECT date, value AS fg_value, classification AS fg_class "
            "FROM fear_greed ORDER BY date ASC"
        ).fetchall()
    except Exception:
        fg_rows = []

    conn.close()

    if ohlcvt_rows:
        df = pd.DataFrame([dict(r) for r in ohlcvt_rows])
    else:
        df = _fetch_from_kraken_api(pair, interval, start_ts, end_ts)

    unlocks       = pd.DataFrame([dict(r) for r in unlock_rows])
    fear_greed_df = (
        pd.DataFrame([dict(r) for r in fg_rows])
        if fg_rows
        else pd.DataFrame(columns=["date", "fg_value", "fg_class"])
    )
    return df, unlocks, fear_greed_df


def fetch_exchange_data(exchange: str, pair: str, interval: int, start: Optional[str], end: Optional[str]):
    import time as _time, datetime as _bdt

    if not HAS_DS:
        return None, f"data_sources module not available"

    from config import HAS_DS
    from data_sources import (
        BinanceConnector, OKXConnector, BybitConnector,
        CoinbaseConnector, HyperliquidConnector, DYDXConnector,
    )
    connector_map = {
        "binance":     BinanceConnector,
        "okx":         OKXConnector,
        "bybit":       BybitConnector,
        "coinbase":    CoinbaseConnector,
        "hyperliquid": HyperliquidConnector,
        "dydx":        DYDXConnector,
    }
    connector_cls = connector_map.get(exchange)
    if connector_cls is None:
        return None, f"Unknown exchange: {exchange}"

    try:
        try:
            _s        = _bdt.date.fromisoformat(start)
            _e        = _bdt.date.fromisoformat(end)
            start_ts  = int(_bdt.datetime(_s.year, _s.month, _s.day, tzinfo=_bdt.timezone.utc).timestamp())
            end_ts    = int(_bdt.datetime(_e.year, _e.month, _e.day, 23, 59, 59, tzinfo=_bdt.timezone.utc).timestamp())
        except Exception:
            start_ts  = 0
            end_ts    = int(_time.time())

        ext_df = connector_cls.fetch_ohlcv(
            symbol=pair, interval_minutes=interval, start_ts=start_ts, end_ts=end_ts
        )
        if ext_df is None or ext_df.empty:
            return None, f"No OHLCVT data returned from {exchange} for {pair}."

        if "ts" in ext_df.columns and "time" not in ext_df.columns:
            ext_df = ext_df.rename(columns={"ts": "time"})
        if "time" not in ext_df.columns:
            return None, f"{exchange} connector returned unexpected columns: {list(ext_df.columns)}"

        for col in ["open", "high", "low", "close", "volume"]:
            if col in ext_df.columns:
                ext_df[col] = pd.to_numeric(ext_df[col], errors="coerce")
        for stub in ["vwap", "trades"]:
            if stub not in ext_df.columns:
                ext_df[stub] = None

        return ext_df.reset_index(drop=True), None

    except Exception as e:
        return None, f"Failed to fetch data from {exchange}: {e}"


def execute_strategy(script: str, df: pd.DataFrame, unlocks: pd.DataFrame,
                     fear_greed_df: pd.DataFrame, indicators: list):
    try:
        import ta as _ta
    except ImportError:
        _ta = None

    # Merge Fear & Greed into df
    if not fear_greed_df.empty and not df.empty:
        df["date"] = pd.to_datetime(df["time"], unit="s").dt.strftime("%Y-%m-%d")
        df = df.merge(fear_greed_df[["date", "fg_value", "fg_class"]], on="date", how="left")
        df["fg_value"] = df["fg_value"].fillna(50).astype(int)
        df["fg_class"] = df["fg_class"].fillna("Neutral")
    else:
        df["date"]     = pd.to_datetime(df["time"], unit="s").dt.strftime("%Y-%m-%d")
        df["fg_value"] = 50
        df["fg_class"] = "Neutral"

    if indicators:
        df = precompute_indicators(df, indicators, _ta)

    ns: dict = {
        "__builtins__": __builtins__,
        "pd": pd, "pandas": pd, "np": np, "numpy": np,
    }
    if _ta:
        ns["ta"] = _ta

    exec(compile(script, "<strategy>", "exec"), ns)

    if "strategy" not in ns:
        return df, None, "❌ Script must define a function named strategy(df, unlocks)"

    sig = inspect.signature(ns["strategy"])
    if len(sig.parameters) >= 3:
        raw_trades = ns["strategy"](df.copy(), unlocks.copy(), fear_greed_df.copy())
    else:
        raw_trades = ns["strategy"](df.copy(), unlocks.copy())

    return df, raw_trades, None

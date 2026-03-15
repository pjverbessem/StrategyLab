#!/usr/bin/env python3
"""
api.py — Strategy Lab Backend v2
Run: python3 src/api.py
Opens: http://localhost:8000
"""

import sqlite3, math, traceback, statistics, os, uuid, json, time
import hmac, hashlib, base64, urllib.parse, threading
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional, List
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    from fastapi import FastAPI, UploadFile, File, Form
    from fastapi.staticfiles import StaticFiles
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel
    import uvicorn
except ImportError:
    print("Missing deps. Run:  pip3 install fastapi uvicorn python-multipart"); raise

try:
    import pandas as pd
    HAS_PANDAS = True
except ImportError:
    HAS_PANDAS = False

try:
    from google import genai as google_genai
    from google.genai import types as genai_types
    HAS_GEMINI = True
except ImportError:
    HAS_GEMINI = False
    print("[WARN] google-genai not installed — /api/chat disabled.")

try:
    import requests as http_req
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False
    print("[WARN] requests not installed — Kraken live API disabled. Run: pip3 install requests")

import numpy as np

BASE_DIR = Path(__file__).parent.parent
DB_PATH  = BASE_DIR / "data" / "kraken.db"
WEB_DIR  = Path(__file__).parent / "web"

app = FastAPI(title="Strategy Lab", version="2.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

PAIR_COLORS = {"ARBUSD": "#0891b2", "OPUSD": "#dc2626", "STRKUSD": "#7c3aed", "ZKUSD": "#2563eb"}
PAIR_NAMES  = {"ARBUSD": "Arbitrum",  "OPUSD": "Optimism", "STRKUSD": "Starknet", "ZKUSD": "ZKsync Era"}

# Mapping from internal pair name → Kraken REST API pair name
KRAKEN_PAIR_MAP = {
    "ARBUSD":  "ARB/USD",
    "OPUSD":   "OP/USD",
    "STRKUSD": "STRK/USD",
    "ZKUSD":   "ZK/USD",
    "BTCUSD":  "XBT/USD",
    "ETHUSD":  "ETH/USD",
    "SOLUSD":  "SOL/USD",
}
KRAKEN_BASE = "https://api.kraken.com"

# ── DB helpers ────────────────────────────────────────────────────────────────
def db():
    c = sqlite3.connect(DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c

def init_db():
    conn = db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS strategies (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            code TEXT NOT NULL,
            algo TEXT DEFAULT '',
            params_text TEXT DEFAULT '',
            pair TEXT DEFAULT '',
            interval INTEGER DEFAULT 1440,
            stats TEXT DEFAULT '{}',
            tags TEXT DEFAULT '[]',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS bot_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            level TEXT NOT NULL,
            msg TEXT NOT NULL,
            meta TEXT DEFAULT '{}'
        )""")
    conn.commit()
    conn.close()

init_db()

def ts2date(ts): return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
def fmt(n):
    if n >= 1e9: return f"{n/1e9:.2f}B"
    if n >= 1e6: return f"{n/1e6:.0f}M"
    return str(int(n))


# ══════════════════════════════════════════════════════════════════════════════
# ── PAIRS & OHLCVT ───────────────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/pairs")
def pairs():
    conn = db()
    rows = conn.execute("""
        SELECT pair,
               GROUP_CONCAT(DISTINCT interval ORDER BY interval) AS intervals,
               MIN(ts) AS min_ts, MAX(ts) AS max_ts, COUNT(*) AS count
        FROM ohlcvt GROUP BY pair ORDER BY pair
    """).fetchall()
    conn.close()
    return [{
        "pair":      r["pair"],
        "name":      PAIR_NAMES.get(r["pair"], r["pair"]),
        "color":     PAIR_COLORS.get(r["pair"], "#6366f1"),
        "intervals": [int(i) for i in r["intervals"].split(",")],
        "start":     ts2date(r["min_ts"]),
        "end":       ts2date(r["max_ts"]),
        "count":     r["count"],
    } for r in rows]


@app.get("/api/ohlcvt")
def ohlcvt(pair: str = "STRKUSD", interval: int = 1440,
           start: Optional[str] = None, end: Optional[str] = None):
    conn  = db()
    conds = ["pair = ?", "interval = ?"]
    parms = [pair.upper(), interval]
    if start:
        conds.append("ts >= ?")
        parms.append(int(datetime.fromisoformat(start).replace(tzinfo=timezone.utc).timestamp()))
    if end:
        conds.append("ts <= ?")
        parms.append(int(datetime.fromisoformat(end).replace(tzinfo=timezone.utc).timestamp()) + 86400)

    where = " AND ".join(conds)
    TARGET = 10_000
    FULL_RETURN_THRESHOLD = 15_000

    total = conn.execute(f"SELECT COUNT(*) FROM ohlcvt WHERE {where}", parms).fetchone()[0]

    if total <= FULL_RETURN_THRESHOLD:
        rows = conn.execute(
            f"SELECT ts AS time, open, high, low, close, volume, vwap, trades "
            f"FROM ohlcvt WHERE {where} ORDER BY ts ASC", parms).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    else:
        step = math.ceil(total / TARGET)
        rows = conn.execute(f"""
            SELECT time, open, high, low, close, volume, vwap, trades
            FROM (
                SELECT ts AS time, open, high, low, close, volume, vwap, trades,
                       ROW_NUMBER() OVER (ORDER BY ts) AS rn
                FROM ohlcvt WHERE {where}
            )
            WHERE rn % ? = 1
            ORDER BY time
            """, parms + [step]).fetchall()
        conn.close()
        return [dict(r) for r in rows]


@app.get("/api/unlocks")
def unlocks(pair: str = "STRKUSD"):
    conn = db()
    rows = conn.execute("""
        SELECT date AS time, daily_new_tokens, cumulative_tokens,
               has_cliff_event, cliff_event_tokens, inflation_pct_of_supply
        FROM token_unlocks WHERE pair = ? ORDER BY date ASC
    """, (pair.upper(),)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/api/unlock-events")
def unlock_events(pair: str = "STRKUSD"):
    conn = db()
    rows = conn.execute("""
        SELECT date AS time, category, amount, event_type, note
        FROM unlock_events WHERE pair = ? AND event_type = 'cliff' ORDER BY date ASC
    """, (pair.upper(),)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/api/upcoming-cliffs")
def upcoming_cliffs(days: int = 120):
    conn = db()
    now  = int(datetime.now(tz=timezone.utc).timestamp())
    rows = conn.execute("""
        SELECT tu.pair, tu.date AS time, tu.cliff_event_tokens, ue.category
        FROM token_unlocks tu
        LEFT JOIN unlock_events ue
            ON tu.pair = ue.pair AND tu.date = ue.date AND ue.event_type = 'cliff'
        WHERE tu.has_cliff_event = 1
          AND tu.date > ?
          AND tu.date <= ? + ?
        ORDER BY tu.date
        LIMIT 30
    """, (now, now, days * 86400)).fetchall()
    conn.close()
    return [{
        **dict(r),
        "date_str":    ts2date(r["time"]),
        "color":       PAIR_COLORS.get(r["pair"], "#6366f1"),
        "name":        PAIR_NAMES.get(r["pair"], r["pair"]),
        "amount_fmt":  fmt(r["cliff_event_tokens"] or 0),
    } for r in rows]


@app.get("/api/db-summary")
def db_summary():
    conn = db()
    ohlcvt_rows  = conn.execute("""
        SELECT pair, interval, COUNT(*) AS rows, MIN(ts) AS min_ts, MAX(ts) AS max_ts
        FROM ohlcvt GROUP BY pair, interval ORDER BY pair, interval
    """).fetchall()
    unlock_rows = conn.execute("""
        SELECT pair, COUNT(*) AS days,
               SUM(has_cliff_event) AS cliff_days,
               SUM(cliff_event_tokens) AS total_cliff_tokens,
               MIN(date) AS min_d, MAX(date) AS max_d
        FROM token_unlocks GROUP BY pair
    """).fetchall()
    counts = {}
    for tbl in ("ohlcvt", "token_unlocks", "unlock_events"):
        counts[tbl] = conn.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
    conn.close()
    return {
        "counts":  counts,
        "ohlcvt":  [{**dict(r), "start": ts2date(r["min_ts"]), "end": ts2date(r["max_ts"])} for r in ohlcvt_rows],
        "unlocks": [{**dict(r), "start": ts2date(r["min_d"]),  "end": ts2date(r["max_d"])}  for r in unlock_rows],
    }


@app.get("/api/coins")
def coins(min_rank: Optional[int] = None, max_rank: Optional[int] = None,
          min_volume_24h: Optional[float] = None, min_market_cap: Optional[float] = None,
          kraken_only: bool = True, limit: int = 500):
    conn = db()
    loaded = {r[0] for r in conn.execute("SELECT DISTINCT pair FROM ohlcvt WHERE interval=1440").fetchall()}
    conds = []; params: list = []
    if kraken_only:       conds.append("kraken_pair IS NOT NULL")
    if min_rank is not None:       conds.append("cmc_rank >= ?"); params.append(min_rank)
    if max_rank is not None:       conds.append("cmc_rank <= ?"); params.append(max_rank)
    if min_volume_24h is not None: conds.append("volume_24h_usd >= ?"); params.append(min_volume_24h)
    if min_market_cap is not None: conds.append("market_cap_usd >= ?"); params.append(min_market_cap)
    where = ("WHERE " + " AND ".join(conds)) if conds else ""
    params.append(limit)
    rows = conn.execute(
        f"SELECT symbol, name, cmc_rank, market_cap_usd, volume_24h_usd, "
        f"price_usd, kraken_pair, last_updated FROM coins {where} ORDER BY cmc_rank LIMIT ?",
        params).fetchall()
    conn.close()
    return [{**dict(r), "in_db": r["kraken_pair"] in loaded if r["kraken_pair"] else False} for r in rows]


@app.get("/api/fear-greed/latest")
def fear_greed_latest():
    """Return the most recent Fear & Greed reading."""
    conn = db()
    row = conn.execute(
        "SELECT date, timestamp_utc, value, classification, source "
        "FROM fear_greed ORDER BY date DESC LIMIT 1"
    ).fetchone()
    conn.close()
    if not row:
        return {"error": "No Fear & Greed data found. Run src/fetch_fear_greed.py first."}
    return dict(row)


@app.get("/api/fear-greed")
def fear_greed(
    start: Optional[str] = None,
    end:   Optional[str] = None,
    limit: int = 365,
):
    """
    Return daily Fear & Greed Index values.

    Query params:
      start  ISO date string e.g. '2024-01-01'  (inclusive)
      end    ISO date string e.g. '2025-01-01'  (inclusive)
      limit  max rows to return (default 365, max 5000)
    """
    conn = db()
    conds: list[str] = []
    params: list = []
    if start:
        conds.append("date >= ?"); params.append(start)
    if end:
        conds.append("date <= ?"); params.append(end)
    where = ("WHERE " + " AND ".join(conds)) if conds else ""
    params.append(min(limit, 5000))
    rows = conn.execute(
        f"SELECT date, timestamp_utc, value, classification, source "
        f"FROM fear_greed {where} ORDER BY date ASC LIMIT ?",
        params,
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ══════════════════════════════════════════════════════════════════════════════
# ── BACKTESTING ───────────────────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════════════

class BacktestRequest(BaseModel):
    pair:     str           = "STRKUSD"
    interval: int           = 1440
    start:    Optional[str] = None
    end:      Optional[str] = None
    script:   str           = ""

class MultiBacktestRequest(BaseModel):
    pairs:    List[str]     = []
    interval: int           = 1440
    start:    Optional[str] = None
    end:      Optional[str] = None
    script:   str           = ""
    max_workers: int        = 8


@app.post("/api/backtest")
def run_backtest(req: BacktestRequest):
    if not HAS_PANDAS:
        return {"error": "pandas not installed", "trades": [], "equity": [], "stats": {}}
    if not req.script.strip():
        return {"error": "Script is empty",      "trades": [], "equity": [], "stats": {}}

    try:
        pair = req.pair.upper()
        conn = db()
        conds = ["pair = ?", "interval = ?"]
        parms: list = [pair, req.interval]
        if req.start:
            parms.append(int(datetime.fromisoformat(req.start).replace(tzinfo=timezone.utc).timestamp()))
            conds.append("ts >= ?")
        if req.end:
            parms.append(int(datetime.fromisoformat(req.end).replace(tzinfo=timezone.utc).timestamp()) + 86400)
            conds.append("ts <= ?")

        where = " AND ".join(conds)
        ohlcvt_rows = conn.execute(
            f"SELECT ts AS time, open, high, low, close, volume, vwap, trades "
            f"FROM ohlcvt WHERE {where} ORDER BY ts ASC", parms).fetchall()
        unlock_rows = conn.execute(
            "SELECT date AS time, daily_new_tokens, cumulative_tokens, "
            "has_cliff_event, cliff_event_tokens, inflation_pct_of_supply "
            "FROM token_unlocks WHERE pair = ? ORDER BY date ASC", (pair,)).fetchall()

        # ── Fear & Greed index ──
        fg_rows = conn.execute(
            "SELECT date, value AS fg_value, classification AS fg_class "
            "FROM fear_greed ORDER BY date ASC").fetchall()
        conn.close()

        df      = pd.DataFrame([dict(r) for r in ohlcvt_rows])
        unlocks = pd.DataFrame([dict(r) for r in unlock_rows])
        fear_greed_df = pd.DataFrame([dict(r) for r in fg_rows]) if fg_rows else pd.DataFrame(columns=["date","fg_value","fg_class"])

        if df.empty:
            return {"error": "No OHLCVT data for the selected pair/interval/range.",
                    "trades": [], "equity": [], "stats": {}}

        try:
            import ta as _ta
        except ImportError:
            _ta = None

        ns: dict = {
            "__builtins__": __builtins__,
            "pd": pd, "pandas": pd, "np": np, "numpy": np,
        }
        if _ta:
            ns["ta"] = _ta
        exec(compile(req.script, "<strategy>", "exec"), ns)

        if "strategy" not in ns:
            return {"error": "❌ Script must define a function named strategy(df, unlocks)",
                    "trades": [], "equity": [], "stats": {}}

        # ── Pre-merge Fear & Greed into df so strategy() can use fg_value directly ──
        if not fear_greed_df.empty and not df.empty:
            df['date'] = pd.to_datetime(df['time'], unit='s').dt.strftime('%Y-%m-%d')
            df = df.merge(fear_greed_df[['date', 'fg_value', 'fg_class']], on='date', how='left')
            df['fg_value'] = df['fg_value'].fillna(50).astype(int)   # neutral 50 if missing
            df['fg_class'] = df['fg_class'].fillna('Neutral')
        else:
            df['date'] = pd.to_datetime(df['time'], unit='s').dt.strftime('%Y-%m-%d')
            df['fg_value'] = 50
            df['fg_class'] = 'Neutral'

        # Call strategy() — pass fear_greed_df if the function accepts 3+ args
        import inspect
        sig = inspect.signature(ns["strategy"])
        if len(sig.parameters) >= 3:
            raw_trades = ns["strategy"](df.copy(), unlocks.copy(), fear_greed_df.copy())
        else:
            raw_trades = ns["strategy"](df.copy(), unlocks.copy())

        if not isinstance(raw_trades, list):
            return {"error": "❌ strategy() must return a list of trade dicts",
                    "trades": [], "equity": [], "stats": {}}
        if not raw_trades:
            return {"error": "⚠️ strategy() returned 0 trades for this pair/range.",
                    "trades": [], "equity": [], "stats": {}}

        required = {"entry", "exit", "side", "entry_price", "exit_price"}
        trades: list = []
        for t in raw_trades:
            if not required.issubset(t): continue
            ep   = float(t["entry_price"]); xp = float(t["exit_price"])
            side = str(t["side"]).lower()
            ret  = ((ep - xp) / ep * 100) if side == "short" else ((xp - ep) / ep * 100)
            trades.append({
                "entry":       int(t["entry"]),
                "exit":        int(t["exit"]),
                "side":        side,
                "entry_price": round(ep, 6),
                "exit_price":  round(xp, 6),
                "return_pct":  round(ret, 4),
            })

        trades.sort(key=lambda x: x["entry"])

        equity = 100.0; equity_curve: list = []
        for t in trades:
            equity_curve.append({"time": t["entry"], "value": round(equity, 4)})
            equity *= (1 + t["return_pct"] / 100)
            equity_curve.append({"time": t["exit"],  "value": round(equity, 4)})

        returns = [t["return_pct"] for t in trades]
        wins    = [r for r in returns if r > 0]
        losses  = [r for r in returns if r <= 0]
        gross_profit = sum(wins); gross_loss = abs(sum(losses))
        peak, eq, max_dd = 100.0, 100.0, 0.0
        for t in trades:
            eq   *= (1 + t["return_pct"] / 100)
            peak  = max(peak, eq)
            max_dd = min(max_dd, (eq - peak) / peak * 100)

        stats = {
            "total_return":   round(equity - 100, 2),
            "win_rate":       round(len(wins) / len(trades) * 100, 1),
            "total_trades":   len(trades),
            "winning_trades": len(wins),
            "losing_trades":  len(losses),
            "max_drawdown":   round(max_dd, 2),
            "profit_factor":  round(gross_profit / gross_loss, 2) if gross_loss else 999.0,
            "avg_win":        round(sum(wins) / len(wins), 2) if wins else 0.0,
            "avg_loss":       round(sum(losses) / len(losses), 2) if losses else 0.0,
        }

        MAX_CANDLES = 400
        ohlcv_df = df[["time", "open", "high", "low", "close"]].copy()
        if len(ohlcv_df) > MAX_CANDLES:
            step = max(1, len(ohlcv_df) // MAX_CANDLES)
            ohlcv_df = ohlcv_df.iloc[::step]
        ohlcv_list = ohlcv_df.to_dict("records")

        return {"trades": trades, "equity": equity_curve, "stats": stats,
                "ohlcv": ohlcv_list, "error": None}

    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}\n\n{traceback.format_exc()}",
                "trades": [], "equity": [], "stats": {}}


@app.post("/api/backtest-multi")
def run_backtest_multi(req: MultiBacktestRequest):
    if not HAS_PANDAS: return {"error": "pandas not installed", "results": [], "aggregate": {}}
    if not req.script.strip(): return {"error": "Script is empty", "results": [], "aggregate": {}}
    if not req.pairs: return {"error": "No pairs specified", "results": [], "aggregate": {}}

    def run_one(pair: str):
        sub = BacktestRequest(pair=pair, interval=req.interval,
                              start=req.start, end=req.end, script=req.script)
        result = run_backtest(sub); result["pair"] = pair; return result

    workers = min(req.max_workers, len(req.pairs), 16)
    results = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(run_one, p): p for p in req.pairs}
        for fut in as_completed(futures): results.append(fut.result())

    results.sort(key=lambda r: r.get("stats", {}).get("total_return", -9999), reverse=True)
    good = [r for r in results if not r.get("error") and r.get("trades")]
    all_returns  = [t["return_pct"] for r in good for t in r["trades"]]
    all_per_pair = [r["stats"]["total_return"] for r in good]

    def sharpe(rets, risk_free=0.0):
        if len(rets) < 2: return 0.0
        mu = statistics.mean(rets) - risk_free; std = statistics.stdev(rets)
        return round(mu / std, 3) if std else 0.0

    wins = [r for r in all_returns if r > 0]; losses = [r for r in all_returns if r <= 0]
    gp = sum(wins); gl = abs(sum(losses))

    aggregate = {
        "pairs_run":              len(req.pairs),
        "pairs_with_trades":      len(good),
        "total_trades":           len(all_returns),
        "avg_return_per_trade":   round(statistics.mean(all_returns), 4) if all_returns else 0,
        "median_return_per_trade":round(statistics.median(all_returns), 4) if all_returns else 0,
        "win_rate":               round(len(wins) / len(all_returns) * 100, 1) if all_returns else 0,
        "profit_factor":          round(gp / gl, 2) if gl else 999.0,
        "sharpe_ratio":           sharpe(all_returns),
        "avg_pair_return":        round(statistics.mean(all_per_pair), 2) if all_per_pair else 0,
        "best_pair":              results[0]["pair"] if results else "",
        "best_pair_return":       results[0].get("stats", {}).get("total_return", 0) if results else 0,
    }
    return {"results": results, "aggregate": aggregate, "error": None}


# ══════════════════════════════════════════════════════════════════════════════
# ── STRATEGY LIBRARY ─────────────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════════════

class SaveStrategyRequest(BaseModel):
    name:        str
    description: str       = ""
    code:        str
    algo:        str       = ""
    params_text: str       = ""
    pair:        str       = ""
    interval:    int       = 1440
    stats:       dict      = {}
    tags:        List[str] = []


@app.get("/api/strategies")
def list_strategies():
    conn = db()
    rows = conn.execute("SELECT * FROM strategies ORDER BY updated_at DESC").fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        try:    d["stats"] = json.loads(d["stats"])
        except: d["stats"] = {}
        try:    d["tags"] = json.loads(d["tags"])
        except: d["tags"] = []
        result.append(d)
    return result


@app.post("/api/strategies")
def save_strategy(req: SaveStrategyRequest):
    sid = str(uuid.uuid4())
    now = int(time.time())
    conn = db()
    conn.execute("""
        INSERT INTO strategies
          (id, name, description, code, algo, params_text, pair, interval, stats, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (sid, req.name, req.description, req.code, req.algo, req.params_text,
          req.pair, req.interval, json.dumps(req.stats), json.dumps(req.tags), now, now))
    conn.commit(); conn.close()
    return {"id": sid, "created_at": now}


@app.get("/api/strategies/{sid}")
def get_strategy(sid: str):
    conn = db()
    row  = conn.execute("SELECT * FROM strategies WHERE id = ?", (sid,)).fetchone()
    conn.close()
    if not row: return {"error": "Not found"}
    d = dict(row)
    try:    d["stats"] = json.loads(d["stats"])
    except: d["stats"] = {}
    try:    d["tags"] = json.loads(d["tags"])
    except: d["tags"] = []
    return d


@app.put("/api/strategies/{sid}")
def update_strategy(sid: str, req: SaveStrategyRequest):
    now = int(time.time())
    conn = db()
    conn.execute("""
        UPDATE strategies
        SET name=?, description=?, code=?, algo=?, params_text=?,
            pair=?, interval=?, stats=?, tags=?, updated_at=?
        WHERE id=?
    """, (req.name, req.description, req.code, req.algo, req.params_text,
          req.pair, req.interval, json.dumps(req.stats), json.dumps(req.tags), now, sid))
    conn.commit(); conn.close()
    return {"updated": True}


@app.delete("/api/strategies/{sid}")
def delete_strategy(sid: str):
    conn = db()
    conn.execute("DELETE FROM strategies WHERE id = ?", (sid,))
    conn.commit(); conn.close()
    return {"deleted": True}


# ══════════════════════════════════════════════════════════════════════════════
# ── LIVE PRICE (CoinGecko) ────────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════════════

# CoinGecko ID mapping from Kraken pair
COINGECKO_IDS = {
    "ARBUSD":  "arbitrum",
    "OPUSD":   "optimism",
    "STRKUSD": "starknet",
    "ZKUSD":   "zksync",
    "BTCUSD":  "bitcoin",
    "ETHUSD":  "ethereum",
    "SOLUSD":  "solana",
}

# Simple in-memory price cache (TTL = 10 seconds)
_price_cache: dict = {}
_price_cache_ts: dict = {}
PRICE_CACHE_TTL = 10  # seconds


@app.get("/api/live-price/{pair}")
def live_price(pair: str):
    """Get real-time price for a pair via Kraken public ticker (no auth needed)."""
    pair = pair.upper()
    now  = time.time()

    # Check cache
    if pair in _price_cache and now - _price_cache_ts.get(pair, 0) < PRICE_CACHE_TTL:
        return _price_cache[pair]

    kraken_pair = KRAKEN_PAIR_MAP.get(pair, pair)

    if not HAS_REQUESTS:
        return {"error": "requests library not installed", "pair": pair}

    try:
        resp = http_req.get(
            f"{KRAKEN_BASE}/0/public/Ticker",
            params={"pair": kraken_pair},
            timeout=5
        )
        data = resp.json()
        if data.get("error") and data["error"]:
            return {"error": str(data["error"]), "pair": pair}

        result_data = data.get("result", {})
        if not result_data:
            return {"error": "No ticker data", "pair": pair}

        ticker = list(result_data.values())[0]
        price_data = {
            "pair":    pair,
            "bid":     float(ticker["b"][0]),
            "ask":     float(ticker["a"][0]),
            "last":    float(ticker["c"][0]),
            "high24":  float(ticker["h"][1]),
            "low24":   float(ticker["l"][1]),
            "volume24":float(ticker["v"][1]),
            "vwap24":  float(ticker["p"][1]),
            "trades24":int(ticker["t"][1]),
            "ts":      int(now),
        }
        _price_cache[pair]    = price_data
        _price_cache_ts[pair] = now
        return price_data

    except Exception as e:
        return {"error": str(e), "pair": pair}


@app.get("/api/live-prices")
def live_prices(pairs: str = "ARBUSD,OPUSD,STRKUSD,ZKUSD"):
    """Get live prices for multiple pairs at once."""
    pair_list = [p.strip().upper() for p in pairs.split(",")]
    results = {}
    for pair in pair_list:
        results[pair] = live_price(pair)
    return results


# ══════════════════════════════════════════════════════════════════════════════
# ── KRAKEN LIVE TRADING BOT ───────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════════════

_bot_lock = threading.Lock()
_bot: dict = {
    "running":        False,
    "strategy_id":    None,
    "strategy_name":  "",
    "strategy_code":  None,
    "pair":           None,
    "interval":       1440,
    "allocation":     10.0,
    "position":       None,   # None | "long" | "short"
    "position_qty":   0.0,
    "entry_price":    None,
    "entry_time":     None,
    "order_id":       None,
    "realized_pnl":   0.0,
    "logs":           [],
    "_thread":        None,
    "_stop_event":    threading.Event(),
    "started_at":     None,
    "last_tick":      None,
    "last_signal":    None,
}


def _bot_log(level: str, msg: str, meta: dict = None):
    entry = {"ts": int(time.time()), "level": level, "msg": msg, "meta": meta or {}}
    with _bot_lock:
        _bot["logs"].append(entry)
        if len(_bot["logs"]) > 300:
            _bot["logs"] = _bot["logs"][-300:]
    try:
        conn = db()
        conn.execute("INSERT INTO bot_log (ts, level, msg, meta) VALUES (?, ?, ?, ?)",
                     (entry["ts"], level, msg, json.dumps(meta or {})))
        conn.commit(); conn.close()
    except Exception:
        pass


def _kraken_sign(urlpath: str, data: dict, secret: str) -> str:
    postdata = urllib.parse.urlencode(data)
    encoded  = (str(data["nonce"]) + postdata).encode()
    message  = urlpath.encode() + hashlib.sha256(encoded).digest()
    mac      = hmac.new(base64.b64decode(secret), message, hashlib.sha512)
    return base64.b64encode(mac.digest()).decode()


def _kraken_private(endpoint: str, data: dict = None) -> dict:
    api_key    = os.environ.get("KRAKEN_API_KEY", "").strip()
    api_secret = os.environ.get("KRAKEN_API_SECRET", "").strip()
    if not api_key or not api_secret:
        return {"error": ["Kraken API keys not configured"]}
    if not HAS_REQUESTS:
        return {"error": ["requests library not installed"]}

    data = data or {}
    data["nonce"] = str(int(time.time() * 1000))
    urlpath   = f"/0/private/{endpoint}"
    signature = _kraken_sign(urlpath, data, api_secret)
    headers   = {
        "API-Key":      api_key,
        "API-Sign":     signature,
        "Content-Type": "application/x-www-form-urlencoded",
    }
    try:
        resp = http_req.post(f"{KRAKEN_BASE}{urlpath}", data=data, headers=headers, timeout=10)
        return resp.json()
    except Exception as e:
        return {"error": [str(e)]}


def _kraken_public(endpoint: str, params: dict = None) -> dict:
    if not HAS_REQUESTS:
        return {"error": ["requests library not installed"]}
    try:
        resp = http_req.get(f"{KRAKEN_BASE}/0/public/{endpoint}", params=params or {}, timeout=5)
        return resp.json()
    except Exception as e:
        return {"error": [str(e)]}


def _get_live_signal(code: str, pair: str, interval: int) -> Optional[str]:
    """Run strategy on latest data → return 'long', 'short', or 'flat'."""
    if not HAS_PANDAS:
        return None
    try:
        conn = db()
        rows = conn.execute(
            "SELECT ts AS time, open, high, low, close, volume, vwap, trades "
            "FROM ohlcvt WHERE pair=? AND interval=? ORDER BY ts DESC LIMIT 1000",
            (pair, interval)).fetchall()
        unlock_rows = conn.execute(
            "SELECT date AS time, daily_new_tokens, cumulative_tokens, "
            "has_cliff_event, cliff_event_tokens, inflation_pct_of_supply "
            "FROM token_unlocks WHERE pair=? ORDER BY date ASC", (pair,)).fetchall()
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
        # Check for any trade currently active
        for t in trades:
            e, x = t.get("entry", 0), t.get("exit", 0)
            if e <= now < x:
                return str(t.get("side", "flat")).lower()

        # If last trade's exit is still in the future, treat as active
        last = max(trades, key=lambda t: t.get("entry", 0))
        if last.get("exit", 0) > now:
            return str(last.get("side", "flat")).lower()

        return "flat"
    except Exception as e:
        _bot_log("error", f"Strategy signal error: {e}")
        return None


def _bot_runner():
    _bot_log("info", f"🤖 Bot started — {_bot['pair']} @ {_bot['interval']}min "
             f"| Allocation: ${_bot['allocation']:.2f}")

    sleep_secs = max(_bot["interval"] * 60, 60)  # at least 1-minute ticks

    while not _bot["_stop_event"].is_set():
        tick_start = time.time()
        try:
            _bot["last_tick"] = int(tick_start)
            signal = _get_live_signal(_bot["strategy_code"], _bot["pair"], _bot["interval"])

            if signal is None:
                _bot_log("warn", "Could not compute signal — skipping tick")
            else:
                _bot["last_signal"] = signal
                desired  = signal if signal in ("long", "short") else None
                current  = _bot["position"]
                kraken_p = KRAKEN_PAIR_MAP.get(_bot["pair"], _bot["pair"])

                _bot_log("info",
                         f"Tick — signal: {signal} | position: {current or 'flat'}",
                         {"pair": _bot["pair"], "signal": signal})

                if desired != current:
                    # ── Close existing position ──────────────────────────────
                    if current is not None and _bot["position_qty"] > 0:
                        close_type = "sell" if current == "long" else "buy"
                        _bot_log("info", f"Closing {current} ({_bot['position_qty']:.6f})")

                        close_resp = _kraken_private("AddOrder", {
                            "pair":      kraken_p,
                            "type":      close_type,
                            "ordertype": "market",
                            "volume":    f"{_bot['position_qty']:.6f}",
                        })
                        if close_resp.get("error") and close_resp["error"]:
                            _bot_log("error", f"Close error: {close_resp['error']}")
                        else:
                            # Estimate P&L from current mid
                            ticker = _kraken_public("Ticker", {"pair": kraken_p})
                            if not (ticker.get("error") and ticker["error"]):
                                td = list((ticker.get("result") or {}).values())
                                if td:
                                    cp = float(td[0]["c"][0])
                                    if current == "long":
                                        pnl = (_bot["position_qty"] * cp) - _bot["allocation"]
                                    else:
                                        pnl = _bot["allocation"] - (_bot["position_qty"] * cp)
                                    _bot["realized_pnl"] += pnl
                                    _bot_log("success", f"Closed @ ${cp:.4f} | P&L: ${pnl:.4f}")

                            _bot["position"]     = None
                            _bot["position_qty"] = 0.0
                            _bot["entry_price"]  = None

                    # ── Open new position ────────────────────────────────────
                    if desired is not None:
                        ticker = _kraken_public("Ticker", {"pair": kraken_p})
                        if ticker.get("error") and ticker["error"]:
                            _bot_log("error", f"Ticker error: {ticker['error']}")
                        else:
                            td = list((ticker.get("result") or {}).values())
                            if td:
                                ask = float(td[0]["a"][0])
                                bid = float(td[0]["b"][0])
                                price = ask if desired == "long" else bid
                                qty   = _bot["allocation"] / price

                                _bot_log("info",
                                         f"Opening {desired} — qty: {qty:.6f} @ ~${price:.4f}",
                                         {"side": desired, "qty": qty, "price": price})

                                order = _kraken_private("AddOrder", {
                                    "pair":      kraken_p,
                                    "type":      "buy" if desired == "long" else "sell",
                                    "ordertype": "market",
                                    "volume":    f"{qty:.6f}",
                                })
                                if order.get("error") and order["error"]:
                                    _bot_log("error", f"Open order error: {order['error']}")
                                else:
                                    txids = (order.get("result") or {}).get("txid", [])
                                    _bot["position"]     = desired
                                    _bot["position_qty"] = qty
                                    _bot["entry_price"]  = price
                                    _bot["entry_time"]   = int(time.time())
                                    _bot["order_id"]     = txids[0] if txids else None
                                    _bot_log("success",
                                             f"✅ {desired.upper()} opened @ ${price:.4f} "
                                             f"(txid: {_bot['order_id']})",
                                             {"side": desired, "price": price, "qty": qty})

        except Exception as exc:
            _bot_log("error", f"Bot tick exception: {exc}\n{traceback.format_exc()}")

        _bot["_stop_event"].wait(timeout=sleep_secs)

    _bot_log("info", "🛑 Bot stopped")


# ── Bot API endpoints ─────────────────────────────────────────────────────────

class BotStartRequest(BaseModel):
    strategy_id: Optional[str] = None
    code:        Optional[str] = None   # direct code (if not from library)
    pair:        str           = "ARBUSD"
    interval:    int           = 1440
    allocation:  float         = 10.0


@app.post("/api/bot/start")
def bot_start(req: BotStartRequest):
    global _bot
    with _bot_lock:
        if _bot["running"]:
            return {"error": "Bot is already running. Stop it first."}

    code = req.code or ""
    name = "Custom Strategy"

    if req.strategy_id:
        conn = db()
        row  = conn.execute("SELECT * FROM strategies WHERE id=?", (req.strategy_id,)).fetchone()
        conn.close()
        if not row:
            return {"error": f"Strategy {req.strategy_id} not found"}
        code = row["code"]
        name = row["name"]

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
        "started_at":    int(time.time()),
        "last_tick":     None,
        "last_signal":   None,
    })

    t = threading.Thread(target=_bot_runner, daemon=True)
    _bot["_thread"] = t
    t.start()

    return {"started": True, "pair": req.pair, "allocation": req.allocation}


@app.post("/api/bot/stop")
def bot_stop():
    with _bot_lock:
        if not _bot["running"]:
            return {"error": "Bot is not running"}
    _bot["_stop_event"].set()
    _bot["running"] = False
    return {"stopped": True}


@app.get("/api/bot/status")
def bot_status():
    with _bot_lock:
        s = dict(_bot)
    s.pop("_thread", None)
    s.pop("_stop_event", None)
    s.pop("strategy_code", None)  # don't send full code in status poll

    # Compute unrealized P&L if in a position
    unrealized_pnl = 0.0
    if s["position"] and s["entry_price"] and HAS_REQUESTS:
        ticker = live_price(s["pair"])
        if "last" in ticker:
            price = ticker["last"]
            if s["position"] == "long":
                unrealized_pnl = (price - s["entry_price"]) * s["position_qty"]
            else:
                unrealized_pnl = (s["entry_price"] - price) * s["position_qty"]

    s["unrealized_pnl"] = round(unrealized_pnl, 4)
    s["logs"] = list(reversed(s.get("logs", [])))[:50]  # newest first, max 50
    return s


@app.get("/api/bot/logs")
def bot_logs(limit: int = 100):
    with _bot_lock:
        logs = list(reversed(_bot.get("logs", [])))
    return logs[:limit]


# ── Kraken Account ───────────────────────────────────────────────────────────

@app.get("/api/kraken/balance")
def kraken_balance():
    resp = _kraken_private("Balance")
    if resp.get("error") and resp["error"]:
        return {"error": str(resp["error"])}
    balances = resp.get("result", {})
    # Filter out tiny/zero balances and format
    cleaned = {}
    for k, v in balances.items():
        val = float(v)
        if val > 0.000001:
            cleaned[k] = round(val, 8)
    return {"balances": cleaned, "raw": balances}


@app.get("/api/kraken/status")
def kraken_status():
    """Check if Kraken API keys are configured and valid."""
    api_key    = os.environ.get("KRAKEN_API_KEY", "").strip()
    api_secret = os.environ.get("KRAKEN_API_SECRET", "").strip()
    if not api_key or not api_secret:
        return {"connected": False, "error": "KRAKEN_API_KEY / KRAKEN_API_SECRET not set"}
    if not HAS_REQUESTS:
        return {"connected": False, "error": "requests library not installed"}
    resp = _kraken_private("Balance")
    if resp.get("error") and resp["error"]:
        return {"connected": False, "error": str(resp["error"])}
    return {"connected": True, "key_prefix": api_key[:8] + "…"}


# ══════════════════════════════════════════════════════════════════════════════
# ── GEMINI AI CHAT ────────────────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════════════

GEMINI_MODEL = "gemini-2.5-flash"

class ChatRequest(BaseModel):
    message:      str
    system:       str  = ""
    history:      list = []
    current_code: str  = ""   # code currently in editor (for iterative refinement)


def _extract_code_from_reply(reply: str) -> str:
    """Pull the Python code block out of an AI reply."""
    import re
    # Between [Python Code] and next section or end
    m = re.search(r'\[Python Code\]([\s\S]*?)(?=\[Parameters\]|$)', reply, re.IGNORECASE)
    raw = m.group(1).strip() if m else reply
    # Strip ```python ... ``` fences
    fence = re.search(r'```(?:python)?\n?([\s\S]*?)```', raw)
    if fence:
        return fence.group(1).strip()
    return raw.strip()


def _code_looks_complete(code: str) -> bool:
    """Return True if the code has a real strategy body, not just a skeleton."""
    if not code or 'def strategy' not in code:
        return False
    lines = [l.strip() for l in code.splitlines() if l.strip() and not l.strip().startswith('#')]
    # Must have at least 8 substantive lines (imports + real logic)
    if len(lines) < 8:
        return False
    # Must contain actual logic — not just the docstring + return
    body_lines = [l for l in lines if l not in ('trades = []', 'return trades', '"""') and
                  not l.startswith('def strategy') and not l.startswith('"""')]
    return len(body_lines) >= 4


@app.post("/api/chat")
def chat(req: ChatRequest):
    if not HAS_GEMINI:
        return {"error": "google-genai not installed. Run: pip3 install google-genai", "reply": ""}

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return {"error": "GEMINI_API_KEY not set", "reply":
                "⚠️ No Gemini API key found. Set: export GEMINI_API_KEY=your_key"}

    try:
        client = google_genai.Client(api_key=api_key)

        # Build system prompt — inject current code context if present
        code_ctx = ""
        if req.current_code and req.current_code.strip():
            code_ctx = (f"\n\nThe user currently has the following Python strategy loaded in the editor:"
                        f"\n```python\n{req.current_code.strip()}\n```"
                        f"\nWhen asked to modify, improve, or fix, ALWAYS return a COMPLETE updated version "
                        f"of the full function — never a partial snippet or skeleton.")

        system_prompt = (req.system or (
            "You are an expert quantitative trading strategy builder for a crypto backtesting platform.\n"
            "Always structure responses with three labelled sections:\n"
            "[Algorithm] — plain-English explanation (3-5 sentences)\n"
            "[Python Code] — complete def strategy(df, unlocks): ... returning list of trade dicts\n"
            "[Parameters] — key parameters with defaults and ranges"
        )) + code_ctx

        contents = []
        for h in req.history:
            if h.get("role") in ("user", "model") and h.get("text"):
                contents.append({"role": h["role"], "parts": [{"text": h["text"]}]})
        contents.append({"role": "user", "parts": [{"text": req.message}]})

        # Build config — try with thinking disabled (fast), fall back without it
        try:
            cfg = genai_types.GenerateContentConfig(
                system_instruction=system_prompt,
                temperature=0.2,
                thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
            )
        except Exception:
            cfg = genai_types.GenerateContentConfig(
                system_instruction=system_prompt,
                temperature=0.2,
            )

        response = client.models.generate_content(
            model=GEMINI_MODEL, contents=contents, config=cfg
        )
        reply = response.text or ""
        print(f"[CHAT] raw reply ({len(reply)} chars):\n{reply[:500]}\n---")

        # ── Auto-debug loop: if code looks like a skeleton, do one retry ──
        code = _extract_code_from_reply(reply)
        if not _code_looks_complete(code):
            print("[CHAT] code incomplete — retrying for full implementation")
            fix_prompt = (
                "The Python code you just gave me is incomplete — it only contains a skeleton or stub. "
                "Please write the FULL, COMPLETE implementation of the strategy() function with ALL the "
                "actual trading logic, indicator calculations, entry/exit conditions, and trade construction. "
                "Do NOT use '# ...' or '# your logic here' placeholders — write every single line of real code. "
                "The function must work correctly when executed as-is."
            )
            fix_contents = contents + [
                {"role": "model", "parts": [{"text": reply}]},
                {"role": "user",  "parts": [{"text": fix_prompt}]},
            ]
            fix_response = client.models.generate_content(
                model=GEMINI_MODEL, contents=fix_contents, config=cfg
            )
            reply = fix_response.text or reply  # keep original if retry also blank
            print(f"[CHAT] retry reply ({len(reply)} chars):\n{reply[:500]}\n---")

        return {"reply": reply, "error": None}

    except Exception as e:
        return {"reply": "", "error": str(e)}


# ── Vision Chat (image → strategy) ─────────────────────────────────────────

class VisionChatRequest(BaseModel):
    message:      str  = "Analyze this chart and create a trading strategy based on what you see."
    image_base64: str  = ""
    mime_type:    str  = "image/jpeg"
    system:       str  = ""
    current_code: str  = ""


@app.post("/api/chat-vision")
def chat_vision(req: VisionChatRequest):
    if not HAS_GEMINI:
        return {"error": "google-genai not installed", "reply": ""}

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return {"error": "GEMINI_API_KEY not set", "reply": ""}
    if not req.image_base64:
        return {"error": "No image provided", "reply": ""}

    try:
        client = google_genai.Client(api_key=api_key)

        code_ctx = ""
        if req.current_code and req.current_code.strip():
            code_ctx = f"\n\nCurrent editor code:\n```python\n{req.current_code.strip()}\n```"

        system_prompt = (req.system or (
            "You are an expert quantitative trading strategy builder. "
            "When a user shows you a chart, analyze the visible patterns — price action, "
            "indicators, trends, support/resistance, volume — and design a systematic trading "
            "strategy that captures the pattern you observe. "
            "Always structure responses with:\n"
            "[Algorithm] — plain-English explanation\n"
            "[Python Code] — complete def strategy(df, unlocks): ... returning list of trade dicts\n"
            "[Parameters] — tunable parameters"
        )) + code_ctx

        image_bytes = base64.b64decode(req.image_base64)

        part_image = genai_types.Part.from_bytes(data=image_bytes, mime_type=req.mime_type)
        part_text  = genai_types.Part.from_text(text=req.message)

        cfg = genai_types.GenerateContentConfig(
            system_instruction=system_prompt,
            temperature=0.2,
        )
        vision_contents = [genai_types.Content(role="user", parts=[part_image, part_text])]
        response = client.models.generate_content(
            model=GEMINI_MODEL, contents=vision_contents, config=cfg
        )

        # Auto-debug loop for vision too
        reply = response.text
        code = _extract_code_from_reply(reply)
        if not _code_looks_complete(code):
            fix_prompt = (
                "The Python code you generated is a skeleton/stub. Write the FULL implementation with "
                "all real trading logic, indicator calculations, and trade construction. No placeholders."
            )
            fix_contents = vision_contents + [
                {"role": "model", "parts": [{"text": reply}]},
                {"role": "user",  "parts": [{"text": fix_prompt}]},
            ]
            response = client.models.generate_content(
                model=GEMINI_MODEL, contents=fix_contents, config=cfg
            )
            reply = response.text
        return {"reply": reply, "error": None}

    except Exception as e:
        return {"reply": "", "error": str(e)}


# ── Serve frontend ────────────────────────────────────────────────────────────
if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")

if __name__ == "__main__":
    print("\n" + "=" * 55)
    print("  ⚡ Strategy Lab v2  →  http://localhost:8000")
    print("=" * 55 + "\n")
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True,
                app_dir=str(Path(__file__).parent))

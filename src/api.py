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

try:
    from data_sources import (
        BinanceConnector, OKXConnector, BybitConnector,
        CoinbaseConnector, HyperliquidConnector, DYDXConnector,
        CoinGeckoConnector, CoinMarketCapConnector, CoinglassConnector,
        MessariConnector, DefiLlamaConnector
    )
    HAS_DS = True
except ImportError as _ds_err:
    HAS_DS = False
    print(f"[WARN] data_sources not loaded: {_ds_err}")

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

# ── Runtime API key store (set via UI, takes priority over env vars) ──────────
_runtime_keys: dict = {"api_key": "", "api_secret": ""}

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
# ── DATA SOURCES API ──────────────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════════════

# Exchange metadata
_EXCHANGE_META = {
    'kraken':      {'name': 'Kraken',      'icon': 'K', 'color': '#5741d9', 'pairs_hint': 'BTC/USD, ETH/USD…',  'key_required': False, 'description': 'OHLCVT · 300+ pairs · data from 2018'},
    'binance':     {'name': 'Binance',     'icon': 'B', 'color': '#f0b90b', 'pairs_hint': 'BTCUSDT…',          'key_required': False, 'description': 'OHLCVT · 2000+ pairs · global leader'},
    'okx':         {'name': 'OKX',         'icon': 'O', 'color': '#1a56db', 'pairs_hint': 'BTC-USDT…',         'key_required': False, 'description': 'OHLCVT · funding rates · 500+ pairs'},
    'bybit':       {'name': 'Bybit',       'icon': 'By', 'color': '#f7a600', 'pairs_hint': 'BTCUSDT…',          'key_required': False, 'description': 'OHLCVT · perpetuals · 400+ pairs'},
    'coinbase':    {'name': 'Coinbase',    'icon': 'C', 'color': '#0052ff', 'pairs_hint': 'BTC-USD…',           'key_required': False, 'description': 'OHLCVT · US regulated · 200+ pairs'},
    'hyperliquid': {'name': 'Hyperliquid', 'icon': 'H', 'color': '#4ade80', 'pairs_hint': 'BTC, ETH…',          'key_required': False, 'description': 'OHLCVT · DEX perps · funding data'},
    'dydx':        {'name': 'dYdX',        'icon': 'D', 'color': '#6c7c99', 'pairs_hint': 'BTC-USD…',           'key_required': False, 'description': 'OHLCVT · v4 DEX · perpetuals'},
}

_SUPPLEMENTARY_META = {
    'coingecko':     {'name': 'CoinGecko',     'icon': 'CG', 'color': '#8dc63f', 'key_env': 'COINGECKO_API_KEY',   'key_required': False,  'description': 'Price · market cap · dominance · OHLCV (90-day free)'},
    'coinmarketcap': {'name': 'CoinMarketCap', 'icon': 'CM', 'color': '#16c784', 'key_env': 'CMC_API_KEY',         'key_required': True,   'description': 'Prices · rankings · market cap · 333 req/day free'},
    'coinglass':     {'name': 'Coinglass',     'icon': 'GL', 'color': '#e64484', 'key_env': 'COINGLASS_API_KEY',  'key_required': True,   'description': 'Funding rates · OI · liquidations · L/S ratio'},
    'messari':       {'name': 'Messari',       'icon': 'MS', 'color': '#0f62fe', 'key_env': 'MESSARI_API_KEY',    'key_required': True,   'description': 'On-chain metrics · asset profiles · timeseries'},
    'defillama':     {'name': 'DefiLlama',     'icon': 'DL', 'color': '#2172e5', 'key_env': None,                 'key_required': False,  'description': 'TVL · yields · stablecoins · token unlocks'},
    'feargreed':     {'name': 'Fear & Greed',  'icon': 'FG', 'color': '#f87171', 'key_env': None,                 'key_required': False,  'description': 'Daily sentiment index · local DB cached'},
}

_EXCHANGE_CONNECTORS_MAP = {
    'binance': BinanceConnector if HAS_DS else None,
    'okx':     OKXConnector     if HAS_DS else None,
    'bybit':   BybitConnector   if HAS_DS else None,
    'coinbase':CoinbaseConnector if HAS_DS else None,
    'hyperliquid': HyperliquidConnector if HAS_DS else None,
    'dydx':    DYDXConnector    if HAS_DS else None,
}

_SUPP_CONNECTORS_MAP = {
    'coingecko':     CoinGeckoConnector     if HAS_DS else None,
    'coinmarketcap': CoinMarketCapConnector if HAS_DS else None,
    'coinglass':     CoinglassConnector     if HAS_DS else None,
    'messari':       MessariConnector       if HAS_DS else None,
    'defillama':     DefiLlamaConnector     if HAS_DS else None,
}

# ── Pairs cache (populated lazily, TTL=10 min) ────────────────────────────────
_pairs_cache: dict = {}
_pairs_cache_ts: dict = {}
_PAIRS_CACHE_TTL = 600  # seconds

# ── Data-type registry per source ────────────────────────────────────────────
# For exchanges the type is always OHLCVT; supplementary sources expose named methods
_SUPP_DATA_TYPES: dict = {
    'coingecko':     ['Market Data (top coins)', 'Price Chart (Bitcoin)', 'Global Stats'],
    'coinmarketcap': ['Latest Quotes (top coins)', 'Global Metrics'],
    'coinglass':     ['Funding Rates', 'Open Interest', 'Liquidations', 'Long/Short Ratio'],
    'messari':       ['Asset Metrics', 'Price Timeseries'],
    'defillama':     ['Protocol TVL', 'Chain TVL', 'Yield Pools', 'Stablecoins'],
    'feargreed':     ['Index History'],
}

@app.get("/api/exchanges")
def api_exchanges():
    """Return all exchange connectors with live ping status."""
    results = []
    for ex_id, meta in _EXCHANGE_META.items():
        if ex_id == 'kraken':
            # Kraken is always available (local DB)
            online = True
        else:
            conn_cls = _EXCHANGE_CONNECTORS_MAP.get(ex_id)
            try:
                online = bool(conn_cls and conn_cls.ping())
            except Exception:
                online = False
        results.append({**meta, 'id': ex_id, 'online': online})
    return {'exchanges': results}


@app.get("/api/data-sources")
def api_data_sources():
    """Return supplementary data source status."""
    results = []
    for src_id, meta in _SUPPLEMENTARY_META.items():
        if src_id == 'feargreed':
            # Check local DB
            try:
                conn = db()
                n = conn.execute("SELECT COUNT(*) FROM fear_greed").fetchone()[0]
                conn.close()
                online = n > 0
            except Exception:
                online = False
        else:
            conn_cls = _SUPP_CONNECTORS_MAP.get(src_id)
            key_env  = meta.get('key_env')
            has_key  = bool(key_env and os.environ.get(key_env, ''))
            try:
                online = bool(conn_cls and conn_cls.ping())
            except Exception:
                online = False
        results.append({**meta, 'id': src_id, 'online': online,
                        'has_key': bool(os.environ.get(meta.get('key_env') or '', ''))})
    return {'sources': results}


@app.get("/api/data-sources/pairs/{exchange_id}")
def api_exchange_pairs(exchange_id: str):
    """Return available pairs for an exchange (cached / fast)."""
    if exchange_id == 'kraken':
        try:
            conn = db()
            pairs = [r[0] for r in conn.execute(
                "SELECT DISTINCT pair FROM ohlcv ORDER BY pair").fetchall()]
            conn.close()
            return {'pairs': pairs}
        except Exception:
            return {'pairs': list(KRAKEN_PAIR_MAP.keys())}
    conn_cls = _EXCHANGE_CONNECTORS_MAP.get(exchange_id)
    if not conn_cls:
        return {'pairs': [], 'error': f'Unknown exchange: {exchange_id}'}
    try:
        pairs = conn_cls.fetch_pairs()
        return {'pairs': sorted(pairs)[:2000]}
    except Exception as e:
        return {'pairs': [], 'error': str(e)}


class SaveApiKeyRequest(BaseModel):
    key_name: str   # e.g. 'COINGECKO_API_KEY'
    key_value: str

@app.post("/api/save-api-key")
def api_save_api_key(req: SaveApiKeyRequest):
    """Persist an API key to .env and hot-reload it into os.environ."""
    allowed = {'COINGECKO_API_KEY', 'CMC_API_KEY', 'COINGLASS_API_KEY',
               'MESSARI_API_KEY', 'GEMINI_API_KEY'}
    if req.key_name not in allowed:
        return {'error': f'Key name not allowed: {req.key_name}'}
    env_path = BASE_DIR / '.env'
    # Read existing
    lines: list[str] = []
    if env_path.exists():
        lines = env_path.read_text().splitlines()
    # Update or append
    found = False
    for i, line in enumerate(lines):
        if line.startswith(f'{req.key_name}='):
            lines[i] = f'{req.key_name}={req.key_value}'
            found = True
            break
    if not found:
        lines.append(f'{req.key_name}={req.key_value}')
    env_path.write_text('\n'.join(lines) + '\n')
    # Hot-reload
    os.environ[req.key_name] = req.key_value
    return {'ok': True, 'message': f'{req.key_name} saved and applied.'}



# ── Data preview endpoint ──────────────────────────────────────────────────────
_EXCHANGE_DEFAULT_PAIRS = {
    'binance':     'BTCUSDT',
    'okx':         'BTC-USDT',
    'bybit':       'BTCUSDT',
    'coinbase':    'BTC-USD',
    'hyperliquid': 'BTC',
    'dydx':        'BTC-USD',
    'kraken':      'BTCUSD',
}


@app.get("/api/data-sources/pairs/{source_id}")
def api_ds_pairs(source_id: str, q: str = ""):
    """Return pairs for a source, filtered by query string (for autocomplete)."""
    sid = source_id.lower()
    q_upper = q.strip().upper()
    import time as _t

    # Kraken — query local DB
    if sid == 'kraken':
        conn = db()
        if q_upper:
            rows = conn.execute(
                "SELECT DISTINCT pair FROM ohlcvt WHERE pair LIKE ? ORDER BY pair LIMIT 40",
                (q_upper + '%',)
            ).fetchall()
            if not rows:  # also try substring
                rows = conn.execute(
                    "SELECT DISTINCT pair FROM ohlcvt WHERE pair LIKE ? ORDER BY pair LIMIT 40",
                    ('%' + q_upper + '%',)
                ).fetchall()
        else:
            rows = conn.execute(
                "SELECT DISTINCT pair FROM ohlcvt ORDER BY pair LIMIT 40"
            ).fetchall()
        conn.close()
        return {"pairs": [r[0] for r in rows]}

    # Other exchanges — fetch & cache pair list
    if sid in _EXCHANGE_CONNECTORS_MAP:
        connector = _EXCHANGE_CONNECTORS_MAP.get(sid)
        if not connector:
            return {"pairs": []}
        cache_key = f"pairs_{sid}"
        now = _t.time()
        if cache_key not in _pairs_cache or (now - _pairs_cache_ts.get(cache_key, 0)) > _PAIRS_CACHE_TTL:
            try:
                _pairs_cache[cache_key] = connector.fetch_pairs()
                _pairs_cache_ts[cache_key] = now
            except Exception:
                return {"pairs": []}
        all_pairs: list = _pairs_cache.get(cache_key, [])
        if q_upper:
            filtered = [p for p in all_pairs if q_upper in p.upper()][:40]
        else:
            filtered = all_pairs[:40]
        return {"pairs": filtered}

    # Supplementary — entity search (protocol, chain, coin, symbol…)
    q_lower = q.strip().lower()
    dt = ""  # data_type not available here but we handle it in preview

    if sid == 'defillama':
        import requests as _req
        # Determine entity type from query context — always show protocols by default
        # (the data_type routing happens in preview; here we just search protocols + chains)
        # We expose two lists: chains (fast, hardcoded) and protocols (cached from API)
        CHAINS = ['Ethereum','BSC','Arbitrum','Polygon','Avalanche','Solana','Optimism',
                  'Base','Fantom','Cronos','Near','Harmony','Celo','zkSync Era','Linea',
                  'Scroll','Starknet','Manta','Blast','Mantle']
        # Check if query matches chains better (short, uppercase-ish)
        chain_matches = [c for c in CHAINS if not q_lower or q_lower in c.lower()]

        # Try protocol cache — fetch in background thread so first call never blocks
        proto_key = 'defillama_protocols'
        now = _t.time()
        if proto_key not in _pairs_cache:
            # First call: kick off background fetch, return chains for now
            import threading as _thr
            def _load_protocols():
                try:
                    import requests as _rq2
                    r2 = _rq2.get('https://api.llama.fi/protocols', timeout=15)
                    raw = r2.json()
                    _pairs_cache[proto_key] = [(p.get('slug',''), p.get('name','')) for p in raw if p.get('slug') and p.get('name')]
                    _pairs_cache_ts[proto_key] = _t.time()
                except Exception:
                    _pairs_cache[proto_key] = []   # cache empty so next call retries
            _thr.Thread(target=_load_protocols, daemon=True).start()
        elif (now - _pairs_cache_ts.get(proto_key, 0)) > 300:
            # Stale cache: refresh in background, serve stale data now
            import threading as _thr
            def _refresh_protocols():
                try:
                    import requests as _rq2
                    r2 = _rq2.get('https://api.llama.fi/protocols', timeout=15)
                    raw = r2.json()
                    _pairs_cache[proto_key] = [(p.get('slug',''), p.get('name','')) for p in raw if p.get('slug') and p.get('name')]
                    _pairs_cache_ts[proto_key] = _t.time()
                except Exception:
                    pass
            _thr.Thread(target=_refresh_protocols, daemon=True).start()

        protocol_list = _pairs_cache.get(proto_key, [])
        proto_matches = [(slug, name) for slug, name in protocol_list
                         if not q_lower or q_lower in name.lower() or q_lower in slug.lower()][:30]

        # Combine: chains first, then protocols
        labels: dict = {}
        pairs: list = []
        if not q_lower or any(q_lower in c.lower() for c in CHAINS):
            for c in chain_matches[:8]:
                pairs.append(f"chain::{c}")
                labels[f"chain::{c}"] = f"🔗 {c} (Chain TVL)"
        for slug, name in proto_matches[:25]:
            pairs.append(slug)
            labels[slug] = name
        if not pairs and not protocol_list:
            # Cache not ready yet — return note so frontend can retry
            return {"pairs": [], "labels": {}, "note": "Loading protocol list — try typing again in a moment"}
        return {"pairs": pairs, "labels": labels}

    if sid == 'coingecko':
        import requests as _req
        if not q_lower:
            POPULAR = ['bitcoin','ethereum','solana','binancecoin','ripple','cardano',
                       'avalanche-2','dogecoin','polkadot','matic-network','chainlink',
                       'uniswap','litecoin','algorand','stellar']
            return {"pairs": POPULAR, "labels": {
                'bitcoin':'Bitcoin (BTC)', 'ethereum':'Ethereum (ETH)',
                'solana':'Solana (SOL)', 'binancecoin':'BNB', 'ripple':'XRP',
                'cardano':'Cardano (ADA)', 'avalanche-2':'Avalanche (AVAX)',
                'dogecoin':'Dogecoin (DOGE)', 'polkadot':'Polkadot (DOT)',
                'matic-network':'Polygon (MATIC)', 'chainlink':'Chainlink (LINK)',
                'uniswap':'Uniswap (UNI)', 'litecoin':'Litecoin (LTC)',
            }}
        try:
            r = _req.get(f'https://api.coingecko.com/api/v3/search?query={q_lower}', timeout=4)
            coins = r.json().get('coins', [])[:20]
            pairs = [c['id'] for c in coins]
            labels = {c['id']: f"{c['name']} ({c['symbol'].upper()})" for c in coins}
            return {"pairs": pairs, "labels": labels}
        except Exception:
            return {"pairs": [], "labels": {}}

    if sid in ('coinglass', 'coinmarketcap'):
        SYMBOLS = ['BTC','ETH','SOL','BNB','XRP','ADA','AVAX','DOGE','DOT','MATIC',
                   'LINK','LTC','ATOM','NEAR','FTM','ALGO','SAND','AXS','XLM','ICP',
                   'THETA','EOS','CAKE','AAVE','UNI','SUSHI','CRV','SNX','MKR','COMP',
                   'SUI','APT','ARB','OP','INJ','SEI','TIA','PYTH','JUP','STRK']
        filtered = [s for s in SYMBOLS if not q_upper or q_upper in s][:30]
        return {"pairs": filtered, "labels": {}}

    if sid == 'messari':
        ASSETS = [('bitcoin','Bitcoin (BTC)'),('ethereum','Ethereum (ETH)'),
                  ('solana','Solana (SOL)'),('cardano','Cardano (ADA)'),
                  ('polkadot','Polkadot (DOT)'),('avalanche','Avalanche (AVAX)'),
                  ('chainlink','Chainlink (LINK)'),('uniswap','Uniswap (UNI)'),
                  ('aave','Aave (AAVE)'),('compound','Compound (COMP)'),
                  ('maker','Maker (MKR)'),('curve-dao-token','Curve (CRV)')]
        filtered = [(slug, lbl) for slug, lbl in ASSETS
                    if not q_lower or q_lower in slug or q_lower in lbl.lower()][:20]
        return {"pairs": [s for s,_ in filtered],
                "labels": {s: l for s,l in filtered}}

    if sid == 'feargreed':
        return {"pairs": [], "labels": {}}

    return {"pairs": [], "labels": {}}


@app.get("/api/data-sources/data-types/{source_id}")
def api_ds_data_types(source_id: str):
    """Return available data types for an exchange or supplementary source."""
    sid = source_id.lower()
    if sid in _EXCHANGE_CONNECTORS_MAP or sid == 'kraken':
        return {"data_types": ["OHLCVT (candlestick)"]}
    types = _SUPP_DATA_TYPES.get(sid, [])
    return {"data_types": types}


@app.get("/api/data-sources/preview/{source_id}")
def api_ds_preview(source_id: str, pair: str = "", data_type: str = ""):
    """Return a data sample. pair and data_type are optional query params
    sent by the investigate modal after the user selects them."""
    import datetime as _dt
    sid = source_id.lower()

    # ── Exchange OHLCV preview ────────────────────────────────────────────────
    if sid in _EXCHANGE_CONNECTORS_MAP or sid == 'kraken':
        try:
            end_dt   = _dt.datetime.utcnow()
            start_dt = end_dt - _dt.timedelta(days=30)

            if sid == 'kraken':
                conn = db()
                # Pick a well-known pair if present, else the first available
                prefer = ['BTCUSD','ETHUSD','ADAUSD','SOLUSD','STRKUSD']
                # If user supplied a specific pair, use it directly
                if pair:
                    pair_row = pair.upper()
                else:
                    pair_row = None
                    for p in prefer:
                        r = conn.execute("SELECT pair FROM ohlcvt WHERE pair=? LIMIT 1", (p,)).fetchone()
                        if r: pair_row = p; break
                    if not pair_row:
                        r = conn.execute("SELECT pair FROM ohlcvt LIMIT 1").fetchone()
                        pair_row = r[0] if r else 'BTCUSD'
                rows = conn.execute(
                    "SELECT ts AS time, open, high, low, close, volume, vwap, trades "
                    "FROM ohlcvt WHERE pair=? AND interval=1440 "
                    "ORDER BY ts DESC LIMIT 15", (pair_row,)
                ).fetchall()
                conn.close()
                if not rows:
                    return {"columns": [], "rows": [], "note": f"No Kraken daily data cached for {pair_row}."}
                cols = ["time (UTC)", "open", "high", "low", "close", "volume", "vwap", "trades"]
                data_rows = []
                for r in reversed(rows):
                    d = dict(r)
                    d["time (UTC)"] = _dt.datetime.utcfromtimestamp(d.pop("time")).strftime('%Y-%m-%d')
                    data_rows.append([str(d.get(c, "") or "") for c in cols])
                return {"columns": cols, "rows": data_rows, "source": "Kraken Local DB", "pair": pair_row}

            connector = _EXCHANGE_CONNECTORS_MAP.get(sid)
            if not connector:
                return {"error": f"No connector for {sid}", "columns": [], "rows": []}
            pair_sym = (pair.strip().upper() if pair else None) or _EXCHANGE_DEFAULT_PAIRS.get(sid, 'BTCUSDT')
            end_ts   = int(end_dt.timestamp())
            start_ts = int(start_dt.timestamp())
            df = connector.fetch_ohlcv(symbol=pair_sym, interval_minutes=1440,
                                       start_ts=start_ts, end_ts=end_ts)
            if df is None or df.empty:
                return {"columns": [], "rows": [], "note": f"No data returned for {pair}."}
            # Keep last 15 rows
            df = df.tail(15).copy()
            # Rename ts→time if needed
            if "ts" in df.columns:
                df = df.rename(columns={"ts": "time"})
            # Convert unix timestamps to readable dates
            if "time" in df.columns:
                df["time (UTC)"] = df["time"].apply(
                    lambda t: _dt.datetime.utcfromtimestamp(int(t)).strftime('%Y-%m-%d') if t else ""
                )
                df = df.drop(columns=["time"])
                # Move time column to front
                cols_order = ["time (UTC)"] + [c for c in df.columns if c != "time (UTC)"]
                df = df[cols_order]
            # Round floats
            df = df.round(6)
            cols = list(df.columns)
            rows = df.fillna("").values.tolist()
            rows = [[str(v) if v != "" else "" for v in row] for row in rows]
            return {"columns": cols, "rows": rows, "source": sid.title(), "pair": pair}

        except Exception as e:
            return {"error": str(e), "columns": [], "rows": []}

    # ── Supplementary source preview ──────────────────────────────────────────
    # feargreed and defillama are handled ad-hoc below (no connector class)
    _DIRECT_SUPP = {'feargreed', 'defillama'}
    connector = _SUPP_CONNECTORS_MAP.get(sid)
    if not connector and sid not in _DIRECT_SUPP:
        return {"error": f"Unknown source: {sid}", "columns": [], "rows": []}

    try:
        # Fear & Greed — pull from local DB
        if sid == 'feargreed':
            conn = db()
            rows = conn.execute(
                "SELECT date AS 'date', value, classification FROM fear_greed ORDER BY date DESC LIMIT 15"
            ).fetchall()
            conn.close()
            if not rows:
                return {"columns": [], "rows": [], "note": "No Fear & Greed data cached."}
            cols = ["date", "value", "classification"]
            return {"columns": cols, "rows": [[dict(r).get(c,"") for c in cols] for r in reversed(rows)],
                    "source": "Fear & Greed Index"}

        # DefiLlama — entity-aware preview
        if sid == 'defillama':
            import requests as _req, datetime as _dt2
            dt = data_type.lower() if data_type else ''
            entity = pair.strip() if pair else ''
            try:
                # ── chain::ChainName ──────────────────────────────────────────
                if entity.startswith('chain::') or 'chain tvl' in dt:
                    chain_name = entity.replace('chain::', '') if entity.startswith('chain::') else (entity or 'Ethereum')
                    r = _req.get(f'https://api.llama.fi/v2/historicalChainTvl/{chain_name}', timeout=12)
                    if r.ok:
                        points = r.json()[-30:]
                        cols = ["date", "tvl_usd"]
                        rows = [[_dt2.datetime.utcfromtimestamp(int(p['date'])).strftime('%Y-%m-%d'),
                                 str(round(p['tvl'], 2))] for p in points]
                        return {"columns": cols, "rows": rows, "source": f"DefiLlama · {chain_name} Chain TVL", "pair": chain_name}
                    return {"columns": [], "rows": [], "note": f"No TVL data for chain '{chain_name}'."}

                # ── Protocol slug → historical TVL ────────────────────────────
                if entity and 'stable' not in dt and 'yield' not in dt:
                    r = _req.get(f'https://api.llama.fi/protocol/{entity}', timeout=12)
                    if r.ok:
                        data_json = r.json()
                        tvl_series = data_json.get('tvl', [])[-30:]
                        if tvl_series:
                            cols = ["date", "tvl_usd"]
                            rows = [[_dt2.datetime.utcfromtimestamp(int(p['date'])).strftime('%Y-%m-%d'),
                                     str(round(p.get('totalLiquidityUSD', 0), 2))] for p in tvl_series]
                            return {"columns": cols, "rows": rows,
                                    "source": f"DefiLlama · {data_json.get('name', entity)} TVL", "pair": entity}

                # ── Yield pools (optionally filtered by protocol) ─────────────
                if 'yield' in dt:
                    dll = DefiLlamaConnector if HAS_DS else None
                    if dll:
                        df = dll.fetch_yields()
                        if df is not None and not df.empty:
                            if entity:
                                mask = df['protocol'].str.lower().str.contains(entity.lower(), na=False)
                                df = df[mask]
                            keep = ["protocol","chain","symbol","apy","tvl_usd","apy_base","apy_reward"]
                            df = df[[c for c in keep if c in df.columns]].head(30).round(4)
                            return {"columns": list(df.columns), "rows": df.fillna("").values.tolist(),
                                    "source": f"DefiLlama Yield Pools{f' · {entity}' if entity else ''}"}
                    return {"columns": [], "rows": [], "note": "No yield data."}

                # ── Stablecoins (optionally filtered by symbol/name) ──────────
                if 'stable' in dt:
                    dll = DefiLlamaConnector if HAS_DS else None
                    items = dll.fetch_stablecoins() if dll else []
                    if entity:
                        items = [s for s in items if entity.lower() in (s.get('symbol','') or '').lower()
                                 or entity.lower() in (s.get('name','') or '').lower()] or items
                    cols = ["name","symbol","pegType","pegMechanism","circulating","price"]
                    rows = []
                    for s in items[:15]:
                        circ = s.get("circulating", {})
                        if isinstance(circ, dict): circ = circ.get("peggedUSD", "")
                        rows.append([str(s.get("name","")), str(s.get("symbol","")),
                                     str(s.get("pegType","")), str(s.get("pegMechanism","")),
                                     str(round(float(circ), 2) if circ else ""), str(s.get("price",""))])
                    return {"columns": cols, "rows": rows, "source": "DefiLlama Stablecoins"}

                # ── Default: top protocols by TVL ─────────────────────────────
                r = _req.get("https://api.llama.fi/protocols", timeout=10)
                protocols = r.json()[:20] if r.ok else []
                if entity:
                    protocols = [p for p in protocols if entity.lower() in p.get('name','').lower()][:15] or protocols[:15]
                cols = ["name","chain","category","tvl","change_1d","change_7d"]
                rows = [[str(p.get("name","")), str(p.get("chain","")), str(p.get("category","")),
                         str(round(p.get("tvl",0),2)), str(p.get("change_1d","")), str(p.get("change_7d",""))]
                        for p in protocols[:15]]
                return {"columns": cols, "rows": rows, "source": "DefiLlama Protocol TVL"}

            except Exception as e:
                return {"error": f"DefiLlama error: {e}", "columns": [], "rows": []}

        # CoinGecko — route by data_type
        if sid == 'coingecko':
            dt = data_type.lower() if data_type else ''
            try:
                import requests as _req
                if 'global' in dt:
                    result = CoinGeckoConnector.fetch_global() if HAS_DS else {}
                    if result and not result.get('error'):
                        cols = list(result.keys())
                        rows = [[str(round(v, 4) if isinstance(v, float) else (v or '')) for v in result.values()]]
                        return {"columns": cols, "rows": rows, "source": "CoinGecko Global"}
                elif 'chart' in dt:
                    df = CoinGeckoConnector.fetch_market_chart('bitcoin', days=15) if HAS_DS else None
                    if df is not None and not df.empty:
                        import datetime as _dt2
                        df2 = df.tail(15).copy()
                        if "time" in df2.columns:
                            df2["date"] = df2["time"].apply(lambda t: _dt2.datetime.utcfromtimestamp(int(t)).strftime('%Y-%m-%d'))
                            df2 = df2.drop(columns=["time"])
                        df2 = df2.round(2)
                        return {"columns": list(df2.columns), "rows": df2.fillna("").values.tolist(), "source": "CoinGecko BTC Chart"}
                # Default: market data
                r = _req.get(
                    'https://api.coingecko.com/api/v3/coins/markets',
                    params={'vs_currency':'usd','order':'market_cap_desc','per_page':15,'page':1,'sparkline':False},
                    timeout=10
                )
                items = r.json() if r.ok else []
                if items and isinstance(items, list):
                    keep = ["name","symbol","current_price","market_cap","total_volume","price_change_percentage_24h"]
                    rows = [[str(round(item.get(c,0),4) if isinstance(item.get(c),float) else (item.get(c) or '')) for c in keep] for item in items]
                    return {"columns": keep, "rows": rows, "source": "CoinGecko Markets"}
            except Exception as eg:
                return {"columns": [], "rows": [], "note": f"CoinGecko error: {eg}"}
            return {"columns": [], "rows": [], "note": "CoinGecko returned no data."}

        # CoinMarketCap
        if sid == 'coinmarketcap':
            try:
                result = connector.fetch_latest_quotes(['BTC','ETH','SOL','BNB','XRP','ADA','AVAX','DOGE','DOT','MATIC'])
                if result and not result.get('error'):
                    cols = ["symbol","price_usd","market_cap_usd","volume_24h_usd","price_change_24h","rank"]
                    rows = [[str(sym)] + [str(round(d.get(c[:-4] if c.endswith('_usd') else c,0) or 0, 4)) for c in cols[1:]] for sym, d in result.items()]
                    return {"columns": cols, "rows": rows, "source": "CoinMarketCap"}
            except Exception:
                pass
            return {"columns": [], "rows": [], "note": "CMC returned no data (API key may be required)."}

        # Coinglass — route by data_type
        if sid == 'coinglass':
            dt = data_type.lower() if data_type else ''
            try:
                if 'open' in dt:
                    result = connector.fetch_open_interest('BTC')
                    if result:
                        cols = list(result.keys())[:10]
                        rows = [[str(result.get(c, '')) for c in cols]]
                        return {"columns": cols, "rows": rows, "source": "Coinglass Open Interest (BTC)"}
                elif 'liquid' in dt:
                    df = connector.fetch_liquidations('BTC')
                    if df is not None and not df.empty:
                        df = df.tail(15).round(2)
                        return {"columns": list(df.columns), "rows": df.fillna("").values.tolist(), "source": "Coinglass Liquidations (BTC)"}
                elif 'long' in dt or 'short' in dt:
                    df = connector.fetch_long_short_ratio('BTC')
                    if df is not None and not df.empty:
                        df = df.tail(15).round(4)
                        return {"columns": list(df.columns), "rows": df.fillna("").values.tolist(), "source": "Coinglass L/S Ratio (BTC)"}
                else:
                    df = connector.fetch_funding_rates('BTC')
                    if df is not None and not df.empty:
                        df = df.tail(15).round(6)
                        return {"columns": list(df.columns), "rows": df.fillna("").values.tolist(), "source": "Coinglass Funding Rates (BTC)"}
            except Exception as e:
                return {"error": f"Coinglass error: {e}", "columns": [], "rows": []}
            return {"columns": [], "rows": [], "note": "Coinglass returned no data (API key may be required)."}

        # Messari — route by data_type
        if sid == 'messari':
            dt = data_type.lower() if data_type else ''
            try:
                if 'time' in dt or 'series' in dt:
                    df = connector.fetch_timeseries('bitcoin', 'price-usd', days=15)
                    if df is not None and not df.empty:
                        import datetime as _dt2
                        df2 = df.tail(15).copy()
                        if "time" in df2.columns:
                            df2["date"] = df2["time"].apply(lambda t: _dt2.datetime.utcfromtimestamp(int(t)).strftime('%Y-%m-%d'))
                            df2 = df2.drop(columns=["time"])
                        return {"columns": list(df2.columns), "rows": df2.fillna("").values.tolist(), "source": "Messari BTC Price"}
                else:
                    result = connector.fetch_asset_metrics('bitcoin')
                    if result and not result.get('error'):
                        cols = [k for k in result.keys()]
                        rows = [[str(round(v, 6) if isinstance(v, float) else (v or '')) for v in result.values()]]
                        return {"columns": cols, "rows": rows, "source": "Messari Asset Metrics"}
            except Exception as e:
                return {"error": f"Messari error: {e}", "columns": [], "rows": []}
            return {"columns": [], "rows": [], "note": "Messari returned no data (API key required)."}

        return {"error": "No preview method for " + sid, "columns": [], "rows": []}


    except Exception as e:
        return {"error": str(e), "columns": [], "rows": []}


class BacktestRequest(BaseModel):
    pair:     str           = "STRKUSD"
    interval: int           = 1440
    start:    Optional[str] = None
    end:      Optional[str] = None
    script:   str           = ""
    indicators: list        = []   # pre-compute these before strategy() is called
    exchange:   str         = "kraken"  # which exchange to pull OHLCVT from

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
        pair     = req.pair.upper()
        exchange = (req.exchange or "kraken").lower()

        # ── Route to external exchange connector ──────────────────────────────
        if exchange != "kraken" and HAS_DS:
            connector_cls = _EXCHANGE_CONNECTORS_MAP.get(exchange)
            if connector_cls is None:
                return {"error": f"Unknown exchange: {exchange}", "trades": [], "equity": [], "stats": {}}
            try:
                import datetime as _bdt, time as _time
                try:
                    _s = _bdt.date.fromisoformat(req.start)
                    _e = _bdt.date.fromisoformat(req.end)
                    _start_ts = int(_bdt.datetime(_s.year,_s.month,_s.day, tzinfo=_bdt.timezone.utc).timestamp())
                    _end_ts   = int(_bdt.datetime(_e.year,_e.month,_e.day,23,59,59, tzinfo=_bdt.timezone.utc).timestamp())
                except Exception:
                    _start_ts = 0
                    _end_ts   = int(_time.time())
                ext_df = connector_cls.fetch_ohlcv(
                    symbol           = pair,
                    interval_minutes = req.interval,
                    start_ts         = _start_ts,
                    end_ts           = _end_ts,
                )
                # Normalize columns to match internal schema
                # Expected cols from connectors: time/ts, open, high, low, close, volume
                if ext_df is None or ext_df.empty:
                    return {"error": f"No OHLCVT data returned from {exchange} for {pair}.",
                            "trades": [], "equity": [], "stats": {}}
                # Rename 'ts' → 'time' if needed
                if "ts" in ext_df.columns and "time" not in ext_df.columns:
                    ext_df = ext_df.rename(columns={"ts": "time"})
                if "time" not in ext_df.columns:
                    return {"error": f"{exchange} connector returned unexpected columns: {list(ext_df.columns)}",
                            "trades": [], "equity": [], "stats": {}}
                # Ensure numeric types
                for col in ["open", "high", "low", "close", "volume"]:
                    if col in ext_df.columns:
                        ext_df[col] = pd.to_numeric(ext_df[col], errors="coerce")
                # Add stub columns the pipeline expects
                for stub in ["vwap", "trades"]:
                    if stub not in ext_df.columns:
                        ext_df[stub] = None
                df = ext_df.reset_index(drop=True)
                # Build empty unlocks & fear_greed (external exchanges don't have these yet)
                unlocks       = pd.DataFrame()
                fear_greed_df = pd.DataFrame(columns=["date","fg_value","fg_class"])
            except Exception as e:
                return {"error": f"Failed to fetch data from {exchange}: {e}",
                        "trades": [], "equity": [], "stats": {}}

        else:
            # ── Kraken local DB (default) ─────────────────────────────────────
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
            fg_rows = conn.execute(
                "SELECT date, value AS fg_value, classification AS fg_class "
                "FROM fear_greed ORDER BY date ASC").fetchall()
            conn.close()

            df            = pd.DataFrame([dict(r) for r in ohlcvt_rows])
            unlocks       = pd.DataFrame([dict(r) for r in unlock_rows])
            fear_greed_df = pd.DataFrame([dict(r) for r in fg_rows]) if fg_rows else pd.DataFrame(columns=["date","fg_value","fg_class"])

        if df.empty:
            return {"error": f"No OHLCVT data for {pair} on {exchange} with the selected range.",
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

        # ── Pre-merge Fear & Greed into df ──────────────────────────────────
        if not fear_greed_df.empty and not df.empty:
            df['date'] = pd.to_datetime(df['time'], unit='s').dt.strftime('%Y-%m-%d')
            df = df.merge(fear_greed_df[['date', 'fg_value', 'fg_class']], on='date', how='left')
            df['fg_value'] = df['fg_value'].fillna(50).astype(int)
            df['fg_class'] = df['fg_class'].fillna('Neutral')
        else:
            df['date'] = pd.to_datetime(df['time'], unit='s').dt.strftime('%Y-%m-%d')
            df['fg_value'] = 50
            df['fg_class'] = 'Neutral'

        # ── Pre-compute toggled indicators ───────────────────────────────────
        if req.indicators:
            df = _precompute_indicators(df, req.indicators, _ta)

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
        step = max(1, len(ohlcv_df) // MAX_CANDLES)
        if len(ohlcv_df) > MAX_CANDLES:
            ohlcv_df = ohlcv_df.iloc[::step]
        ohlcv_list = ohlcv_df.to_dict("records")

        # ── Extract indicator series for chart overlay ───────────────────────────
        PRICE_SCALE_COLS = {'SMA', 'EMA', 'BB_UPPER', 'BB_MID', 'BB_LOWER', 'VWAP'}
        OSCILLATOR_COLS  = {
            'RSI': (0, 100), 'MACD': None, 'MACD_SIGNAL': None, 'MACD_HIST': None,
            'STOCH_K': (0, 100), 'STOCH_D': (0, 100),
            'ATR': None, 'OBV': None, 'BB_WIDTH': None,
        }
        # Also catch WR_n, RSI_n, SMA_n, EMA_n, ATR_n columns
        PRICE_PREFIXES = ('SMA_', 'EMA_', 'BB_UPPER', 'BB_MID', 'BB_LOWER', 'VWAP')
        OSC_PREFIXES   = ('RSI_', 'WR_', 'ATR_', 'OBV')

        indicator_data = {}
        indicator_meta = {}   # col -> {type: 'price'|'oscillator', range: [min,max] or null}
        base_times = df['time'].iloc[::step].reset_index(drop=True)

        indicator_cols = set(df.columns) - {'time','open','high','low','close','volume',
                                            'vwap','trades','date','fg_value','fg_class'}
        for col in sorted(indicator_cols):
            series = df[col].iloc[::step].reset_index(drop=True)
            base_name = col.split('_')[0] if '_' in col else col
            is_price = (
                any(col.startswith(p) for p in PRICE_PREFIXES) or
                col in PRICE_SCALE_COLS
            )
            is_osc = (
                any(col.startswith(p) for p in OSC_PREFIXES) or
                col in OSCILLATOR_COLS or
                col.startswith('MACD') or
                col in ('STOCH_K', 'STOCH_D')
            )
            if not (is_price or is_osc):
                continue
            points = []
            for t, v in zip(base_times, series):
                if pd.notna(v) and pd.notna(t):
                    points.append({"time": int(t), "value": round(float(v), 8)})
            if points:
                indicator_data[col] = points
                rng = None
                if col.startswith('RSI') or col.startswith('STOCH'):
                    rng = [0, 100]
                elif col.startswith('WR'):
                    rng = [-100, 0]
                indicator_meta[col] = {
                    'type':  'price' if is_price else 'oscillator',
                    'range': rng,
                    'group': 'macd' if col.startswith('MACD') else
                             'stoch' if col.startswith('STOCH') else
                             col.split('_')[0].lower()
                }

        return {"trades": trades, "equity": equity_curve, "stats": stats,
                "ohlcv": ohlcv_list,
                "indicator_data": indicator_data,
                "indicator_meta": indicator_meta,
                "error": None}

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
    api_key    = _runtime_keys["api_key"] or os.environ.get("KRAKEN_API_KEY", "").strip()
    api_secret = _runtime_keys["api_secret"] or os.environ.get("KRAKEN_API_SECRET", "").strip()
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
    api_key    = _runtime_keys["api_key"] or os.environ.get("KRAKEN_API_KEY", "").strip()
    api_secret = _runtime_keys["api_secret"] or os.environ.get("KRAKEN_API_SECRET", "").strip()
    if not api_key or not api_secret:
        return {"connected": False, "error": "No API keys configured"}
    if not HAS_REQUESTS:
        return {"connected": False, "error": "requests library not installed"}
    resp = _kraken_private("Balance")
    if resp.get("error") and resp["error"]:
        return {"connected": False, "error": str(resp["error"])}
    return {"connected": True, "key_prefix": api_key[:8] + "…"}


class SetKeysRequest(BaseModel):
    api_key:    str
    api_secret: str

@app.post("/api/kraken/set-keys")
def kraken_set_keys(req: SetKeysRequest):
    """Store Kraken API credentials in memory for this server session."""
    _runtime_keys["api_key"]    = req.api_key.strip()
    _runtime_keys["api_secret"] = req.api_secret.strip()
    if not _runtime_keys["api_key"] or not _runtime_keys["api_secret"]:
        return {"ok": False, "error": "Both api_key and api_secret are required"}
    # Immediately verify by fetching balance
    resp = _kraken_private("Balance")
    if resp.get("error") and resp["error"]:
        _runtime_keys["api_key"] = ""
        _runtime_keys["api_secret"] = ""
        return {"ok": False, "error": str(resp["error"])}
    return {"ok": True, "key_prefix": req.api_key[:8] + "…"}


# ══════════════════════════════════════════════════════════════════════════════
# ── GEMINI AI CHAT ────────────────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════════════

GEMINI_MODEL = "gemini-2.5-flash"

class ChatRequest(BaseModel):
    message:      str
    system:       str  = ""
    history:      list = []
    current_code: str  = ""   # code currently in editor (for iterative refinement)
    # ── New: data-source + indicator context from Initiator ─────────────────
    selected_sources:    list = []   # e.g. ['price','feargreed','unlocks']
    selected_indicators: list = []   # e.g. [{'id':'sma','period':200}, ...]


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
    if len(lines) < 8:
        return False
    body_lines = [l for l in lines if l not in ('trades = []', 'return trades', '"""') and
                  not l.startswith('def strategy') and not l.startswith('"""')]
    return len(body_lines) >= 4


# ── Indicator pre-computation ─────────────────────────────────────────────────
def _precompute_indicators(df: "pd.DataFrame", indicators: list, ta_lib) -> "pd.DataFrame":
    """Add toggled technical indicator columns directly onto df."""
    close = df['close']
    high  = df.get('high',  close)
    low   = df.get('low',   close)
    vol   = df.get('volume', pd.Series(dtype=float))

    for ind in indicators:
        iid = ind.get('id', '')
        p   = int(ind.get('period', ind.get('p', 14)))
        col = ind.get('col', f'{iid.upper()}_{p}')   # computed column name

        try:
            if iid == 'sma':
                df[col] = close.rolling(p).mean()
            elif iid == 'ema':
                df[col] = close.ewm(span=p, adjust=False).mean()
            elif iid == 'rsi':
                if ta_lib:
                    df[col] = ta_lib.momentum.RSIIndicator(close, window=p).rsi()
                else:
                    # manual RSI fallback
                    delta = close.diff()
                    gain  = delta.clip(lower=0).rolling(p).mean()
                    loss  = (-delta.clip(upper=0)).rolling(p).mean()
                    rs    = gain / loss.replace(0, float('nan'))
                    df[col] = 100 - (100 / (1 + rs))
            elif iid == 'macd':
                fast   = int(ind.get('fast', 12))
                slow   = int(ind.get('slow', 26))
                signal = int(ind.get('signal', 9))
                macd_line   = close.ewm(span=fast, adjust=False).mean() - close.ewm(span=slow, adjust=False).mean()
                signal_line = macd_line.ewm(span=signal, adjust=False).mean()
                df['MACD']        = macd_line
                df['MACD_SIGNAL'] = signal_line
                df['MACD_HIST']   = macd_line - signal_line
            elif iid == 'bbands':
                std_mult = float(ind.get('std', 2.0))
                mid   = close.rolling(p).mean()
                std   = close.rolling(p).std()
                df['BB_MID']   = mid
                df['BB_UPPER'] = mid + std_mult * std
                df['BB_LOWER'] = mid - std_mult * std
                df['BB_WIDTH'] = (df['BB_UPPER'] - df['BB_LOWER']) / mid
            elif iid == 'atr':
                if ta_lib:
                    df[col] = ta_lib.volatility.AverageTrueRange(high, low, close, window=p).average_true_range()
                else:
                    hl  = high - low
                    hc  = (high - close.shift()).abs()
                    lc  = (low  - close.shift()).abs()
                    tr  = pd.concat([hl, hc, lc], axis=1).max(axis=1)
                    df[col] = tr.rolling(p).mean()
            elif iid == 'stoch':
                k_period = int(ind.get('k', 14))
                d_period = int(ind.get('d', 3))
                low_min  = low.rolling(k_period).min()
                high_max = high.rolling(k_period).max()
                df['STOCH_K'] = 100 * (close - low_min) / (high_max - low_min + 1e-9)
                df['STOCH_D'] = df['STOCH_K'].rolling(d_period).mean()
            elif iid == 'vwap':
                typ   = (high + low + close) / 3
                df['VWAP'] = (typ * vol).cumsum() / vol.cumsum().replace(0, float('nan'))
            elif iid == 'obv':
                direction = close.diff().apply(lambda x: 1 if x > 0 else (-1 if x < 0 else 0))
                df['OBV'] = (vol * direction).cumsum()
            elif iid == 'wr':
                high_max = high.rolling(p).max()
                low_min  = low.rolling(p).min()
                df[col]  = -100 * (high_max - close) / (high_max - low_min + 1e-9)
        except Exception as e:
            print(f"[indicators] skipped {iid}: {e}")

    return df


# ── Dynamic system prompt from selected sources + indicators ──────────────────
def _build_context_prompt(sources: list, indicators: list) -> str:
    """Build the precise system prompt section describing df columns."""
    lines = [
        "You are an expert quantitative trading strategy builder for a crypto backtesting platform.",
        "Always structure responses with three labelled sections:",
        "[Algorithm] — plain-English explanation (3-5 sentences)",
        "[Python Code] — complete implementation",
        "[Parameters] — key parameters with defaults and ranges",
        "",
        "CRITICAL: The df DataFrame passed to strategy() contains EXACTLY these columns.",
        "Use ONLY these column names — do not invent others:",
        "",
        "OHLCV (always available):",
        "  df['open'], df['high'], df['low'], df['close'], df['volume']",
        "  df['time']  — Unix timestamp (int)",
        "  df['date']  — date string YYYY-MM-DD",
    ]

    if 'feargreed' in sources:
        lines += [
            "",
            "Fear & Greed Index (merged by date):",
            "  df['fg_value']  — int 0-100 (0=Extreme Fear, 100=Extreme Greed)",
            "  df['fg_class']  — string: 'Extreme Fear'|'Fear'|'Neutral'|'Greed'|'Extreme Greed'",
        ]

    if 'unlocks' in sources:
        lines += [
            "",
            "Token Unlocks (separate DataFrame, 2nd arg):",
            "  unlocks['time'], unlocks['daily_new_tokens'], unlocks['cumulative_tokens']",
            "  unlocks['has_cliff_event'], unlocks['cliff_event_tokens'], unlocks['inflation_pct_of_supply']",
        ]

    # Build indicator column descriptions
    ind_lines = []
    for ind in indicators:
        iid = ind.get('id', '')
        p   = int(ind.get('period', ind.get('p', 14)))
        col = ind.get('col', f'{iid.upper()}_{p}')
        if iid == 'sma':
            ind_lines.append(f"  df['{col}']  — Simple Moving Average, period={p}")
        elif iid == 'ema':
            ind_lines.append(f"  df['{col}']  — Exponential Moving Average, period={p}")
        elif iid == 'rsi':
            ind_lines.append(f"  df['{col}']  — RSI (0-100), period={p}. Oversold<30, Overbought>70")
        elif iid == 'macd':
            fast=ind.get('fast',12); slow=ind.get('slow',26); sig=ind.get('signal',9)
            ind_lines.append(f"  df['MACD']        — MACD line (EMA{fast} - EMA{slow})")
            ind_lines.append(f"  df['MACD_SIGNAL'] — Signal line (EMA{sig} of MACD)")
            ind_lines.append(f"  df['MACD_HIST']   — Histogram (MACD - SIGNAL). Positive=bullish")
        elif iid == 'bbands':
            std=ind.get('std',2.0)
            ind_lines.append(f"  df['BB_UPPER'], df['BB_MID'], df['BB_LOWER']  — Bollinger Bands period={p} std={std}")
            ind_lines.append(f"  df['BB_WIDTH']  — Band width (normalised)")
        elif iid == 'atr':
            ind_lines.append(f"  df['{col}']  — Average True Range, period={p} (volatility measure)")
        elif iid == 'stoch':
            k=ind.get('k',14); d=ind.get('d',3)
            ind_lines.append(f"  df['STOCH_K']  — Stochastic %K, period={k}")
            ind_lines.append(f"  df['STOCH_D']  — Stochastic %D (smoothed), period={d}")
        elif iid == 'vwap':
            ind_lines.append("  df['VWAP']  — Volume Weighted Average Price (daily reset)")
        elif iid == 'obv':
            ind_lines.append("  df['OBV']  — On Balance Volume (cumulative)")
        elif iid == 'wr':
            ind_lines.append(f"  df['{col}']  — Williams %R (-100 to 0), period={p}. Oversold<-80")

    if ind_lines:
        lines += ["", "Pre-computed Technical Indicators (ready to use):"]
        lines += ind_lines

    lines += [
        "",
        "strategy() signature:",
    ]
    sig_args = "df, unlocks" if 'unlocks' in sources else "df, unlocks"
    lines.append(f"  def strategy({sig_args}):")
    lines += [
        "    # df has all columns above. unlocks is a DataFrame.",
        "    trades = []",
        "    # ... your logic ...",
        "    return trades  # list of dicts with: entry, exit, side, entry_price, exit_price",
        "",
        "NEVER use column names not listed above. NEVER use df['RSI'] if only df['RSI_14'] is listed.",
        "Write the COMPLETE implementation — no placeholders, no '# ...' stubs.",
    ]

    return "\n".join(lines)


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

        # Build system prompt — dynamic if sources/indicators provided, else default
        if req.selected_sources or req.selected_indicators:
            base_prompt = _build_context_prompt(req.selected_sources, req.selected_indicators)
        else:
            base_prompt = (
                "You are an expert quantitative trading strategy builder for a crypto backtesting platform.\n"
                "Always structure responses with three labelled sections:\n"
                "[Algorithm] — plain-English explanation (3-5 sentences)\n"
                "[Python Code] — complete def strategy(df, unlocks): ... returning list of trade dicts\n"
                "[Parameters] — key parameters with defaults and ranges"
            )

        system_prompt = (req.system or base_prompt) + code_ctx

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

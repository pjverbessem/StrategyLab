import math
import time
from datetime import datetime, timezone
from typing import Optional

from database import db
from config import PAIR_COLORS, PAIR_NAMES, KRAKEN_PAIR_MAP, KRAKEN_BASE, HAS_REQUESTS
from services.market_data.utils import ts2date, fmt, _price_cache, _price_cache_ts, PRICE_CACHE_TTL


def get_pairs():
    try:
        conn = db()
        rows = conn.execute("""
            SELECT pair,
                   GROUP_CONCAT(DISTINCT interval ORDER BY interval) AS intervals,
                   MIN(ts) AS min_ts, MAX(ts) AS max_ts, COUNT(*) AS count
            FROM ohlcvt GROUP BY pair ORDER BY pair
        """).fetchall()
        conn.close()
        if rows:
            return [{
                "pair":      r["pair"],
                "name":      PAIR_NAMES.get(r["pair"], r["pair"]),
                "color":     PAIR_COLORS.get(r["pair"], "#6366f1"),
                "intervals": [int(i) for i in r["intervals"].split(",")],
                "start":     ts2date(r["min_ts"]),
                "end":       ts2date(r["max_ts"]),
                "count":     r["count"],
            } for r in rows]
    except Exception:
        pass
    # DB empty — return static list from config
    today = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
    return [
        {
            "pair":      pair,
            "name":      PAIR_NAMES.get(pair, pair),
            "color":     PAIR_COLORS.get(pair, "#6366f1"),
            "intervals": [60, 240, 1440],
            "start":     "2023-01-01",
            "end":       today,
            "count":     0,
        }
        for pair in PAIR_NAMES
    ]


def get_ohlcvt(pair: str, interval: int, start: Optional[str], end: Optional[str]):
    conn   = db()
    conds  = ["pair = ?", "interval = ?"]
    parms  = [pair.upper(), interval]

    if start:
        conds.append("ts >= ?")
        parms.append(int(datetime.fromisoformat(start).replace(tzinfo=timezone.utc).timestamp()))
    if end:
        conds.append("ts <= ?")
        parms.append(int(datetime.fromisoformat(end).replace(tzinfo=timezone.utc).timestamp()) + 86400)

    where  = " AND ".join(conds)
    TARGET = 10_000
    FULL_RETURN_THRESHOLD = 15_000

    total = conn.execute(f"SELECT COUNT(*) FROM ohlcvt WHERE {where}", parms).fetchone()[0]

    if total <= FULL_RETURN_THRESHOLD:
        rows = conn.execute(
            f"SELECT ts AS time, open, high, low, close, volume, vwap, trades "
            f"FROM ohlcvt WHERE {where} ORDER BY ts ASC", parms
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

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


def get_unlocks(pair: str):
    conn = db()
    rows = conn.execute("""
        SELECT date AS time, daily_new_tokens, cumulative_tokens,
               has_cliff_event, cliff_event_tokens, inflation_pct_of_supply
        FROM token_unlocks WHERE pair = ? ORDER BY date ASC
    """, (pair.upper(),)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_unlock_events(pair: str):
    conn = db()
    rows = conn.execute("""
        SELECT date AS time, category, amount, event_type, note
        FROM unlock_events WHERE pair = ? AND event_type = 'cliff' ORDER BY date ASC
    """, (pair.upper(),)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_upcoming_cliffs(days: int):
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
        "date_str":   ts2date(r["time"]),
        "color":      PAIR_COLORS.get(r["pair"], "#6366f1"),
        "name":       PAIR_NAMES.get(r["pair"], r["pair"]),
        "amount_fmt": fmt(r["cliff_event_tokens"] or 0),
    } for r in rows]


def get_db_summary():
    try:
        conn = db()
        ohlcvt_rows = conn.execute("""
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
    except Exception as e:
        return {"counts": {"ohlcvt": 0, "token_unlocks": 0, "unlock_events": 0}, "ohlcvt": [], "unlocks": [], "error": str(e)}


def get_fear_greed_latest():
    conn = db()
    row  = conn.execute(
        "SELECT date, timestamp_utc, value, classification, source "
        "FROM fear_greed ORDER BY date DESC LIMIT 1"
    ).fetchone()
    conn.close()
    if not row:
        return {"error": "No Fear & Greed data found. Run src/fetch_fear_greed.py first."}
    return dict(row)


def get_fear_greed_history(start: Optional[str], end: Optional[str], limit: int):
    conn   = db()
    conds: list = []
    params: list = []
    if start:
        conds.append("date >= ?")
        params.append(start)
    if end:
        conds.append("date <= ?")
        params.append(end)
    where = ("WHERE " + " AND ".join(conds)) if conds else ""
    params.append(min(limit, 5000))
    rows = conn.execute(
        f"SELECT date, timestamp_utc, value, classification, source "
        f"FROM fear_greed {where} ORDER BY date ASC LIMIT ?",
        params,
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def fetch_live_price(pair: str):
    import requests as http_req

    pair = pair.upper()
    now  = time.time()

    if pair in _price_cache and now - _price_cache_ts.get(pair, 0) < PRICE_CACHE_TTL:
        return _price_cache[pair]

    if not HAS_REQUESTS:
        return {"error": "requests library not installed", "pair": pair}

    kraken_pair = KRAKEN_PAIR_MAP.get(pair, pair)
    try:
        resp = http_req.get(
            f"{KRAKEN_BASE}/0/public/Ticker",
            params={"pair": kraken_pair},
            timeout=5,
        )
        data = resp.json()
        if data.get("error") and data["error"]:
            return {"error": str(data["error"]), "pair": pair}

        result_data = data.get("result", {})
        if not result_data:
            return {"error": "No ticker data", "pair": pair}

        ticker     = list(result_data.values())[0]
        price_data = {
            "pair":     pair,
            "bid":      float(ticker["b"][0]),
            "ask":      float(ticker["a"][0]),
            "last":     float(ticker["c"][0]),
            "high24":   float(ticker["h"][1]),
            "low24":    float(ticker["l"][1]),
            "volume24": float(ticker["v"][1]),
            "vwap24":   float(ticker["p"][1]),
            "trades24": int(ticker["t"][1]),
            "ts":       int(now),
        }
        _price_cache[pair]    = price_data
        _price_cache_ts[pair] = now
        return price_data

    except Exception as e:
        return {"error": str(e), "pair": pair}

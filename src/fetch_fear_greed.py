#!/usr/bin/env python3
"""
fetch_fear_greed.py
-------------------
Fetches the Crypto Fear & Greed Index from alternative.me (free, no key
required) and stores daily values in data/kraken.db → table `fear_greed`.

The index runs from 0 (Extreme Fear) to 100 (Extreme Greed):
  0–24   Extreme Fear
  25–44  Fear
  45–55  Neutral
  56–74  Greed
  75–100 Extreme Greed

Source:  https://api.alternative.me/fng/
         https://alternative.me/crypto/fear-and-greed-index/

Note:
  CMC's own F&G endpoint requires a paid Pro API key.  alternative.me
  provides the same well-known index for free with full history.

Run:
    python3 src/fetch_fear_greed.py            # fetch all available history
    python3 src/fetch_fear_greed.py --days 30  # fetch last 30 days only
"""

import argparse
import json
import sqlite3
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
DB_PATH  = BASE_DIR / "data" / "kraken.db"

FNG_URL  = "https://api.alternative.me/fng/"

DDL = """
CREATE TABLE IF NOT EXISTS fear_greed (
    date          TEXT PRIMARY KEY,   -- ISO date e.g. '2025-01-15'
    timestamp_utc INTEGER,            -- unix timestamp (midnight UTC)
    value         INTEGER,            -- 0–100
    classification TEXT,              -- 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed'
    source        TEXT DEFAULT 'alternative.me'
);
CREATE INDEX IF NOT EXISTS idx_fg_ts ON fear_greed(timestamp_utc);
"""


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(DDL)
    conn.commit()


def fetch_fng(limit: int = 0) -> list[dict]:
    """
    Fetch F&G data from alternative.me.
    limit=0 returns ALL available history (~2000+ days).
    """
    params = f"?limit={limit}&format=json"
    url = FNG_URL + params
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
    )
    print(f"  Fetching: {url}")
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = json.loads(resp.read())

    err = raw.get("metadata", {}).get("error")
    if err:
        raise RuntimeError(f"API error: {err}")

    return raw.get("data", [])


def upsert(conn: sqlite3.Connection, records: list[dict]) -> int:
    rows = []
    for r in records:
        ts = int(r["timestamp"])
        dt = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
        rows.append((
            dt,
            ts,
            int(r["value"]),
            r["value_classification"],
        ))

    conn.executemany("""
        INSERT INTO fear_greed (date, timestamp_utc, value, classification)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
            timestamp_utc  = excluded.timestamp_utc,
            value          = excluded.value,
            classification = excluded.classification
    """, rows)
    conn.commit()
    return len(rows)


def print_summary(conn: sqlite3.Connection) -> None:
    total  = conn.execute("SELECT COUNT(*) FROM fear_greed").fetchone()[0]
    oldest = conn.execute("SELECT MIN(date) FROM fear_greed").fetchone()[0]
    newest = conn.execute("SELECT MAX(date) FROM fear_greed").fetchone()[0]
    today  = conn.execute(
        "SELECT value, classification FROM fear_greed ORDER BY date DESC LIMIT 1"
    ).fetchone()

    print(f"\n  Records in DB : {total:,}")
    print(f"  Date range    : {oldest}  →  {newest}")
    if today:
        val, cls = today
        bar = "█" * (val // 5) + "░" * (20 - val // 5)
        print(f"  Today's index : {val:>3} / 100  [{bar}]  {cls}")

    # Distribution
    print("\n  Distribution:")
    dist = conn.execute("""
        SELECT classification, COUNT(*) AS n
        FROM fear_greed GROUP BY classification ORDER BY MIN(value)
    """).fetchall()
    for cls, n in dist:
        print(f"    {cls:<20} {n:>4} days")


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch Crypto Fear & Greed Index")
    parser.add_argument(
        "--days", type=int, default=0,
        help="Number of days to fetch (default: 0 = all available history)",
    )
    args = parser.parse_args()

    print("=" * 60)
    print("  Crypto Fear & Greed Index  →  SQLite (fear_greed table)")
    print("  Source: alternative.me (free, no key required)")
    print("=" * 60)

    # Ensure DB exists
    if not DB_PATH.exists():
        print(f"❌  Database not found at {DB_PATH}")
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    label = f"last {args.days} days" if args.days else "full history"
    print(f"\n🌐  Fetching F&G index ({label}) …")

    try:
        records = fetch_fng(limit=args.days)
    except Exception as e:
        print(f"❌  Fetch failed: {e}")
        conn.close()
        sys.exit(1)

    print(f"    Received {len(records)} records")

    if not records:
        print("⚠️  No records returned.")
        conn.close()
        return

    n = upsert(conn, records)
    print(f"✅  Upserted {n} records into fear_greed table")

    print_summary(conn)
    conn.close()
    print(f"\n🎯  Done. The /api/fear-greed endpoint will now serve this data.\n")


if __name__ == "__main__":
    main()

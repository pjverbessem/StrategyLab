#!/usr/bin/env python3
"""
ingest.py
---------
Reads the extracted Kraken OHLCVT CSV files from data/raw/ and loads them
into a SQLite database at data/kraken.db.

Kraken OHLCVT CSV format (no header row):
  timestamp, open, high, low, close, vwap, volume, trades

Run: python3 src/ingest.py
"""

import sqlite3
import csv
from pathlib import Path
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────

BASE_DIR = Path(__file__).parent.parent
RAW_DIR  = BASE_DIR / "data" / "raw"
DB_PATH  = BASE_DIR / "data" / "kraken.db"

TARGET_PAIRS = ["ARBUSD", "OPUSD", "STRKUSD", "ZKUSD"]

# Human-readable interval labels
INTERVAL_LABELS = {
    1:     "1m",
    5:     "5m",
    15:    "15m",
    60:    "1h",
    240:   "4h",
    1440:  "1d",
    10080: "1w",
    21600: "15d",
}

# ── Database setup ────────────────────────────────────────────────────────────

DDL = """
CREATE TABLE IF NOT EXISTS ohlcvt (
    pair      TEXT    NOT NULL,   -- e.g. 'ARBUSD'
    interval  INTEGER NOT NULL,   -- minutes: 1, 5, 15, 60, 240, 1440 …
    ts        INTEGER NOT NULL,   -- Unix timestamp (seconds, UTC)
    open      REAL    NOT NULL,
    high      REAL    NOT NULL,
    low       REAL    NOT NULL,
    close     REAL    NOT NULL,
    vwap      REAL,               -- volume-weighted average price
    volume    REAL    NOT NULL,
    trades    INTEGER NOT NULL,
    PRIMARY KEY (pair, interval, ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_ohlcvt_pair_interval_ts
    ON ohlcvt (pair, interval, ts);
"""

# ── Helpers ───────────────────────────────────────────────────────────────────

def init_db(conn: sqlite3.Connection):
    conn.executescript(DDL)
    conn.commit()
    print(f"✅  Database initialised: {DB_PATH}")


def ts_to_human(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def ingest_file(conn: sqlite3.Connection, csv_path: Path, pair: str, interval: int):
    """
    Load one Kraken OHLCVT CSV into the database.
    Skips rows that already exist (upsert by replace).
    """
    rows = []
    with open(csv_path, newline="") as f:
        reader = csv.reader(f)
        for row in reader:
            if not row or row[0].startswith("#"):
                continue
            # Kraken OHLCVT format:
            #   7 cols: timestamp, open, high, low, close, volume, trades
            #   8 cols: timestamp, open, high, low, close, vwap, volume, trades
            if len(row) >= 8:
                ts_val, o, h, l, c, vwap, vol, trades = row[:8]
                vwap_val = float(vwap) if vwap else None
            elif len(row) == 7:
                ts_val, o, h, l, c, vol, trades = row[:7]
                vwap_val = None
            else:
                continue
            rows.append((
                pair,
                interval,
                int(ts_val),
                float(o),
                float(h),
                float(l),
                float(c),
                vwap_val,
                float(vol),
                int(trades),
            ))

    if not rows:
        print(f"    ⚠️  No rows in {csv_path.name} — skipping")
        return 0

    conn.executemany(
        """INSERT OR REPLACE INTO ohlcvt
           (pair, interval, ts, open, high, low, close, vwap, volume, trades)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        rows,
    )
    conn.commit()
    return len(rows)


def run_ingest():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    init_db(conn)

    csv_files = sorted(RAW_DIR.glob("*.csv"))
    if not csv_files:
        print(f"⚠️   No CSV files found in {RAW_DIR}")
        print("     Run  python3 src/download_kraken.py  first.")
        conn.close()
        return

    print(f"\n📥  Ingesting {len(csv_files)} file(s) into {DB_PATH.name} …\n")

    total_rows = 0
    for csv_path in csv_files:
        stem  = csv_path.stem          # e.g. "ARBUSD_60"
        parts = stem.rsplit("_", 1)
        if len(parts) != 2:
            print(f"    ⚠️  Unexpected filename: {csv_path.name} — skipping")
            continue

        pair     = parts[0]
        try:
            interval = int(parts[1])
        except ValueError:
            print(f"    ⚠️  Bad interval in: {csv_path.name} — skipping")
            continue

        if pair not in TARGET_PAIRS:
            continue

        label = INTERVAL_LABELS.get(interval, f"{interval}m")
        n = ingest_file(conn, csv_path, pair, interval)
        total_rows += n

        if n > 0:
            # Quick stats
            cur = conn.execute(
                "SELECT MIN(ts), MAX(ts), COUNT(*) FROM ohlcvt WHERE pair=? AND interval=?",
                (pair, interval)
            )
            min_ts, max_ts, count = cur.fetchone()
            from_dt = ts_to_human(min_ts)
            to_dt   = ts_to_human(max_ts)
            print(f"    ✔  {pair:8s} [{label:>4s}]  {count:>8,} candles  {from_dt} → {to_dt}")

    print(f"\n✅  Total rows ingested/updated: {total_rows:,}")
    print_db_summary(conn)
    conn.close()


def print_db_summary(conn: sqlite3.Connection):
    print(f"\n{'─'*60}")
    print(f"  Database summary")
    print(f"{'─'*60}")
    cur = conn.execute("""
        SELECT pair, interval,
               COUNT(*) AS candles,
               datetime(MIN(ts), 'unixepoch') AS from_dt,
               datetime(MAX(ts), 'unixepoch') AS to_dt
        FROM ohlcvt
        GROUP BY pair, interval
        ORDER BY pair, interval
    """)
    print(f"  {'Pair':<10} {'Interval':>8}  {'Candles':>10}  {'From':<12}  {'To':<12}")
    print(f"  {'─'*10} {'─'*8}  {'─'*10}  {'─'*12}  {'─'*12}")
    for row in cur.fetchall():
        pair, interval, candles, from_dt, to_dt = row
        label = INTERVAL_LABELS.get(interval, f"{interval}m")
        print(f"  {pair:<10} {label:>8}  {candles:>10,}  {from_dt[:10]:<12}  {to_dt[:10]:<12}")

    size = DB_PATH.stat().st_size / 1_048_576
    print(f"\n  DB size: {size:.1f} MB  |  Path: {DB_PATH}\n")


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print("  Kraken OHLCVT → SQLite ingestion")
    print("=" * 60)
    run_ingest()
    print("🎯  Next step: run  python3 src/inspect_data.py  to explore\n")

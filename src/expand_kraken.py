#!/usr/bin/env python3
"""
expand_kraken.py
----------------
Reads the existing Kraken_OHLCVT.zip and bulk-ingests ALL USD pairs
into data/kraken.db for the requested intervals.

Default: 1440 (1D), 240 (4h), 60 (1h)  — keeps the DB to ~1–2 GB.
Add --all-intervals to include 1m/5m/15m/1w as well (~8+ GB).

Run: python3 src/expand_kraken.py
     python3 src/expand_kraken.py --all-intervals
     python3 src/expand_kraken.py --intervals 1440 240
"""

import csv
import sqlite3
import zipfile
import argparse
import sys
from io import TextIOWrapper
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

BASE_DIR = Path(__file__).parent.parent
ZIP_PATH = BASE_DIR / "data" / "Kraken_OHLCVT.zip"
DB_PATH  = BASE_DIR / "data" / "kraken.db"

DEFAULT_INTERVALS = [60, 240, 1440]          # 1h, 4h, 1D
ALL_INTERVALS     = [1, 5, 15, 60, 240, 1440, 10080, 21600]

INTERVAL_LABELS = {
    1: "1m", 5: "5m", 15: "15m", 60: "1h",
    240: "4h", 1440: "1D", 10080: "1w", 21600: "15d",
}

# ── DB init ───────────────────────────────────────────────────────────────────

DDL = """
CREATE TABLE IF NOT EXISTS ohlcvt (
    pair      TEXT    NOT NULL,
    interval  INTEGER NOT NULL,
    ts        INTEGER NOT NULL,
    open      REAL    NOT NULL,
    high      REAL    NOT NULL,
    low       REAL    NOT NULL,
    close     REAL    NOT NULL,
    vwap      REAL,
    volume    REAL    NOT NULL,
    trades    INTEGER NOT NULL,
    PRIMARY KEY (pair, interval, ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_ohlcvt_pair_interval_ts
    ON ohlcvt (pair, interval, ts);
"""

def init_db(conn):
    conn.executescript(DDL)
    conn.commit()


# ── Helpers ───────────────────────────────────────────────────────────────────

def already_loaded(conn, pair, interval):
    """Return True if this pair+interval already has data in the DB."""
    cur = conn.execute(
        "SELECT COUNT(*) FROM ohlcvt WHERE pair=? AND interval=?",
        (pair, interval)
    )
    return cur.fetchone()[0] > 0


def parse_csv_rows(fileobj, pair, interval):
    rows = []
    reader = csv.reader(TextIOWrapper(fileobj, encoding="utf-8", errors="ignore"))
    for row in reader:
        if not row or row[0].startswith("#"):
            continue
        try:
            if len(row) >= 8:
                ts, o, h, l, c, vwap, vol, trades = row[:8]
                vwap_val = float(vwap) if vwap else None
            elif len(row) == 7:
                ts, o, h, l, c, vol, trades = row[:7]
                vwap_val = None
            else:
                continue
            rows.append((
                pair, interval, int(ts),
                float(o), float(h), float(l), float(c),
                vwap_val, float(vol), int(trades),
            ))
        except (ValueError, IndexError):
            continue
    return rows


def ingest_rows(conn, rows):
    conn.executemany(
        """INSERT OR IGNORE INTO ohlcvt
           (pair, interval, ts, open, high, low, close, vwap, volume, trades)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        rows,
    )
    conn.commit()


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Expand Kraken OHLCVT DB to all USD pairs")
    parser.add_argument("--all-intervals", action="store_true",
                        help="Include all intervals (1m–15d); DB may reach 8+ GB")
    parser.add_argument("--intervals", nargs="+", type=int,
                        help="Specific intervals in minutes, e.g. --intervals 1440 240")
    parser.add_argument("--skip-existing", action="store_true", default=True,
                        help="Skip pair+interval combos already in the DB (default: True)")
    parser.add_argument("--pairs", nargs="+",
                        help="Only load specific pairs, e.g. --pairs BTCUSD ETHUSD")
    args = parser.parse_args()

    if not ZIP_PATH.exists():
        sys.exit(f"❌  ZIP not found: {ZIP_PATH}\n   Run python3 src/download_kraken.py first.")

    intervals = args.intervals or (ALL_INTERVALS if args.all_intervals else DEFAULT_INTERVALS)
    print("=" * 65)
    print("  Kraken OHLCVT → SQLite  (bulk expansion)")
    print("=" * 65)
    print(f"  ZIP:       {ZIP_PATH}")
    print(f"  DB:        {DB_PATH}")
    print(f"  Intervals: {', '.join(INTERVAL_LABELS.get(i, f'{i}m') for i in intervals)}")
    print()

    # Open DB
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-131072")   # 128 MB page cache
    init_db(conn)

    # Scan ZIP for all target files
    with zipfile.ZipFile(ZIP_PATH, "r") as zf:
        all_names = zf.namelist()
        print(f"  ZIP entries: {len(all_names):,}")

        # Build index: (pair, interval) → zip_entry_name
        target_files = {}
        for name in all_names:
            from pathlib import PurePosixPath
            base = PurePosixPath(name).name
            if base.startswith("._"):
                continue
            if not base.endswith(".csv"):
                continue
            stem = base[:-4]          # strip .csv
            parts = stem.rsplit("_", 1)
            if len(parts) != 2:
                continue
            p, iv_str = parts
            if not (p.endswith("USD") and not p.endswith("USDT") and not p.endswith("USDC")):
                continue
            try:
                iv = int(iv_str)
            except ValueError:
                continue
            if iv not in intervals:
                continue
            if args.pairs and p not in args.pairs:
                continue
            target_files[(p, iv)] = name

        unique_pairs = sorted(set(p for p, _ in target_files))
        print(f"  USD pairs found in ZIP: {len(unique_pairs)}")
        print(f"  Files to process: {len(target_files)}")
        print()

        loaded = skipped = errors = 0
        for idx, ((pair, iv), zip_entry) in enumerate(sorted(target_files.items())):
            label = INTERVAL_LABELS.get(iv, f"{iv}m")

            if args.skip_existing and already_loaded(conn, pair, iv):
                skipped += 1
                continue

            try:
                with zf.open(zip_entry) as f:
                    rows = parse_csv_rows(f, pair, iv)

                if not rows:
                    continue

                ingest_rows(conn, rows)
                loaded += 1

                # Progress every 50 files
                if loaded % 50 == 0 or loaded <= 5:
                    cur = conn.execute(
                        "SELECT MIN(ts), MAX(ts), COUNT(*) FROM ohlcvt WHERE pair=? AND interval=?",
                        (pair, iv)
                    )
                    mn, mx, cnt = cur.fetchone()
                    from datetime import datetime, timezone
                    def fmt(t): return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%d")
                    print(f"  [{loaded:>4}] {pair:<12} {label:>4}  {cnt:>8,} candles  {fmt(mn)} → {fmt(mx)}")

            except Exception as e:
                errors += 1
                print(f"  ⚠️  {pair} {label}: {e}")

    print()
    print(f"✅  Done — loaded: {loaded}  skipped (already in DB): {skipped}  errors: {errors}")

    # Summary
    cur = conn.execute("SELECT COUNT(DISTINCT pair) FROM ohlcvt")
    total_pairs = cur.fetchone()[0]
    cur = conn.execute("SELECT COUNT(*) FROM ohlcvt")
    total_rows = cur.fetchone()[0]
    db_mb = DB_PATH.stat().st_size / 1_048_576
    print(f"   DB pairs: {total_pairs}  |  Total rows: {total_rows:,}  |  DB size: {db_mb:.1f} MB")
    conn.close()


if __name__ == "__main__":
    main()

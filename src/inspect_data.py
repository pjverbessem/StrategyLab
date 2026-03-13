#!/usr/bin/env python3
"""
inspect_data.py
---------------
Quick exploration tool for the kraken.db database.
Shows date ranges, candle counts, price ranges, and sample data.

Run: python3 src/inspect_data.py [pair] [interval_minutes]
     e.g. python3 src/inspect_data.py ARBUSD 60
"""

import sqlite3
import sys
from pathlib import Path
from datetime import datetime, timezone

BASE_DIR = Path(__file__).parent.parent
DB_PATH  = BASE_DIR / "data" / "kraken.db"

INTERVAL_LABELS = {
    1: "1m", 5: "5m", 15: "15m", 60: "1h",
    240: "4h", 1440: "1d", 10080: "1w", 21600: "15d",
}

def ts(unix: int) -> str:
    return datetime.fromtimestamp(unix, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")

def run():
    if not DB_PATH.exists():
        print(f"❌  Database not found: {DB_PATH}")
        print("    Run: python3 src/ingest.py")
        return

    conn = sqlite3.connect(DB_PATH)

    # ── Overview ──────────────────────────────────────────────────────────────
    print("\n" + "="*65)
    print("  Kraken Database Overview")
    print("="*65)

    cur = conn.execute("""
        SELECT pair, interval, COUNT(*) AS n,
               MIN(ts) AS first, MAX(ts) AS last,
               MIN(low), MAX(high)
        FROM ohlcvt
        GROUP BY pair, interval
        ORDER BY pair, interval
    """)
    rows = cur.fetchall()

    if not rows:
        print("⚠️   Database is empty. Run: python3 src/ingest.py")
        return

    print(f"\n  {'Pair':<10} {'Int':>5}  {'Candles':>9}  "
          f"{'First':^12}  {'Last':^12}  {'Low':>10}  {'High':>10}")
    print(f"  {'─'*10} {'─'*5}  {'─'*9}  "
          f"{'─'*12}  {'─'*12}  {'─'*10}  {'─'*10}")

    for pair, interval, n, first, last, lo, hi in rows:
        label = INTERVAL_LABELS.get(interval, f"{interval}m")
        print(f"  {pair:<10} {label:>5}  {n:>9,}  "
              f"{ts(first)[:10]:^12}  {ts(last)[:10]:^12}  "
              f"{lo:>10.4f}  {hi:>10.4f}")

    # ── Detailed view for specific pair/interval ──────────────────────────────
    if len(sys.argv) >= 3:
        pair_arg     = sys.argv[1].upper()
        interval_arg = int(sys.argv[2])
        label = INTERVAL_LABELS.get(interval_arg, f"{interval_arg}m")

        print(f"\n{'─'*65}")
        print(f"  Detail: {pair_arg} @ {label}")
        print(f"{'─'*65}")

        # Last 10 candles
        cur2 = conn.execute("""
            SELECT ts, open, high, low, close, vwap, volume, trades
            FROM ohlcvt
            WHERE pair=? AND interval=?
            ORDER BY ts DESC LIMIT 10
        """, (pair_arg, interval_arg))
        rows2 = cur2.fetchall()[::-1]   # chronological

        if not rows2:
            print(f"  ⚠️   No data for {pair_arg}/{label}")
        else:
            print(f"\n  Last {len(rows2)} candles:\n")
            print(f"  {'Timestamp':<20} {'Open':>10} {'High':>10} {'Low':>10} "
                  f"{'Close':>10} {'Volume':>14} {'Trades':>7}")
            print(f"  {'─'*20} {'─'*10} {'─'*10} {'─'*10} {'─'*10} {'─'*14} {'─'*7}")
            for t, o, h, l, c, vwap, vol, trades in rows2:
                print(f"  {ts(t):<20} {o:>10.4f} {h:>10.4f} {l:>10.4f} "
                      f"{c:>10.4f} {vol:>14,.2f} {trades:>7,}")

        # Quick stats — all data
        cur3 = conn.execute("""
            SELECT AVG(close), SUM(volume), AVG(trades)
            FROM ohlcvt WHERE pair=? AND interval=?
        """, (pair_arg, interval_arg))
        avg_close, total_vol, avg_trades = cur3.fetchone()
        if avg_close:
            print(f"\n  Avg close : ${avg_close:.4f}")
            print(f"  Total vol : {total_vol:,.0f} {pair_arg[:3]}")
            print(f"  Avg trades: {avg_trades:.1f} per candle")

    else:
        print(f"\n  Tip: python3 src/inspect_data.py <PAIR> <INTERVAL_MIN>")
        print(f"  e.g. python3 src/inspect_data.py ARBUSD 60")
        print(f"       python3 src/inspect_data.py OPUSD 1440")

    print()
    conn.close()

if __name__ == "__main__":
    run()

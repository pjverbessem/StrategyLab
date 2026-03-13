#!/usr/bin/env python3
"""
inspect_unlocks.py
------------------
Browse the token unlock schedules stored in kraken.db.

Run:  python3 src/inspect_unlocks.py [pair]
      python3 src/inspect_unlocks.py ARBUSD
"""

import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
DB_PATH  = BASE_DIR / "data" / "kraken.db"

def fmt_ts(unix: int) -> str:
    return datetime.fromtimestamp(unix, tz=timezone.utc).strftime("%Y-%m-%d")

def fmt_b(n: float) -> str:
    if n >= 1e9:  return f"{n/1e9:.3f}B"
    if n >= 1e6:  return f"{n/1e6:.1f}M"
    return f"{n:,.0f}"

def run():
    if not DB_PATH.exists():
        print(f"❌  DB not found. Run: python3 src/ingest.py && python3 src/build_unlock_schedule.py")
        return

    conn  = sqlite3.connect(DB_PATH)
    today = int(datetime.now(tz=timezone.utc).replace(hour=0, minute=0,
                             second=0, microsecond=0).timestamp())

    pair_filter = sys.argv[1].upper() if len(sys.argv) > 1 else None

    # ── Overview ───────────────────────────────────────────────────────────────
    print("\n" + "="*70)
    print("  Token Unlock Schedule — Overview")
    print("="*70)

    rows = conn.execute("""
        SELECT pair,
               COUNT(*)                         AS days,
               SUM(daily_new_tokens)            AS total_unlocked,
               SUM(CASE WHEN has_cliff_event=1
                   THEN cliff_event_tokens ELSE 0 END) AS total_cliff,
               SUM(CASE WHEN date <= ?
                   THEN daily_new_tokens ELSE 0 END)   AS already_unlocked,
               SUM(CASE WHEN date > ?
                   THEN daily_new_tokens ELSE 0 END)   AS still_locked
        FROM token_unlocks
        GROUP BY pair ORDER BY pair
    """, (today, today)).fetchall()

    print(f"\n  {'Pair':<10} {'Days':>5}  {'Total':>12}  "
          f"{'Unlocked':>12}  {'Still Locked':>12}  {'Cliffs':>12}")
    print(f"  {'─'*10} {'─'*5}  {'─'*12}  "
          f"{'─'*12}  {'─'*12}  {'─'*12}")
    for pair, days, total, cliff, already, locked in rows:
        if pair_filter and pair != pair_filter:
            continue
        print(f"  {pair:<10} {days:>5}  {fmt_b(total):>12}  "
              f"{fmt_b(already):>12}  {fmt_b(locked):>12}  {fmt_b(cliff):>12}")

    # ── Upcoming cliff events ──────────────────────────────────────────────────
    print(f"\n{'─'*70}")
    print("  Upcoming cliff events (next 365 days)")
    print(f"{'─'*70}")

    cliff_rows = conn.execute("""
        SELECT pair, date, cliff_event_tokens, cumulative_tokens
        FROM token_unlocks
        WHERE has_cliff_event = 1
          AND date > ?
          AND date <= ?
          AND (? IS NULL OR pair = ?)
        ORDER BY date
        LIMIT 25
    """, (today, today + 365*86400, pair_filter, pair_filter)).fetchall()

    if not cliff_rows:
        print("  (none in next 365 days)")
    else:
        print(f"\n  {'Pair':<10}  {'Date':^12}  {'Cliff Amount':>14}  {'Cumulative':>14}")
        print(f"  {'─'*10}  {'─'*12}  {'─'*14}  {'─'*14}")
        for pair, dt, cliff_amt, cum in cliff_rows:
            print(f"  {pair:<10}  {fmt_ts(dt):^12}  {fmt_b(cliff_amt):>14}  {fmt_b(cum):>14}")

    # ── Nearest upcoming cliff per pair ───────────────────────────────────────
    print(f"\n{'─'*70}")
    print("  Next cliff event per pair")
    print(f"{'─'*70}\n")

    for pair_ in ["ARBUSD", "OPUSD", "STRKUSD", "ZKUSD"]:
        if pair_filter and pair_ != pair_filter:
            continue
        row = conn.execute("""
            SELECT date, cliff_event_tokens, cumulative_tokens
            FROM token_unlocks
            WHERE pair=? AND has_cliff_event=1 AND date > ?
            ORDER BY date LIMIT 1
        """, (pair_, today)).fetchone()
        if row:
            dt, cliff_amt, cum = row
            days_away = (dt - today) // 86400
            print(f"  {pair_:<10}  {fmt_ts(dt)}  +{days_away:3d} days  "
                  f"cliff={fmt_b(cliff_amt)}  cumulative={fmt_b(cum)}")

    # ── Detailed view for a specific pair ─────────────────────────────────────
    if pair_filter:
        print(f"\n{'─'*70}")
        print(f"  All cliff events: {pair_filter}")
        print(f"{'─'*70}")

        all_cliffs = conn.execute("""
            SELECT e.date, e.category, e.amount, e.event_type, e.note
            FROM unlock_events e
            WHERE e.pair=? AND e.event_type='cliff'
            ORDER BY e.date
        """, (pair_filter,)).fetchall()

        print(f"\n  {'Date':^12}  {'Category':<35}  {'Amount':>14}")
        print(f"  {'─'*12}  {'─'*35}  {'─'*14}")
        for dt, cat, amt, etype, note in all_cliffs:
            flag = " ◀ PAST" if dt <= today else (" ← NEXT" if dt == min(
                r[0] for r in all_cliffs if r[0] > today
            ) else "")
            print(f"  {fmt_ts(dt):^12}  {cat:<35}  {fmt_b(amt):>14}{flag}")

        print(f"\n  Recent + next 30 daily rows:")
        recent = conn.execute("""
            SELECT date, daily_new_tokens, cumulative_tokens,
                   has_cliff_event, cliff_event_tokens, inflation_pct_of_supply
            FROM token_unlocks
            WHERE pair=?
              AND date >= ? - 7*86400
              AND date <= ? + 30*86400
            ORDER BY date
        """, (pair_filter, today, today)).fetchall()

        print(f"\n  {'Date':^12}  {'New Tokens':>14}  {'Cumulative':>14}  "
              f"{'Cliff?':^7}  {'Inflation %':>11}")
        print(f"  {'─'*12}  {'─'*14}  {'─'*14}  {'─'*7}  {'─'*11}")
        for dt, new, cum, is_cliff, cliff_amt, infl in recent:
            cliff_flag = f"🔔{fmt_b(cliff_amt)}" if is_cliff else ""
            past_flag  = "←" if dt == today else ""
            print(f"  {fmt_ts(dt):^12}  {fmt_b(new):>14}  {fmt_b(cum):>14}  "
                  f"{cliff_flag:^7}  {(infl or 0):>10.4f}%  {past_flag}")

    print()
    conn.close()

if __name__ == "__main__":
    run()

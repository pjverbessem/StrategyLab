#!/usr/bin/env python3
"""
download_defillama.py
---------------------
Fetches complete historical TVL data from the DefiLlama API for each of
the 4 chains and loads it into the existing kraken.db database.

A new table  chain_tvl  is created alongside the existing  ohlcvt  table.
The OHLCVT data is NOT touched.

API used (free, no auth):
  https://api.llama.fi/v2/historicalChainTvl/{chain}
  Returns: [ {"date": <unix_ts>, "tvl": <float>}, ... ]

Run: python3 src/download_defillama.py
"""

import json
import sqlite3
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

# ── Config ─────────────────────────────────────────────────────────────────────

BASE_DIR = Path(__file__).parent.parent
DB_PATH  = BASE_DIR / "data" / "kraken.db"

# DefiLlama chain name  →  Kraken pair it correlates with
CHAINS = {
    "Arbitrum":   "ARBUSD",
    "OP Mainnet": "OPUSD",
    "Starknet":   "STRKUSD",
    "ZKsync Era": "ZKUSD",
}

DEFILLAMA_BASE = "https://api.llama.fi/v2/historicalChainTvl"

# ── Database setup ─────────────────────────────────────────────────────────────

DDL_TVL = """
CREATE TABLE IF NOT EXISTS chain_tvl (
    chain     TEXT    NOT NULL,   -- DefiLlama chain name, e.g. 'Arbitrum'
    pair      TEXT    NOT NULL,   -- linked Kraken pair,  e.g. 'ARBUSD'
    date      INTEGER NOT NULL,   -- Unix timestamp (midnight UTC, daily)
    tvl       REAL    NOT NULL,   -- Total Value Locked in USD
    PRIMARY KEY (chain, date)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_chain_tvl_pair_date
    ON chain_tvl (pair, date);
"""

DDL_TVL_DERIVED = """
-- Convenience view: TVL with % daily change and 7-day rolling average
CREATE VIEW IF NOT EXISTS chain_tvl_signals AS
SELECT
    chain,
    pair,
    date,
    datetime(date, 'unixepoch')               AS date_utc,
    tvl,
    LAG(tvl, 1)  OVER w                       AS tvl_prev_1d,
    LAG(tvl, 7)  OVER w                       AS tvl_prev_7d,
    (tvl - LAG(tvl,1) OVER w)
        / NULLIF(LAG(tvl,1) OVER w, 0) * 100  AS tvl_chg_1d_pct,
    (tvl - LAG(tvl,7) OVER w)
        / NULLIF(LAG(tvl,7) OVER w, 0) * 100  AS tvl_chg_7d_pct,
    AVG(tvl) OVER (
        PARTITION BY chain
        ORDER BY date
        ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    )                                          AS tvl_ma7
FROM chain_tvl
WINDOW w AS (PARTITION BY chain ORDER BY date);
"""

# ── Helpers ────────────────────────────────────────────────────────────────────

def ts_to_date(unix: int) -> str:
    return datetime.fromtimestamp(unix, tz=timezone.utc).strftime("%Y-%m-%d")


def fetch_tvl(chain: str) -> list[dict]:
    """Fetch historical TVL array from DefiLlama for one chain."""
    # URL-encode the chain name (spaces → %20)
    encoded = urllib.parse.quote(chain)
    url     = f"{DEFILLAMA_BASE}/{encoded}"

    req = urllib.request.Request(
        url,
        headers={"User-Agent": "KrakenBacktester/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
            return data if isinstance(data, list) else []
    except urllib.error.HTTPError as e:
        print(f"    ❌  HTTP {e.code} for {chain}: {e.reason}")
        return []
    except Exception as e:
        print(f"    ❌  Error fetching {chain}: {e}")
        return []


def init_tvl_table(conn: sqlite3.Connection):
    conn.executescript(DDL_TVL)
    try:
        conn.executescript(DDL_TVL_DERIVED)
    except sqlite3.OperationalError:
        pass  # view already exists
    conn.commit()


def ingest_tvl(conn: sqlite3.Connection, chain: str, pair: str,
               records: list[dict]) -> int:
    """Insert / replace TVL records for one chain."""
    rows = []
    for r in records:
        date_ts = int(r.get("date", 0))
        tvl     = float(r.get("tvl", 0))
        if date_ts > 0:
            rows.append((chain, pair, date_ts, tvl))

    if not rows:
        return 0

    conn.executemany(
        """INSERT OR REPLACE INTO chain_tvl (chain, pair, date, tvl)
           VALUES (?, ?, ?, ?)""",
        rows,
    )
    conn.commit()
    return len(rows)


def print_summary(conn: sqlite3.Connection):
    print(f"\n{'─'*65}")
    print(f"  chain_tvl table summary")
    print(f"{'─'*65}")

    cur = conn.execute("""
        SELECT chain, pair,
               COUNT(*)             AS days,
               datetime(MIN(date), 'unixepoch') AS from_dt,
               datetime(MAX(date), 'unixepoch') AS to_dt,
               MIN(tvl)             AS min_tvl,
               MAX(tvl)             AS max_tvl,
               AVG(tvl)             AS avg_tvl
        FROM chain_tvl
        GROUP BY chain
        ORDER BY chain
    """)
    rows = cur.fetchall()
    if not rows:
        print("  (empty)")
        return

    print(f"\n  {'Chain':<14} {'Pair':<10} {'Days':>5}  "
          f"{'From':^10}  {'To':^10}  "
          f"{'Min TVL ($B)':>13}  {'Max TVL ($B)':>13}")
    print(f"  {'─'*14} {'─'*10} {'─'*5}  "
          f"{'─'*10}  {'─'*10}  {'─'*13}  {'─'*13}")

    for chain, pair, days, from_dt, to_dt, mn, mx, avg in rows:
        print(f"  {chain:<14} {pair:<10} {days:>5}  "
              f"{from_dt[:10]:^10}  {to_dt[:10]:^10}  "
              f"{mn/1e9:>13.2f}  {mx/1e9:>13.2f}")

    print(f"\n  View available: chain_tvl_signals  "
          f"(includes daily Δ%, 7d Δ%, 7d MA)")


# ── Main ──────────────────────────────────────────────────────────────────────

import urllib.parse  # needed for URL encoding

if __name__ == "__main__":
    print("=" * 65)
    print("  DefiLlama Chain TVL Fetcher")
    print("  Chains: Arbitrum · OP Mainnet · Starknet · ZKsync Era")
    print("=" * 65)

    if not DB_PATH.exists():
        print(f"\n⚠️   Database not found: {DB_PATH}")
        print("    Run: python3 src/ingest.py  (Kraken data) first.")
        import sys; sys.exit(1)

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")

    init_tvl_table(conn)
    print(f"\n✅  chain_tvl table ready in {DB_PATH.name}")

    total = 0
    for chain, pair in CHAINS.items():
        print(f"\n  📡  Fetching TVL history: {chain} ({pair}) …")
        records = fetch_tvl(chain)

        if not records:
            print(f"     ⚠️   No data returned")
            continue

        n = ingest_tvl(conn, chain, pair, records)
        total += n

        # Quick summary
        min_ts  = min(r["date"] for r in records)
        max_ts  = max(r["date"] for r in records)
        max_tvl = max(r["tvl"]  for r in records)
        cur_tvl = records[-1]["tvl"]
        print(f"     ✔  {n:,} days  |  "
              f"{ts_to_date(min_ts)} → {ts_to_date(max_ts)}  |  "
              f"Peak: ${max_tvl/1e9:.2f}B  |  "
              f"Latest: ${cur_tvl/1e9:.2f}B")

    print(f"\n✅  Total rows inserted/updated: {total:,}")
    print_summary(conn)
    conn.close()

    print("\n🎯  Next: use  load_chain_tvl()  from backtest.py to combine")
    print("    TVL signals with OHLCVT data in your strategies.\n")

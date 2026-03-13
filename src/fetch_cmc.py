#!/usr/bin/env python3
"""
fetch_cmc.py
------------
Fetches CoinMarketCap rankings, market cap, 24h volume and metadata for
all coins, then cross-references them against the pairs available in the
Kraken ZIP.  Results are stored in data/kraken.db → table `coins`.

Uses the FREE CoinMarketCap API (no key required for the listings endpoint
at low volume).  Falls back to a CMC public scrape if the API is blocked.

Run:
    python3 src/fetch_cmc.py
    python3 src/fetch_cmc.py --api-key YOUR_CMC_KEY   # optional, higher limits
"""

import argparse
import json
import sqlite3
import sys
import time
import urllib.request
import urllib.parse
import zipfile
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
ZIP_PATH = BASE_DIR / "data" / "Kraken_OHLCVT.zip"
DB_PATH  = BASE_DIR / "data" / "kraken.db"

CMC_LISTINGS_URL = "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest"
CMC_FREE_URL = "https://api.coinmarketcap.com/data-api/v3/cryptocurrency/listing"

DDL_COINS = """
CREATE TABLE IF NOT EXISTS coins (
    symbol          TEXT PRIMARY KEY,   -- e.g. 'BTC'
    name            TEXT,
    cmc_rank        INTEGER,
    market_cap_usd  REAL,
    volume_24h_usd  REAL,
    price_usd       REAL,
    kraken_pair     TEXT,               -- e.g. 'BTCUSD' if available on Kraken
    last_updated    INTEGER             -- unix timestamp
);
CREATE INDEX IF NOT EXISTS idx_coins_rank ON coins(cmc_rank);
CREATE INDEX IF NOT EXISTS idx_coins_pair ON coins(kraken_pair);
"""


def init_db(conn):
    conn.executescript(DDL_COINS)
    conn.commit()


def get_kraken_pairs_from_zip():
    """Return set of pair strings (e.g. 'BTCUSD') available in the Kraken ZIP."""
    if not ZIP_PATH.exists():
        print("⚠️  Kraken ZIP not found — can't cross-reference. Continuing.")
        return set()
    pairs = set()
    with zipfile.ZipFile(ZIP_PATH, "r") as zf:
        for name in zf.namelist():
            from pathlib import PurePosixPath
            base = PurePosixPath(name).name
            if base.startswith("._"):
                continue
            if not base.endswith("_1440.csv"):
                continue
            pair = base.replace("_1440.csv", "")
            if pair.endswith("USD") and not pair.endswith("USDT") and not pair.endswith("USDC"):
                pairs.add(pair)
    return pairs


def fetch_cmc_pro(api_key: str, limit: int = 5000):
    """Fetch via official CMC Pro API using an API key."""
    params = urllib.parse.urlencode({
        "start": 1, "limit": limit, "convert": "USD",
    })
    req = urllib.request.Request(
        f"{CMC_LISTINGS_URL}?{params}",
        headers={"X-CMC_PRO_API_KEY": api_key, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    return data.get("data", [])


def fetch_cmc_free(limit: int = 500):
    """
    Fetch via the undocumented CMC public data-api (no key needed).
    Returns up to `limit` coins sorted by CMC rank.
    """
    coins = []
    start = 1
    batch = min(200, limit)

    while len(coins) < limit:
        params = urllib.parse.urlencode({
            "start": start,
            "limit": batch,
            "sortBy": "market_cap",
            "sortType": "desc",
            "convert": "USD",
            "cryptoType": "all",
            "tagType":    "all",
        })
        req = urllib.request.Request(
            f"{CMC_FREE_URL}?{params}",
            headers={
                "User-Agent": "Mozilla/5.0",
                "Accept":     "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw = json.loads(resp.read())
        except Exception as e:
            print(f"  ⚠️  CMC public API error at start={start}: {e}")
            break

        batch_data = raw.get("data", {}).get("cryptoCurrencyList", [])
        if not batch_data:
            break

        # Normalise to same shape as Pro API
        for c in batch_data:
            quotes = c.get("quotes", [{}])
            usd = next((q for q in quotes if q.get("name") == "USD"), {})
            coins.append({
                "symbol":     c.get("symbol", ""),
                "name":       c.get("name", ""),
                "cmc_rank":   c.get("cmcRank", 9999),
                "market_cap": usd.get("marketCap", 0) or 0,
                "volume_24h": usd.get("volume24h", 0) or 0,
                "price":      usd.get("price", 0) or 0,
            })

        start += batch
        if start > limit:
            break
        time.sleep(0.3)

    return coins


def fetch_cmc_pro_normalised(raw_list):
    """Normalise CMC Pro API response to flat dicts."""
    out = []
    for c in raw_list:
        q = c.get("quote", {}).get("USD", {})
        out.append({
            "symbol":     c.get("symbol", ""),
            "name":       c.get("name", ""),
            "cmc_rank":   c.get("cmc_rank", 9999),
            "market_cap": q.get("market_cap", 0) or 0,
            "volume_24h": q.get("volume_24h", 0) or 0,
            "price":      q.get("price", 0) or 0,
        })
    return out


def upsert_coins(conn, coins, kraken_pairs):
    """Upsert coins into the DB, flagging which have a Kraken USD pair."""
    import time as _time
    now = int(_time.time())

    # Build a lookup: symbol → kraken pair (e.g. BTC → BTCUSD)
    symbol_to_pair = {}
    for pair in kraken_pairs:
        # Strip USD suffix
        sym = pair[:-3]   # e.g. BTCUSD → BTC
        symbol_to_pair[sym] = pair

    rows = []
    for c in coins:
        sym = c["symbol"].upper()
        rows.append((
            sym,
            c["name"],
            c["cmc_rank"],
            c["market_cap"],
            c["volume_24h"],
            c["price"],
            symbol_to_pair.get(sym),   # None if not on Kraken
            now,
        ))

    conn.executemany("""
        INSERT INTO coins (symbol, name, cmc_rank, market_cap_usd, volume_24h_usd,
                           price_usd, kraken_pair, last_updated)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(symbol) DO UPDATE SET
            name           = excluded.name,
            cmc_rank       = excluded.cmc_rank,
            market_cap_usd = excluded.market_cap_usd,
            volume_24h_usd = excluded.volume_24h_usd,
            price_usd      = excluded.price_usd,
            kraken_pair    = excluded.kraken_pair,
            last_updated   = excluded.last_updated
    """, rows)
    conn.commit()
    return len(rows)


def print_summary(conn):
    cur = conn.execute("SELECT COUNT(*) FROM coins")
    total = cur.fetchone()[0]
    cur = conn.execute("SELECT COUNT(*) FROM coins WHERE kraken_pair IS NOT NULL")
    on_kraken = cur.fetchone()[0]
    cur = conn.execute("""
        SELECT symbol, name, cmc_rank, volume_24h_usd, kraken_pair
        FROM coins WHERE kraken_pair IS NOT NULL AND cmc_rank <= 100
        ORDER BY cmc_rank LIMIT 20
    """)
    print(f"\n  Coins in DB: {total:,}  |  Available on Kraken: {on_kraken}")
    print(f"\n  Top-100 CMC coins available on Kraken (sample):")
    print(f"  {'Rank':>5}  {'Symbol':<10} {'Name':<20} {'24h Vol':>15}  {'Pair'}")
    print(f"  {'─'*5}  {'─'*10} {'─'*20} {'─'*15}  {'─'*12}")
    for row in cur.fetchall():
        sym, name, rank, vol, pair = row
        vol_str = f"${vol/1e6:.1f}M" if vol >= 1e6 else f"${vol/1e3:.0f}K"
        print(f"  {rank:>5}  {sym:<10} {name:<20} {vol_str:>15}  {pair}")


def main():
    parser = argparse.ArgumentParser(description="Fetch CMC data into kraken.db")
    parser.add_argument("--api-key", default="", help="CMC Pro API key (optional)")
    parser.add_argument("--limit",   type=int, default=500, help="Number of coins to fetch (default 500)")
    args = parser.parse_args()

    print("=" * 60)
    print("  CoinMarketCap → SQLite  (coins table)")
    print("=" * 60)

    # Get Kraken pairs from ZIP
    print("\n📦  Scanning Kraken ZIP for available pairs …")
    kraken_pairs = get_kraken_pairs_from_zip()
    print(f"    {len(kraken_pairs)} Kraken USD pairs found")

    # Setup DB
    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    # Fetch CMC data
    if args.api_key:
        print(f"\n🌐  Fetching CMC data via Pro API (limit={args.limit}) …")
        try:
            raw = fetch_cmc_pro(args.api_key, args.limit)
            coins = fetch_cmc_pro_normalised(raw)
        except Exception as e:
            print(f"  ❌  Pro API failed: {e}")
            sys.exit(1)
    else:
        print(f"\n🌐  Fetching CMC data via public endpoint (limit={args.limit}, no key required) …")
        coins = fetch_cmc_free(args.limit)

    if not coins:
        print("❌  No coin data received. Check your connection or try --api-key.")
        conn.close()
        sys.exit(1)

    print(f"    Received {len(coins)} coins from CMC")

    # Upsert
    n = upsert_coins(conn, coins, kraken_pairs)
    print(f"✅  Upserted {n} coins into DB")

    print_summary(conn)
    conn.close()
    print(f"\n🎯  Done. Restart api.py to expose the new /api/coins endpoint.\n")


if __name__ == "__main__":
    main()

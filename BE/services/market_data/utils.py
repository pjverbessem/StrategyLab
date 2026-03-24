from datetime import datetime, timezone

# ── Live price cache (TTL = 10 s) ────────────────────────────────────────────
_price_cache: dict    = {}
_price_cache_ts: dict = {}
PRICE_CACHE_TTL       = 10  # seconds

COINGECKO_IDS = {
    "ARBUSD":  "arbitrum",
    "OPUSD":   "optimism",
    "STRKUSD": "starknet",
    "ZKUSD":   "zksync",
    "BTCUSD":  "bitcoin",
    "ETHUSD":  "ethereum",
    "SOLUSD":  "solana",
}


def ts2date(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def fmt(n: float) -> str:
    if n >= 1e9:
        return f"{n / 1e9:.2f}B"
    if n >= 1e6:
        return f"{n / 1e6:.0f}M"
    return str(int(n))

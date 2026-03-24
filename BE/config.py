from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
DB_PATH  = BASE_DIR / "data" / "kraken.db"

PAIR_COLORS = {
    "ARBUSD":  "#0891b2",
    "OPUSD":   "#dc2626",
    "STRKUSD": "#7c3aed",
    "ZKUSD":   "#2563eb",
}

PAIR_NAMES = {
    "ARBUSD":  "Arbitrum",
    "OPUSD":   "Optimism",
    "STRKUSD": "Starknet",
    "ZKUSD":   "ZKsync Era",
}

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

GEMINI_MODEL = "gemini-2.5-flash"

# ── Optional dependency flags ────────────────────────────────────────────────
try:
    import pandas as pd  # noqa: F401
    HAS_PANDAS = True
except ImportError:
    HAS_PANDAS = False

try:
    from google import genai as google_genai  # noqa: F401
    HAS_GEMINI = True
except ImportError:
    HAS_GEMINI = False

try:
    import requests  # noqa: F401
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

try:
    from data_sources import (  # noqa: F401
        BinanceConnector, OKXConnector, BybitConnector,
        CoinbaseConnector, HyperliquidConnector, DYDXConnector,
        CoinGeckoConnector, CoinMarketCapConnector, CoinglassConnector,
        MessariConnector, DefiLlamaConnector,
    )
    HAS_DS = True
except ImportError:
    HAS_DS = False

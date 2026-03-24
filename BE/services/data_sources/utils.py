import os

from config import HAS_DS

# ── Exchange metadata ─────────────────────────────────────────────────────────
EXCHANGE_META = {
    "kraken":      {"name": "Kraken",      "icon": "K",  "color": "#5741d9", "pairs_hint": "BTC/USD, ETH/USD…",  "key_required": False, "description": "OHLCVT · 300+ pairs · data from 2018"},
    "binance":     {"name": "Binance",     "icon": "B",  "color": "#f0b90b", "pairs_hint": "BTCUSDT…",          "key_required": False, "description": "OHLCVT · 2000+ pairs · global leader"},
    "okx":         {"name": "OKX",         "icon": "O",  "color": "#1a56db", "pairs_hint": "BTC-USDT…",         "key_required": False, "description": "OHLCVT · funding rates · 500+ pairs"},
    "bybit":       {"name": "Bybit",       "icon": "By", "color": "#f7a600", "pairs_hint": "BTCUSDT…",          "key_required": False, "description": "OHLCVT · perpetuals · 400+ pairs"},
    "coinbase":    {"name": "Coinbase",    "icon": "C",  "color": "#0052ff", "pairs_hint": "BTC-USD…",           "key_required": False, "description": "OHLCVT · US regulated · 200+ pairs"},
    "hyperliquid": {"name": "Hyperliquid", "icon": "H",  "color": "#4ade80", "pairs_hint": "BTC, ETH…",          "key_required": False, "description": "OHLCVT · DEX perps · funding data"},
    "dydx":        {"name": "dYdX",        "icon": "D",  "color": "#6c7c99", "pairs_hint": "BTC-USD…",           "key_required": False, "description": "OHLCVT · v4 DEX · perpetuals"},
}

SUPPLEMENTARY_META = {
    "coingecko":     {"name": "CoinGecko",     "icon": "CG", "color": "#8dc63f", "key_env": "COINGECKO_API_KEY",  "key_required": False, "description": "Price · market cap · dominance · OHLCV (90-day free)"},
    "coinmarketcap": {"name": "CoinMarketCap", "icon": "CM", "color": "#16c784", "key_env": "CMC_API_KEY",        "key_required": True,  "description": "Prices · rankings · market cap · 333 req/day free"},
    "coinglass":     {"name": "Coinglass",     "icon": "GL", "color": "#e64484", "key_env": "COINGLASS_API_KEY", "key_required": True,  "description": "Funding rates · OI · liquidations · L/S ratio"},
    "messari":       {"name": "Messari",       "icon": "MS", "color": "#0f62fe", "key_env": "MESSARI_API_KEY",   "key_required": True,  "description": "On-chain metrics · asset profiles · timeseries"},
    "defillama":     {"name": "DefiLlama",     "icon": "DL", "color": "#2172e5", "key_env": None,                "key_required": False, "description": "TVL · yields · stablecoins · token unlocks"},
    "feargreed":     {"name": "Fear & Greed",  "icon": "FG", "color": "#f87171", "key_env": None,                "key_required": False, "description": "Daily sentiment index · local DB cached"},
}

SUPP_DATA_TYPES = {
    "coingecko":     ["Market Data (top coins)", "Price Chart (Bitcoin)", "Global Stats"],
    "coinmarketcap": ["Latest Quotes (top coins)", "Global Metrics"],
    "coinglass":     ["Funding Rates", "Open Interest", "Liquidations", "Long/Short Ratio"],
    "messari":       ["Asset Metrics", "Price Timeseries"],
    "defillama":     ["Protocol TVL", "Chain TVL", "Yield Pools", "Stablecoins"],
    "feargreed":     ["Index History"],
}

EXCHANGE_DEFAULT_PAIRS = {
    "binance":     "BTCUSDT",
    "okx":         "BTC-USDT",
    "bybit":       "BTCUSDT",
    "coinbase":    "BTC-USD",
    "hyperliquid": "BTC",
    "dydx":        "BTC-USD",
    "kraken":      "BTCUSD",
}

# ── Connector maps (populated if HAS_DS) ─────────────────────────────────────
if HAS_DS:
    from data_sources import (
        BinanceConnector, OKXConnector, BybitConnector,
        CoinbaseConnector, HyperliquidConnector, DYDXConnector,
        CoinGeckoConnector, CoinMarketCapConnector, CoinglassConnector,
        MessariConnector, DefiLlamaConnector,
    )
    EXCHANGE_CONNECTORS: dict = {
        "binance":     BinanceConnector,
        "okx":         OKXConnector,
        "bybit":       BybitConnector,
        "coinbase":    CoinbaseConnector,
        "hyperliquid": HyperliquidConnector,
        "dydx":        DYDXConnector,
    }
    SUPP_CONNECTORS: dict = {
        "coingecko":     CoinGeckoConnector,
        "coinmarketcap": CoinMarketCapConnector,
        "coinglass":     CoinglassConnector,
        "messari":       MessariConnector,
        "defillama":     DefiLlamaConnector,
    }
else:
    EXCHANGE_CONNECTORS: dict = {}
    SUPP_CONNECTORS: dict     = {}

# ── Pairs cache ───────────────────────────────────────────────────────────────
_pairs_cache: dict    = {}
_pairs_cache_ts: dict = {}
PAIRS_CACHE_TTL       = 600  # seconds

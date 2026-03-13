#!/usr/bin/env python3
"""
fetch_news.py — Crypto News Sentinel & Email Alerter  (v2 — noise-filtered)
─────────────────────────────────────────────────────────────────────────────
Polls global news feeds every N minutes, matches headlines to up to 300 coins,
applies a two-layer quality filter, and only emails you on genuinely material
events — cutting out the TA / price-prediction noise.

Alert tiers
  TIER 1  High-value event keyword  +  |sentiment| ≥ 0.45  →  alert
  TIER 2  No keyword but |sentiment| ≥ 0.80 (extreme raw signal) →  alert
  SKIP    Technical analysis / price prediction / weekly strategy / etc.
  SKIP    Anything below the above thresholds

Sources (global fetch + per-article coin matching — ~12 API calls total):
  • CryptoCompare /v2/news   (global latest — best coin metadata)
  • CoinDesk RSS
  • Cointelegraph RSS
  • Decrypt RSS
  • Google News: 4 macro queries  (Fed, SEC/regulation, hack/exploit, market)

Setup:
    pip install feedparser vaderSentiment requests
    python src/fetch_news.py --setup          # interactive config wizard
    python src/fetch_news.py --test-email     # send a test alert
    python src/fetch_news.py                  # single scan, then exit
    python src/fetch_news.py --loop           # daemon (runs forever)
    python src/fetch_news.py --loop --coins BTC,ETH,ARB  # override coins

Config  : src/config/alerts.json
DB table: data/kraken.db  →  news
"""

import argparse
import getpass
import json
import re
import smtplib
import sqlite3
import sys
import time
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Optional

# ── Auto-install missing deps ──────────────────────────────────────────────────
def _ensure(pkg: str, import_as: Optional[str] = None) -> None:
    try:
        __import__(import_as or pkg)
    except ImportError:
        import subprocess
        print(f"[setup] pip install {pkg} …")
        subprocess.check_call([sys.executable, "-m", "pip", "install", pkg, "-q"])

_ensure("feedparser")
_ensure("requests")
_ensure("vaderSentiment", "vaderSentiment")

import feedparser                                                          # noqa
import requests                                                            # noqa
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer      # noqa

# ── Paths ──────────────────────────────────────────────────────────────────────
ROOT     = Path(__file__).parent.parent          # DefiLlama + Kraken/
DB_PATH  = ROOT / "data" / "kraken.db"
CFG_PATH = ROOT / "src" / "config" / "alerts.json"

HEADERS  = {"User-Agent": "Mozilla/5.0 (compatible; StrategyLabBot/2.0)"}
VADER    = SentimentIntensityAnalyzer()

# ── Noise patterns — articles matching any of these are SILENTLY DISCARDED ────
# These cover crypto TA spam AND price-movement articles (sell-offs, % swings).
# We want ROOT CAUSE events, not price consequences.
NOISE_RE = re.compile(
    r"(?i)("
    r"technical\s+analysis"
    r"|price\s+(analysis|prediction|forecast|target|levels?)"
    r"|support\s+(and\s+)?resistance"
    r"|weekly\s+(strategy|analysis|update|roundup|outlook)"
    r"|monthly\s+(analysis|update|roundup|outlook)"
    r"|\bta:\s"
    r"|what\s+to\s+expect\s+(this\s+week|next\s+week)"
    r"|top\s+\d+\s+crypto"
    r"|crypto\s+market\s+wrap"
    r"|market\s+update"
    r"|price\s+action"
    r"|analyst\s+says?\s+\$"
    r"|could\s+reach\s+\$"
    r"|year\s+end\s+target"
    r")"
)

# ── Price-movement noise — articles whose MAIN SUBJECT is a price swing ───────
# (sell-offs, rallies, % drops) — these are consequences we don't want.
# Root-cause articles (hacks, lawsuits) occasionally mention prices too;
# we key on the structure "[price verb] amid/as/on [price context]".
PRICE_MOVEMENT_RE = re.compile(
    r"(?i)("
    # Direct %-move as subject
    r"\b(drop|fall|tumble|decline|slide|dip|sink|crash|plummet)s?.{0,25}\d+\s*%"
    r"|\d+\s*%.{0,20}\b(drop|fall|tumble|decline|slide|crash|plummet)"
    # Sell-off / buy articles
    r"|\b(massive|major|huge|sharp|steep)\s+(sell.?off|selloff|decline|downturn|correction|pullback)"
    r"|sell.?off\s+(drives?|push|send|cause|amid|as)"
    # Pure rally/surge — with or without %
    r"|\b(rally|surge|soar|jump|spike|skyrocket|rocket)s?.{0,20}\d+\s*%"
    r"|\b(soars?|rockets?|skyrockets?)\b.{0,40}(bitcoin|btc|ethereum|eth|crypto|coin|token|market)"
    r"|(bitcoin|btc|ethereum|eth|crypto).{0,30}\b(soars?|rockets?|remarkable\s+rally|propels)\b"
    r"|remarkable\s+rally|propels\s+btc|bitcoin\s+soars"
    # "BTC hits $X" price-level headlines
    r"|bitcoin.{0,20}(hits?|reaches?|touches?|climbs?\s+to).{0,10}\$\d+[kKmMbB]?"
    # Explicit market-move headlines
    r"|crypto.{0,20}(dip|pullback|correction|rebound|recovery|bounce)"
    r"|market.{0,20}(sell.?off|recovery|rebound|correction|pressure|downturn)"
    r"|altcoin.{0,20}(dump|bleed|tumble|crumble|fall)"
    # "X drops/rises amid Y" where X is a major coin
    r"|\b(bitcoin|ethereum|solana|bnb|xrp|cardano).{0,20}(dips?|drops?|falls?|rises?|climbs?|gains?|loses?)\b"
    r")"
)

# ── Crypto high-value event patterns ─────────────────────────────────────────
# These are ROOT CAUSE events — actions done BY someone TO an asset/system.
# Price-effect articles (sell-offs, % drops, rallies) are handled separately.
HIGH_VALUE_RES = [
    (re.compile(r"(?i)\bhack(ed|er|ing|s)?\b|\bexploit(ed|s)?\b|\bvulnerabilit|\bbreach\b|\bstolen\b.{0,20}(fund|token|coin|wallet|key)"), "🔓 Security Breach"),
    (re.compile(r"(?i)\brug\s*pull\b|\bscam(med)?\b|\bfraud\b|\bponzi\b"),           "🚨 Scam/Fraud"),
    (re.compile(r"(?i)\bSEC\b|\bCFTC\b|\bDOJ\b|\bFinCEN\b"),                        "⚖️  Regulatory Action"),
    (re.compile(r"(?i)\blawsuit\b|\bsued\b|\bcharge[sd]\b|\bindicted?"),             "⚖️  Legal Action"),
    (re.compile(r"(?i)\bfined?\b|\bpenalt|\bban(ned)?\b|\bprohibit"),               "🚫 Enforcement"),
    (re.compile(r"(?i)\bbankruptcy\b|\binsolven|\bchapter\s+11\b"),                  "💀 Bankruptcy"),
    (re.compile(r"(?i)\bseized?\b|\bconfiscat|\bfrozen?\b|\barrested?\b"),           "🚔 Assets Seized"),
    (re.compile(r"(?i)\bETF\s+(approved?|rejected?|filed|launch)"),                  "📈 ETF Decision"),
    (re.compile(r"(?i)\blisted\s+on\b|\bnew\s+listing\b|\bdelisting\b|\bdelisted"), "📋 Exchange Listing"),
    (re.compile(r"(?i)\bacquisition\b|\bacquired\b|\bmerger?\b"),                   "🤝 Acquisition/Merger"),
    (re.compile(r"(?i)\binsider\s+trad|\bmarket\s+manipulat"),                      "🕵️  Insider Trading"),
    (re.compile(r"(?i)\bmajor\s+(upgrade|update|announc|milestone)\b"),              "📣 Major Announcement"),
    (re.compile(r"(?i)\blaunch(ed|ing)?\s+(mainnet|testnet|protocol|platform)"),    "🚀 Protocol Launch"),
    (re.compile(r"(?i)\bsanction(s)?\b"),                                            "🚫 Sanctions"),
    (re.compile(r"(?i)\bbridge\s+(hack|exploit|attack|drain)"),                     "🔓 Bridge Attack"),
    (re.compile(r"(?i)\bflash\s+loan\s+(attack|exploit)"),                          "🔓 Flash Loan Attack"),
    (re.compile(r"(?i)\bdrain(ed|ing)?\s+(wallet|fund|pool|treasury)"),              "🔓 Wallet Drained"),
    (re.compile(r"(?i)\bprivate\s+key\s+(leak|expos|compromis|stolen)"),             "🔓 Key Compromise"),
    (re.compile(r"(?i)\bexchange.{0,20}(halt|suspend|freez|shut|down|insolv)"),      "🚔 Exchange Halt"),
    (re.compile(r"(?i)\bstablecoin.{0,20}(depeg|de-peg|break|lose.{0,10}peg)"),     "💸 Stablecoin Depeg"),
]

# ── Geopolitical / macro high-value patterns (separate stream) ────────────────
MACRO_HIGH_VALUE_RES = [
    (re.compile(r"(?i)\bwar\b|\binvasion\b|\bmilitary\s+(strike|attack|offensive|operation)\b"), "⚔️  War/Military"),
    (re.compile(r"(?i)\bnuclear\b|\bweapon(s)?\b.{0,30}\b(deploy|launch|threat)"),              "☢️  Nuclear"),
    (re.compile(r"(?i)\bnato\b|\bun\s+(resolution|security\s+council|vote|sanction)"),           "🌍 International"),
    (re.compile(r"(?i)\bcoup\b|\bgovernment\s+(collapse|fall|resign)|\bprime\s+minister.{0,25}(resign|sack|fired|oust)"), "🏛  Political Crisis"),
    (re.compile(r"(?i)\bFed(eral\s+Reserve)?\s+(chair|governor|official).{0,30}(resign|fired|replaced|depart|oust)"),     "🏦 Fed Leadership"),
    (re.compile(r"(?i)\bfederal\s+reserve.{0,30}(emergency|crisis|historic|unprecedented)"),    "🏦 Fed Crisis"),
    (re.compile(r"(?i)\bsanction(s)?|\btrade\s+war\b|\btariff.{0,20}(imposed|raise|escalat)"),  "🚫 Sanctions/Trade"),
    (re.compile(r"(?i)\bembargo\b"),                                                             "🚫 Embargo"),
    (re.compile(r"(?i)\bglobal\s+recession|\bfinancial\s+(crisis|meltdown|contagion)"),          "📉 Systemic Crisis"),
    (re.compile(r"(?i)\bterror(ist)?\s+(attack|bomb|shoot)|\bmass\s+(shooting|casualt)"),        "🚨 Security Event"),
    (re.compile(r"(?i)\belection.{0,20}(disputed|stolen|crisis|fraud|annulled)"),               "🗳  Election Crisis"),
    (re.compile(r"(?i)\bdefault.{0,20}(sovereign|nation|country|government)"),                  "💀 Sovereign Default"),
    (re.compile(r"(?i)\bblockade\b|\bpandemic\b|\blockdown.{0,20}(global|major|nationwide)"),   "🌐 Global Event"),
]

# ── Macro noise filter — routine economic data we do NOT want ─────────────────
# (interest-rate speculation, CPI/PPI releases, jobs reports, earnings calls)
MACRO_NOISE_RE = re.compile(
    r"(?i)("
    r"interest\s+rates?\s+(steady|unchanged|hold|expected|forecast|cut\s+expected|hike\s+expected)"
    r"|inflation\s+(data|rate|cpi|pce|report|figures?|expectations?)"
    r"|consumer\s+price\s+index"
    r"|nonfarm\s+payroll|jobs\s+(report|data|numbers|added)"
    r"|gdp\s+(growth|data|report|figures?|reading)"
    r"|earnings\s+(report|call|results?|season)"
    r"|weekly\s+(jobless|unemployment|claims)"
    r"|retail\s+sales\s+(data|report)"
    r"|pmi\s+(data|reading|report)"
    r")"
)

# ── Fallback coin name map (for sources without coin tags) ─────────────────────
FALLBACK_NAMES: dict = {
    "BTC": "Bitcoin", "ETH": "Ethereum", "SOL": "Solana",
    "ARB": "Arbitrum", "OP": "Optimism", "LINK": "Chainlink",
    "ADA": "Cardano", "XRP": "Ripple", "AVAX": "Avalanche",
    "DOT": "Polkadot", "MATIC": "Polygon", "ATOM": "Cosmos",
    "UNI": "Uniswap", "AAVE": "Aave", "LTC": "Litecoin",
    "BCH": "Bitcoin Cash", "BNB": "BNB Binance", "DOGE": "Dogecoin",
    "TRX": "TRON", "ZK": "zkSync", "STRK": "StarkNet",
    "NEAR": "NEAR Protocol", "APT": "Aptos", "SUI": "Sui",
    "INJ": "Injective", "MKR": "MakerDAO",
}

# ── Default config ─────────────────────────────────────────────────────────────
DEFAULT_CONFIG: dict = {
    "smtp": {"host": "smtp.gmail.com", "port": 587, "user": "", "password": "", "from_name": "Strategy Lab"},
    "alert_to": "",
    "thresholds": {
        "high_value_min_sentiment": 0.45,   # sentiment required when a high-value keyword triggered
        "extreme_sentiment":        0.80,   # alert without keyword if sentiment this extreme
    },
    "watch_top_n_cmc":          300,        # watch top-N coins from CMC rankings in DB
    "max_alerts_per_hour":       15,        # circuit breaker — cap total alerts/hour
    "max_article_age_hours":     24,        # skip articles older than this
    "sources": {
        "cryptocompare":      True,
        "coindesk_rss":       True,
        "cointelegraph_rss":  True,
        "decrypt_rss":        True,
        "reuters_rss":        True,
        "bbc_rss":            True,
        "crypto_google_news": True,
        "macro_google_news":  True,
    },
    "interval_seconds":          300,
    "cryptocompare_api_key":      "",
}


# ══════════════════════════════════════════════════════════════════════════════
# CONFIG
# ══════════════════════════════════════════════════════════════════════════════

def load_config() -> dict:
    CFG_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not CFG_PATH.exists():
        CFG_PATH.write_text(json.dumps(DEFAULT_CONFIG, indent=2))
        print(f"[config] Created → {CFG_PATH}  (run --setup to configure email)")
    return json.loads(CFG_PATH.read_text())


def save_config(cfg: dict) -> None:
    CFG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CFG_PATH.write_text(json.dumps(cfg, indent=2))
    print(f"[config] Saved → {CFG_PATH}")


# ══════════════════════════════════════════════════════════════════════════════
# DATABASE
# ══════════════════════════════════════════════════════════════════════════════

def init_db(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS news (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            fetched_at       INTEGER NOT NULL,
            published_at     INTEGER,
            coin             TEXT,
            source           TEXT,
            headline         TEXT NOT NULL,
            summary          TEXT,
            url              TEXT UNIQUE,
            sentiment        REAL,
            label            TEXT,
            category         TEXT,
            stream           TEXT,
            importance_level INTEGER,
            importance_label TEXT,
            alert_sent       INTEGER DEFAULT 0
        )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_news_coin    ON news(coin)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_news_fetched ON news(fetched_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_news_label   ON news(label)")
    # Migrate existing tables that are missing new columns
    existing = {r[1] for r in conn.execute("PRAGMA table_info(news)").fetchall()}
    for col, typ in [("category","TEXT"), ("stream","TEXT"),
                     ("importance_level","INTEGER"), ("importance_label","TEXT")]:
        if col not in existing:
            conn.execute(f"ALTER TABLE news ADD COLUMN {col} {typ}")
    conn.commit()


def url_seen(conn: sqlite3.Connection, url: str) -> bool:
    return conn.execute("SELECT 1 FROM news WHERE url=?", (url,)).fetchone() is not None


def count_recent_alerts(conn: sqlite3.Connection, since_ts: int) -> int:
    r = conn.execute("SELECT COUNT(*) FROM news WHERE alert_sent=1 AND fetched_at>=?", (since_ts,)).fetchone()
    return r[0] if r else 0


def insert_article(conn: sqlite3.Connection, a: dict) -> None:
    conn.execute("""
        INSERT OR IGNORE INTO news
          (fetched_at, published_at, coin, source, headline, summary,
           url, sentiment, label, category, alert_sent)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (a["fetched_at"], a.get("published_at"), a.get("coin"), a.get("source"),
         a["headline"], a.get("summary", "")[:600], a.get("url"),
         a.get("sentiment"), a.get("label"), a.get("category"), 1 if a.get("alert_sent") else 0),
    )
    conn.commit()


def load_watched_coins(conn: sqlite3.Connection, top_n: int = 300) -> list:
    """Load top-N coins from CMC rankings stored in the DB."""
    try:
        rows = conn.execute(
            "SELECT symbol, name FROM coins WHERE cmc_rank IS NOT NULL ORDER BY cmc_rank LIMIT ?",
            (top_n,)
        ).fetchall()
        return [{"symbol": r[0], "name": r[1]} for r in rows]
    except Exception:
        # Fallback if coins table not populated yet
        return [{"symbol": s, "name": n} for s, n in FALLBACK_NAMES.items()]


# ══════════════════════════════════════════════════════════════════════════════
# COIN MATCHING
# ══════════════════════════════════════════════════════════════════════════════

def build_coin_patterns(coins: list) -> list:
    """
    Build (compiled_regex, symbol) pairs for fast headline matching.
    Short symbols (< 3 chars) and very generic names are skipped to avoid
    false positives (e.g. "AB", "AI", "IT" would match everywhere).
    """
    patterns = []
    skip_symbols = {"IT", "AI", "GO", "IO", "OR", "DO", "BY", "UP"}
    for c in coins:
        sym  = (c.get("symbol") or "").strip().upper()
        name = (c.get("name")   or "").strip()
        # Full name match (case-insensitive) — reliable
        if name and len(name) >= 4:
            patterns.append((re.compile(r"(?i)\b" + re.escape(name) + r"\b"), sym))
        # Symbol match — require ≥ 3 chars and not in skip list
        if sym and len(sym) >= 3 and sym not in skip_symbols:
            patterns.append((re.compile(r"\b" + re.escape(sym) + r"\b"), sym))
    return patterns


def find_coins_in_text(text: str, patterns: list) -> set:
    """Return set of coin symbols mentioned in text."""
    found = set()
    for pattern, sym in patterns:
        if pattern.search(text):
            found.add(sym)
    return found


# ══════════════════════════════════════════════════════════════════════════════
# NOISE & QUALITY FILTERS
# ══════════════════════════════════════════════════════════════════════════════

def is_price_movement_noise(headline: str) -> bool:
    """True if the headline's main subject is a price swing, not a root-cause event."""
    return bool(PRICE_MOVEMENT_RE.search(headline))


def is_noise(headline: str) -> bool:
    """True if headline is low-value TA/prediction spam or a price-movement article."""
    return bool(NOISE_RE.search(headline)) or is_price_movement_noise(headline)


def is_macro_noise(headline: str) -> bool:
    """True if headline is routine macro data (CPI, jobs, earnings) — not a crisis."""
    return bool(MACRO_NOISE_RE.search(headline))


def classify_article(headline: str, summary: str, coin_patterns: list) -> str:
    """
    Returns 'MACRO' if the article is geopolitical/macro with no specific coin,
    or a coin symbol if the article is clearly about one coin.
    Articles about multiple coins → 'MACRO'.
    """
    text  = headline + " " + (summary or "")
    coins = find_coins_in_text(text, coin_patterns)
    # If exactly one coin mentioned → crypto article for that coin
    if len(coins) == 1:
        return next(iter(coins))
    # Check if any macro/geo pattern fires first
    for pattern, _ in MACRO_HIGH_VALUE_RES:
        if pattern.search(text):
            return "MACRO"
    # No coin, no macro → treat as MACRO (generic industry news)
    return "MACRO" if not coins else "MULTI"


# ── Importance scoring (1–5) ───────────────────────────────────────────────────
_CRITICAL_RE = re.compile(
    r"(?i)("
    r"\bwar\b|\binvasion\b|\bnuclear\b"
    r"|government\s+collapse|coup\b"
    r"|global\s+recession|financial\s+(crisis|meltdown)"
    r"|sovereign\s+default"
    r"|stablecoin.{0,15}(depeg|collapse)"
    r"|exchange.{0,20}(bankrupt|insol|halt|collapse)"
    r"|Fed(eral\s+Reserve)?.{0,20}(resign|fired|oust)"
    r"|\.{0,5}billion.{0,15}hack"
    r")"
)
_URGENT_RE = re.compile(
    r"(?i)("
    r"\bSEC\b|\bCFTC\b|\bDOJ\b|\bindicted?\b|\barrested?\b"
    r"|\bsanction|\bembargo\b"
    r"|ETF\s+(approved?|rejected?)"
    r"|major\s+hack|\bexploit(ed)?\b"
    r"|prime\s+minister.{0,25}(resign|fired|oust)"
    r"|\btrade\s+war\b"
    r"|bankruptcy\b|insolvency\b"
    r"|NATO\b|military\s+strike"
    r")"
)
_HIGH_RE = re.compile(
    r"(?i)("
    r"\bsanction|\bpartnersh|\bacquisition\b"
    r"|\btrade\s+tariff|\bgeopolit"
    r"|listing\b|delisting\b"
    r"|\bupgrade\b|mainnet\s+launch"
    r"|\bcrash\b|\bsoar\b|\bsurge\b|\bplummet"
    r"|\bfraud\b|\brug\s+pull\b"
    r"|\blawsuit\b|\bsued\b"
    r")"
)

IMPORTANCE_BARS = {
    5: "🚨🚨🚨🚨🚨 CRITICAL",
    4: "🔴🔴🔴🔴◻️ URGENT",
    3: "🟠🟠🟠◻️◻️ HIGH",
    2: "🟡🟡◻️◻️◻️ MEDIUM",
    1: "⬜◻️◻️◻️◻️ LOW",
}


def importance_level(headline: str, summary: str, sentiment: float) -> tuple:
    """Return (level 1-5, display_str) based on keywords + sentiment strength."""
    text = headline + " " + (summary or "")
    s    = abs(sentiment)
    if _CRITICAL_RE.search(text):
        return 5, IMPORTANCE_BARS[5]
    if _URGENT_RE.search(text) and s >= 0.40:
        return 4, IMPORTANCE_BARS[4]
    if _HIGH_RE.search(text) and s >= 0.35:
        return 3, IMPORTANCE_BARS[3]
    if s >= 0.70:
        return 3, IMPORTANCE_BARS[3]
    if s >= 0.50:
        return 2, IMPORTANCE_BARS[2]
    return 1, IMPORTANCE_BARS[1]


def high_value_match_crypto(text: str) -> Optional[str]:
    for pattern, category in HIGH_VALUE_RES:
        if pattern.search(text):
            return category
    return None


def high_value_match_macro(text: str) -> Optional[str]:
    for pattern, category in MACRO_HIGH_VALUE_RES:
        if pattern.search(text):
            return category
    return None


def should_alert(headline: str, summary: str, sentiment: float, article_type: str, cfg: dict) -> tuple:
    """
    Returns (alert: bool, category: str, stream: str).
    stream is 'MACRO' or 'CRYPTO'.

    Decision ladder:
      1. Crypto TA/noise?              → skip
      2. Macro routine data?           → skip
      3. Macro geo high-value kw       → alert as MACRO/GEO
      4. Crypto high-value kw + sent   → alert as CRYPTO
      5. Extreme sentiment (≥0.80)     → alert in relevant stream
      6. Otherwise                     → skip
    """
    t       = cfg.get("thresholds", {})
    hv_min  = t.get("high_value_min_sentiment", 0.45)
    extreme = t.get("extreme_sentiment", 0.80)
    text    = headline + " " + (summary or "")

    is_macro = (article_type == "MACRO")

    # Crypto TA noise
    if not is_macro and is_noise(headline):
        return False, "", "noise"

    # Routine macro data noise
    if is_macro and is_macro_noise(headline):
        return False, "", "macro_noise"

    if is_macro:
        cat = high_value_match_macro(text)
        if cat and abs(sentiment) >= hv_min:
            return True, cat, "MACRO"
        if abs(sentiment) >= extreme:
            return True, "📊 Strong Macro Signal", "MACRO"
    else:
        cat = high_value_match_crypto(text)
        if cat and abs(sentiment) >= hv_min:
            return True, cat, "CRYPTO"
        if abs(sentiment) >= extreme:
            return True, "📊 Strong Signal", "CRYPTO"

    return False, "", "below threshold"


# ══════════════════════════════════════════════════════════════════════════════
# SENTIMENT
# ══════════════════════════════════════════════════════════════════════════════

_HTML_RE = re.compile(r"<[^>]+>")


def clean(text: str) -> str:
    return _HTML_RE.sub(" ", text or "").strip()


def score_sentiment(headline: str, summary: str = "") -> float:
    combined = headline + ". " + (summary or "")[:200]
    return round(VADER.polarity_scores(clean(combined))["compound"], 4)


# ══════════════════════════════════════════════════════════════════════════════
# NEWS FETCHERS  (global feeds — coin matching happens after)
# ══════════════════════════════════════════════════════════════════════════════

def fetch_cryptocompare(api_key: str = "") -> list:
    """CryptoCompare global latest news (includes coin categories in response)."""
    params: dict = {"lang": "EN", "sortOrder": "latest", "limit": 50}
    if api_key:
        params["api_key"] = api_key
    try:
        r = requests.get(
            "https://min-api.cryptocompare.com/data/v2/news/",
            params=params, headers=HEADERS, timeout=12,
        )
        r.raise_for_status()
        articles = []
        for item in r.json().get("Data", []):
            # CryptoCompare includes coin categories — use them directly
            categories = item.get("categories", "")
            coin_tag   = None
            if categories:
                # e.g. "BTC|ETH|Mining" — take first recognisable symbol
                for tag in categories.split("|"):
                    tag = tag.strip().upper()
                    if 2 <= len(tag) <= 6 and tag.isalpha():
                        coin_tag = tag
                        break
            articles.append({
                "source":       "cryptocompare",
                "coin":         coin_tag,
                "headline":     clean(item.get("title", "")),
                "summary":      clean(item.get("body",  ""))[:400],
                "url":          item.get("url", ""),
                "published_at": int(item.get("published_on", 0)) or None,
            })
        return articles
    except Exception as e:
        print(f"  [cc] Error: {e}")
        return []


def fetch_rss(feed_url: str, source_name: str) -> list:
    """Generic RSS / Atom feed fetcher (global — no coin pre-filter)."""
    try:
        feed = feedparser.parse(feed_url, request_headers=HEADERS)
        articles = []
        for entry in feed.entries[:40]:
            pub = None
            if hasattr(entry, "published_parsed") and entry.published_parsed:
                try:
                    pub = int(time.mktime(entry.published_parsed))
                except Exception:
                    pass
            articles.append({
                "source":       source_name,
                "coin":         None,          # matched later
                "headline":     clean(entry.get("title",   "")),
                "summary":      clean(entry.get("summary", ""))[:400],
                "url":          entry.get("link", ""),
                "published_at": pub,
            })
        return articles
    except Exception as e:
        print(f"  [rss] {source_name}: {e}")
        return []


def fetch_google_news(query: str) -> list:
    url = (
        "https://news.google.com/rss/search"
        f"?q={requests.utils.quote(query)}&hl=en-US&gl=US&ceid=US:en"
    )
    return fetch_rss(url, "google_news")


# ══════════════════════════════════════════════════════════════════════════════
# EMAIL
# ══════════════════════════════════════════════════════════════════════════════

def send_email(cfg: dict, subject: str, body: str) -> bool:
    smtp = cfg.get("smtp", {})
    if not smtp.get("user") or not smtp.get("password") or not cfg.get("alert_to"):
        print("  [email] Not configured — run --setup")
        return False
    try:
        msg            = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"]    = f"{smtp.get('from_name','Strategy Lab')} <{smtp['user']}>"
        msg["To"]      = cfg["alert_to"]
        msg.attach(MIMEText(body, "plain"))
        with smtplib.SMTP(smtp["host"], int(smtp["port"])) as s:
            s.ehlo(); s.starttls(); s.login(smtp["user"], smtp["password"])
            s.sendmail(smtp["user"], cfg["alert_to"], msg.as_string())
        print(f"  [email] ✓ {subject[:72]}")
        return True
    except Exception as e:
        print(f"  [email] ✗ {e}")
        return False


def build_alert_email(a: dict) -> tuple:
    s          = a["sentiment"]
    stream     = a.get("stream", "CRYPTO")          # 'MACRO' or 'CRYPTO'
    coin       = a.get("coin") or "MACRO"
    category   = a.get("category", "Alert")
    imp_label  = a.get("importance_label", "")
    direction  = "LONG" if s >= 0 else "SHORT"
    score_str  = f"+{s:.2f}" if s >= 0 else f"{s:.2f}"

    pub = a.get("published_at")
    pub_str = (
        datetime.fromtimestamp(pub, tz=timezone.utc).strftime("%d %b %Y, %H:%M UTC")
        if pub else "Unknown"
    )

    # ── Subject line ──────────────────────────────────────────────────────────
    if stream == "MACRO":
        subject = f"[MACRO/GEO] {imp_label} | {a['headline'][:55]}"
    else:
        subject = f"[CRYPTO | {coin}] {imp_label} | {a['headline'][:50]}"

    # ── Body ──────────────────────────────────────────────────────────────────
    trade_line = (
        f"📊  No direct coin trade signal (macro event)"
        if stream == "MACRO"
        else f"📊  Trade Signal: Consider {direction} {coin}/USD"
    )

    stream_header = (
        "🌍  MACRO / GEOPOLITICAL NEWS"
        if stream == "MACRO"
        else f"💰  CRYPTO NEWS — {coin}"
    )

    body = f"""\
{stream_header}
{imp_label}
{'━' * 56}
Category    : {category}
Sentiment   : {score_str}
Source      : {a.get("source","").replace("_"," ").title()}
Published   : {pub_str}

📰  {a["headline"]}

{'─' * 56}
{a.get("summary","").strip()}
{'─' * 56}

{trade_line}

🔗  {a.get("url","")}
{'━' * 56}
Strategy Lab Alerts · src/config/alerts.json
"""
    return subject, body


# ══════════════════════════════════════════════════════════════════════════════
# MAIN PIPELINE
# ══════════════════════════════════════════════════════════════════════════════

def process_articles(
    conn: sqlite3.Connection,
    cfg: dict,
    articles: list,
    coin_patterns: list,
) -> int:
    now        = int(time.time())
    max_age    = cfg.get("max_article_age_hours", 24) * 3600
    max_hourly = cfg.get("max_alerts_per_hour", 15)
    alerted    = 0

    for a in articles:
        if not a.get("headline") or not a.get("url"):
            continue
        if url_seen(conn, a["url"]):
            continue

        # Freshness check
        pub = a.get("published_at")
        if pub and (now - pub) > max_age:
            continue

        # Classify article as MACRO or specific coin
        art_type = classify_article(a["headline"], a.get("summary", ""), coin_patterns)
        a["coin"] = art_type  # symbol or 'MACRO' or 'MULTI'

        # Score sentiment
        a["fetched_at"] = now
        a["sentiment"]  = score_sentiment(a["headline"], a.get("summary", ""))

        # Importance scoring
        imp_level, imp_label = importance_level(a["headline"], a.get("summary", ""), a["sentiment"])
        a["importance_level"] = imp_level
        a["importance_label"] = imp_label

        # Quality gate (stream-aware)
        effective_type = "MACRO" if art_type in ("MACRO", "MULTI") else "CRYPTO"
        do_alert, category, stream = should_alert(
            a["headline"], a.get("summary", ""), a["sentiment"], effective_type, cfg
        )
        a["category"]   = category
        a["stream"]     = stream
        a["label"]      = "positive" if a["sentiment"] >= 0 else "negative"
        a["alert_sent"] = 0

        if do_alert:
            # Circuit breaker
            hour_ago = now - 3600
            if count_recent_alerts(conn, hour_ago) >= max_hourly:
                print(f"  [rate-limit] {max_hourly}/hr cap reached")
                insert_article(conn, a)
                continue

            subject, body = build_alert_email(a)
            ok = send_email(cfg, subject, body)
            a["alert_sent"] = 1 if ok else 0
            if ok:
                alerted += 1
            sc = f"{'+' if a['sentiment']>=0 else ''}{a['sentiment']:.2f}"
            print(f"  ALERT  {sc}  [{stream:<6}]  {imp_label[:25]}  {a['headline'][:50]}")
        else:
            if stream in ("noise", "macro_noise"):
                continue   # don't store noise

        insert_article(conn, a)

    return alerted


def run_once(cfg: dict) -> None:
    conn     = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    init_db(conn)

    top_n    = cfg.get("watch_top_n_cmc", 300)
    sources  = cfg.get("sources", {})
    cc_key   = cfg.get("cryptocompare_api_key", "")
    all_a: list = []

    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    watched   = load_watched_coins(conn, top_n)
    patterns  = build_coin_patterns(watched)
    print(f"\n[{ts} UTC] Scanning — watching {len(watched)} coins …")

    # 1. CryptoCompare global (coin-tagged)
    if sources.get("cryptocompare", True):
        all_a += fetch_cryptocompare(api_key=cc_key)

    # 2. CoinDesk RSS
    if sources.get("coindesk_rss", True):
        all_a += fetch_rss("https://www.coindesk.com/arc/outboundfeeds/rss/", "coindesk")

    # 3. Cointelegraph RSS
    if sources.get("cointelegraph_rss", True):
        all_a += fetch_rss("https://cointelegraph.com/rss", "cointelegraph")

    # 4. Decrypt RSS
    if sources.get("decrypt_rss", True):
        all_a += fetch_rss("https://decrypt.co/feed", "decrypt")

    # 5. Reuters World news (geopolitical/macro)
    if sources.get("reuters_rss", True):
        all_a += fetch_rss("https://feeds.reuters.com/reuters/worldNews", "reuters")

    # 6. BBC World news (geopolitical)
    if sources.get("bbc_rss", True):
        all_a += fetch_rss("https://feeds.bbci.co.uk/news/world/rss.xml", "bbc")

    # 7. Crypto-specific Google News (enforcement, hacks, ETFs)
    if sources.get("crypto_google_news", True):
        for query in [
            "SEC CFTC crypto cryptocurrency enforcement action lawsuit",
            "crypto hack exploit stolen funds vulnerability",
            "crypto ETF approval rejection stablecoin regulation bill",
        ]:
            all_a += fetch_google_news(query)
            time.sleep(0.4)

    # 8. Geopolitical Google News (wars, coups, major political crises)
    if sources.get("macro_google_news", True):
        for query in [
            "war invasion military conflict sanctions geopolitical",
            "government collapse coup resign prime minister crisis",
            "Federal Reserve chair resign emergency crisis unprecedented",
            "global recession financial crisis default systemic",
        ]:
            all_a += fetch_google_news(query)
            time.sleep(0.4)

    print(f"  Fetched {len(all_a)} raw articles")
    alerted = process_articles(conn, cfg, all_a, patterns)
    print(f"  Alerts sent: {alerted}")
    conn.close()


# ══════════════════════════════════════════════════════════════════════════════
# SETUP WIZARD
# ══════════════════════════════════════════════════════════════════════════════

def setup_wizard() -> None:
    print("\n" + "═" * 56)
    print("  Strategy Lab — News Alert Setup (v2)")
    print("═" * 56)
    print("""
For Gmail:
  1. Enable 2-Factor Authentication on your Google account
  2. Go to myaccount.google.com → Security → App Passwords
  3. Create a new App Password for 'Mail'
  4. Use that 16-character password below (not your login password)

For phone SMS, use your carrier gateway as the 'alert_to' address:
  Verizon  → +1XXXXXXXXXX@vtext.com
  AT&T     → +1XXXXXXXXXX@txt.att.net
  T-Mobile → +1XXXXXXXXXX@tmomail.net
""")
    cfg  = load_config()
    smtp = cfg.setdefault("smtp", {})

    def ask(prompt: str, current: str) -> str:
        val = input(f"{prompt} [{current}]: ").strip()
        return val if val else current

    smtp["host"]      = ask("SMTP host",     smtp.get("host",      "smtp.gmail.com"))
    smtp["port"]      = int(ask("SMTP port", str(smtp.get("port",  587))))
    smtp["user"]      = ask("Your email",    smtp.get("user",      ""))
    smtp["password"]  = getpass.getpass("App password (hidden input): ").strip() or smtp.get("password", "")
    smtp["from_name"] = ask("Sender name",   smtp.get("from_name", "Strategy Lab"))

    cfg["alert_to"] = ask("Send alerts TO", cfg.get("alert_to", ""))

    top_n = ask("Watch top-N CMC coins", str(cfg.get("watch_top_n_cmc", 300)))
    cfg["watch_top_n_cmc"] = int(top_n)

    t = cfg.setdefault("thresholds", {})
    hv  = ask("High-value event min sentiment (0–1, e.g. 0.45)",
              str(t.get("high_value_min_sentiment", 0.45)))
    ext = ask("Extreme sentiment threshold (0–1, e.g. 0.80) ",
              str(t.get("extreme_sentiment", 0.80)))
    t["high_value_min_sentiment"] = float(hv)
    t["extreme_sentiment"]        = float(ext)

    max_h = ask("Max alerts per hour (circuit breaker)", str(cfg.get("max_alerts_per_hour", 15)))
    cfg["max_alerts_per_hour"] = int(max_h)

    ival = ask("Scan interval (seconds)", str(cfg.get("interval_seconds", 300)))
    cfg["interval_seconds"] = int(ival)

    save_config(cfg)
    print("\nSending test email …")
    ok = send_email(cfg, "✅ Strategy Lab Alerts — Active",
        f"News sentinel configured.\n\nWatching top {cfg['watch_top_n_cmc']} CMC coins.\n"
        f"Alert tiers:\n"
        f"  TIER 1  High-value event + |sentiment| ≥ {t['high_value_min_sentiment']}\n"
        f"  TIER 2  Extreme sentiment ≥ {t['extreme_sentiment']} (no keyword needed)\n"
        f"  SKIPPED  Technical analysis / price predictions / TA spam\n\n"
        f"Alerts cap: {cfg['max_alerts_per_hour']}/hour\n"
        f"Scan interval: every {cfg['interval_seconds']}s"
    )
    if ok:
        print("✓ Test email sent!\n")
        print(f"Start daemon:  python src/fetch_news.py --loop")
    else:
        print(f"✗ Email failed. Edit {CFG_PATH}\n")


# ══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--setup",      action="store_true",  help="Interactive email setup wizard")
    ap.add_argument("--test-email", action="store_true",  help="Send a test alert and exit")
    ap.add_argument("--loop",       action="store_true",  help="Run continuously as a daemon")
    ap.add_argument("--interval",   type=int, default=0,  help="Override scan interval (seconds)")
    ap.add_argument("--coins",      type=str, default="", help="Override coins (ignored — watches all CMC coins)")
    args = ap.parse_args()

    if args.setup:
        setup_wizard()
        return

    cfg = load_config()
    if args.interval:
        cfg["interval_seconds"] = args.interval

    if args.test_email:
        ok = send_email(cfg, "✅ Strategy Lab — Test Alert",
            "This is a test alert.\n\nYour noise-filtered news sentinel is correctly configured.")
        sys.exit(0 if ok else 1)

    if args.loop:
        interval = cfg.get("interval_seconds", 300)
        print(f"[daemon] News sentinel v2 — noise-filtered")
        print(f"[daemon] Watching top {cfg.get('watch_top_n_cmc',300)} CMC coins")
        print(f"[daemon] Alerts → {cfg.get('alert_to','(run --setup)')}")
        print(f"[daemon] Interval: {interval}s  |  Max {cfg.get('max_alerts_per_hour',15)} alerts/hr")
        print(f"[daemon] Ctrl+C to stop\n")
        while True:
            try:
                run_once(cfg)
            except KeyboardInterrupt:
                print("\n[daemon] Stopped.")
                break
            except Exception as e:
                print(f"[daemon] Error: {e}")
            time.sleep(interval)
    else:
        run_once(cfg)


if __name__ == "__main__":
    main()

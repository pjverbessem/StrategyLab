import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
DB_PATH  = BASE_DIR / "data" / "kraken.db"


def db():
    c = sqlite3.connect(DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init_db():
    conn = db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS strategies (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            code TEXT NOT NULL,
            algo TEXT DEFAULT '',
            params_text TEXT DEFAULT '',
            pair TEXT DEFAULT '',
            interval INTEGER DEFAULT 1440,
            stats TEXT DEFAULT '{}',
            tags TEXT DEFAULT '[]',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS bot_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            level TEXT NOT NULL,
            msg TEXT NOT NULL,
            meta TEXT DEFAULT '{}'
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ohlcvt (
            pair     TEXT    NOT NULL,
            interval INTEGER NOT NULL,
            ts       INTEGER NOT NULL,
            open     REAL,
            high     REAL,
            low      REAL,
            close    REAL,
            volume   REAL,
            vwap     REAL,
            trades   INTEGER,
            PRIMARY KEY (pair, interval, ts)
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS token_unlocks (
            pair                    TEXT    NOT NULL,
            date                    INTEGER NOT NULL,
            daily_new_tokens        REAL    DEFAULT 0,
            cumulative_tokens       REAL    DEFAULT 0,
            has_cliff_event         INTEGER DEFAULT 0,
            cliff_event_tokens      REAL    DEFAULT 0,
            inflation_pct_of_supply REAL    DEFAULT 0,
            PRIMARY KEY (pair, date)
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS unlock_events (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            pair       TEXT    NOT NULL,
            date       INTEGER NOT NULL,
            category   TEXT    DEFAULT '',
            amount     REAL    DEFAULT 0,
            event_type TEXT    DEFAULT '',
            note       TEXT    DEFAULT ''
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS fear_greed (
            date            TEXT PRIMARY KEY,
            timestamp_utc   INTEGER,
            value           INTEGER,
            classification  TEXT,
            source          TEXT DEFAULT 'alternative.me'
        )""")
    conn.commit()
    conn.close()

import json

from database import db


def fetch_strategy_by_id(strategy_id: str) -> tuple[str, str] | tuple[None, None]:
    """Returns (code, name) or (None, None) if not found."""
    conn = db()
    row  = conn.execute("SELECT code, name FROM strategies WHERE id=?", (strategy_id,)).fetchone()
    conn.close()
    if not row:
        return None, None
    return row["code"], row["name"]


def persist_bot_log(entry: dict):
    conn = db()
    conn.execute(
        "INSERT INTO bot_log (ts, level, msg, meta) VALUES (?, ?, ?, ?)",
        (entry["ts"], entry["level"], entry["msg"], json.dumps(entry.get("meta", {}))),
    )
    conn.commit()
    conn.close()

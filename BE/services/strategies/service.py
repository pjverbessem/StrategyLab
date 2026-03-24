import json
import time
import uuid

from database import db
from services.strategies.utils import parse_strategy_row


def db_list_strategies() -> list:
    conn = db()
    rows = conn.execute("SELECT * FROM strategies ORDER BY updated_at DESC").fetchall()
    conn.close()
    return [parse_strategy_row(dict(r)) for r in rows]


def db_get_strategy(sid: str) -> dict | None:
    conn = db()
    row  = conn.execute("SELECT * FROM strategies WHERE id = ?", (sid,)).fetchone()
    conn.close()
    if not row:
        return None
    return parse_strategy_row(dict(row))


def db_save_strategy(name: str, description: str, code: str, algo: str,
                     params_text: str, pair: str, interval: int,
                     stats: dict, tags: list) -> dict:
    sid = str(uuid.uuid4())
    now = int(time.time())
    conn = db()
    conn.execute("""
        INSERT INTO strategies
          (id, name, description, code, algo, params_text, pair, interval, stats, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (sid, name, description, code, algo, params_text,
          pair, interval, json.dumps(stats), json.dumps(tags), now, now))
    conn.commit()
    conn.close()
    return {"id": sid, "created_at": now}


def db_update_strategy(sid: str, name: str, description: str, code: str, algo: str,
                       params_text: str, pair: str, interval: int,
                       stats: dict, tags: list) -> dict:
    now = int(time.time())
    conn = db()
    conn.execute("""
        UPDATE strategies
        SET name=?, description=?, code=?, algo=?, params_text=?,
            pair=?, interval=?, stats=?, tags=?, updated_at=?
        WHERE id=?
    """, (name, description, code, algo, params_text,
          pair, interval, json.dumps(stats), json.dumps(tags), now, sid))
    conn.commit()
    conn.close()
    return {"updated": True}


def db_delete_strategy(sid: str) -> dict:
    conn = db()
    conn.execute("DELETE FROM strategies WHERE id = ?", (sid,))
    conn.commit()
    conn.close()
    return {"deleted": True}

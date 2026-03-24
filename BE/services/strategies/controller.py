from typing import List

from pydantic import BaseModel

from services.strategies import service


class SaveStrategyRequest(BaseModel):
    name:        str
    description: str       = ""
    code:        str
    algo:        str       = ""
    params_text: str       = ""
    pair:        str       = ""
    interval:    int       = 1440
    stats:       dict      = {}
    tags:        List[str] = []


def list_strategies():
    return service.db_list_strategies()


def get_strategy(sid: str):
    row = service.db_get_strategy(sid)
    if not row:
        return {"error": "Not found"}
    return row


def save_strategy(req: SaveStrategyRequest):
    return service.db_save_strategy(
        req.name, req.description, req.code, req.algo,
        req.params_text, req.pair, req.interval, req.stats, req.tags,
    )


def update_strategy(sid: str, req: SaveStrategyRequest):
    return service.db_update_strategy(
        sid, req.name, req.description, req.code, req.algo,
        req.params_text, req.pair, req.interval, req.stats, req.tags,
    )


def delete_strategy(sid: str):
    return service.db_delete_strategy(sid)

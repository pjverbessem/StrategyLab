from typing import Optional

from pydantic import BaseModel

from services.data_sources import service


class SaveApiKeyRequest(BaseModel):
    key_name:  str
    key_value: str


def get_exchanges():
    return {"exchanges": service.get_exchanges_status()}


def get_data_sources():
    return {"sources": service.get_data_sources_status()}


def get_exchange_pairs(exchange_id: str):
    return service.get_exchange_pairs(exchange_id)


def get_ds_pairs(source_id: str, q: str = ""):
    return service.get_ds_pairs(source_id, q)


def get_ds_data_types(source_id: str):
    return service.get_ds_data_types(source_id)


def get_ds_preview(source_id: str, pair: str = "", data_type: str = ""):
    return service.get_ds_preview(source_id, pair, data_type)


def get_coins(min_rank: Optional[int] = None, max_rank: Optional[int] = None,
              min_volume_24h: Optional[float] = None, min_market_cap: Optional[float] = None,
              kraken_only: bool = True, limit: int = 500):
    return service.get_coins_from_db(min_rank, max_rank, min_volume_24h, min_market_cap, kraken_only, limit)


def save_api_key(req: SaveApiKeyRequest):
    return service.save_api_key(req.key_name, req.key_value)

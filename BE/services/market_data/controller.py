from typing import Optional

from services.market_data import service


def get_pairs():
    return service.get_pairs()


def get_ohlcvt(pair: str, interval: int, start: Optional[str], end: Optional[str]):
    return service.get_ohlcvt(pair, interval, start, end)


def get_unlocks(pair: str):
    return service.get_unlocks(pair)


def get_unlock_events(pair: str):
    return service.get_unlock_events(pair)


def get_upcoming_cliffs(days: int):
    return service.get_upcoming_cliffs(days)


def get_db_summary():
    return service.get_db_summary()


def get_fear_greed_latest():
    return service.get_fear_greed_latest()


def get_fear_greed_history(start: Optional[str], end: Optional[str], limit: int):
    return service.get_fear_greed_history(start, end, limit)


def get_live_price(pair: str):
    return service.fetch_live_price(pair)


def get_live_prices(pairs: str):
    pair_list = [p.strip().upper() for p in pairs.split(",")]
    return {pair: service.fetch_live_price(pair) for pair in pair_list}

from typing import Optional

from fastapi import APIRouter

from services.market_data.controller import (
    get_pairs, get_ohlcvt, get_unlocks, get_unlock_events,
    get_upcoming_cliffs, get_db_summary,
    get_fear_greed_latest, get_fear_greed_history,
    get_live_price, get_live_prices,
)
from services.backtest.controller import (
    BacktestRequest, MultiBacktestRequest,
    run_backtest, run_backtest_multi,
)
from services.strategies.controller import (
    SaveStrategyRequest,
    list_strategies, get_strategy, save_strategy, update_strategy, delete_strategy,
)
from services.trading.controller import (
    BotStartRequest, SetKeysRequest,
    bot_start, bot_stop, bot_status, bot_logs,
    kraken_balance, kraken_status, kraken_set_keys,
)
from services.data_sources.controller import (
    SaveApiKeyRequest,
    get_exchanges, get_data_sources,
    get_exchange_pairs, get_ds_pairs, get_ds_data_types, get_ds_preview,
    get_coins, save_api_key,
)
from services.chat.controller import (
    ChatRequest, VisionChatRequest,
    chat, chat_vision,
)

router = APIRouter()


# ── Market data ───────────────────────────────────────────────────────────────

@router.get("/api/pairs")
def route_pairs():
    return get_pairs()


@router.get("/api/ohlcvt")
def route_ohlcvt(pair: str = "STRKUSD", interval: int = 1440,
                 start: Optional[str] = None, end: Optional[str] = None):
    return get_ohlcvt(pair, interval, start, end)


@router.get("/api/unlocks")
def route_unlocks(pair: str = "STRKUSD"):
    return get_unlocks(pair)


@router.get("/api/unlock-events")
def route_unlock_events(pair: str = "STRKUSD"):
    return get_unlock_events(pair)


@router.get("/api/upcoming-cliffs")
def route_upcoming_cliffs(days: int = 120):
    return get_upcoming_cliffs(days)


@router.get("/api/db-summary")
def route_db_summary():
    return get_db_summary()


@router.get("/api/fear-greed/latest")
def route_fear_greed_latest():
    return get_fear_greed_latest()


@router.get("/api/fear-greed")
def route_fear_greed(start: Optional[str] = None, end: Optional[str] = None, limit: int = 365):
    return get_fear_greed_history(start, end, limit)


@router.get("/api/live-price/{pair}")
def route_live_price(pair: str):
    return get_live_price(pair)


@router.get("/api/live-prices")
def route_live_prices(pairs: str = "ARBUSD,OPUSD,STRKUSD,ZKUSD"):
    return get_live_prices(pairs)


# ── Backtest ──────────────────────────────────────────────────────────────────

@router.post("/api/backtest")
def route_backtest(req: BacktestRequest):
    return run_backtest(req)


@router.post("/api/backtest-multi")
def route_backtest_multi(req: MultiBacktestRequest):
    return run_backtest_multi(req)


# ── Strategy library ──────────────────────────────────────────────────────────

@router.get("/api/strategies")
def route_list_strategies():
    return list_strategies()


@router.post("/api/strategies")
def route_save_strategy(req: SaveStrategyRequest):
    return save_strategy(req)


@router.get("/api/strategies/{sid}")
def route_get_strategy(sid: str):
    return get_strategy(sid)


@router.put("/api/strategies/{sid}")
def route_update_strategy(sid: str, req: SaveStrategyRequest):
    return update_strategy(sid, req)


@router.delete("/api/strategies/{sid}")
def route_delete_strategy(sid: str):
    return delete_strategy(sid)


# ── Trading / bot ─────────────────────────────────────────────────────────────

@router.post("/api/bot/start")
def route_bot_start(req: BotStartRequest):
    return bot_start(req)


@router.post("/api/bot/stop")
def route_bot_stop():
    return bot_stop()


@router.get("/api/bot/status")
def route_bot_status():
    return bot_status()


@router.get("/api/bot/logs")
def route_bot_logs(limit: int = 100):
    return bot_logs(limit)


@router.get("/api/kraken/balance")
def route_kraken_balance():
    return kraken_balance()


@router.get("/api/kraken/status")
def route_kraken_status():
    return kraken_status()


@router.post("/api/kraken/set-keys")
def route_kraken_set_keys(req: SetKeysRequest):
    return kraken_set_keys(req)


# ── Data sources ──────────────────────────────────────────────────────────────

@router.get("/api/exchanges")
def route_exchanges():
    return get_exchanges()


@router.get("/api/data-sources")
def route_data_sources():
    return get_data_sources()


@router.get("/api/data-sources/pairs/{exchange_id}")
def route_exchange_pairs(exchange_id: str):
    return get_exchange_pairs(exchange_id)


@router.get("/api/data-sources/pairs/{source_id}")
def route_ds_pairs(source_id: str, q: str = ""):
    return get_ds_pairs(source_id, q)


@router.get("/api/data-sources/data-types/{source_id}")
def route_ds_data_types(source_id: str):
    return get_ds_data_types(source_id)


@router.get("/api/data-sources/preview/{source_id}")
def route_ds_preview(source_id: str, pair: str = "", data_type: str = ""):
    return get_ds_preview(source_id, pair, data_type)


@router.get("/api/coins")
def route_coins(min_rank: Optional[int] = None, max_rank: Optional[int] = None,
                min_volume_24h: Optional[float] = None, min_market_cap: Optional[float] = None,
                kraken_only: bool = True, limit: int = 500):
    return get_coins(min_rank, max_rank, min_volume_24h, min_market_cap, kraken_only, limit)


@router.post("/api/save-api-key")
def route_save_api_key(req: SaveApiKeyRequest):
    return save_api_key(req)


# ── AI Chat ───────────────────────────────────────────────────────────────────

@router.post("/api/chat")
def route_chat(req: ChatRequest):
    return chat(req)


@router.post("/api/chat-vision")
def route_chat_vision(req: VisionChatRequest):
    return chat_vision(req)

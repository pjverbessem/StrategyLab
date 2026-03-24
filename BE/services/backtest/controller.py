import statistics
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Optional

import pandas as pd
from pydantic import BaseModel

from config import HAS_PANDAS
from services.backtest import service
from services.backtest.utils import compute_stats, build_equity_curve, build_indicator_overlay


class BacktestRequest(BaseModel):
    pair:       str           = "STRKUSD"
    interval:   int           = 1440
    start:      Optional[str] = None
    end:        Optional[str] = None
    script:     str           = ""
    indicators: list          = []
    exchange:   str           = "kraken"


class MultiBacktestRequest(BaseModel):
    pairs:       List[str]    = []
    interval:    int          = 1440
    start:       Optional[str] = None
    end:         Optional[str] = None
    script:      str          = ""
    max_workers: int          = 8


def run_backtest(req: BacktestRequest):
    if not HAS_PANDAS:
        return {"error": "pandas not installed", "trades": [], "equity": [], "stats": {}}
    if not req.script.strip():
        return {"error": "Script is empty", "trades": [], "equity": [], "stats": {}}

    try:
        pair     = req.pair.upper()
        exchange = (req.exchange or "kraken").lower()

        if exchange != "kraken":
            df, err = service.fetch_exchange_data(exchange, pair, req.interval, req.start, req.end)
            if err:
                return {"error": err, "trades": [], "equity": [], "stats": {}}
            unlocks       = pd.DataFrame()
            fear_greed_df = pd.DataFrame(columns=["date", "fg_value", "fg_class"])
        else:
            df, unlocks, fear_greed_df = service.fetch_kraken_data(pair, req.interval, req.start, req.end)

        if df.empty:
            return {
                "error": f"No OHLCVT data for {pair} on {exchange} with the selected range.",
                "trades": [], "equity": [], "stats": {},
            }

        df, raw_trades, err = service.execute_strategy(
            req.script, df, unlocks, fear_greed_df, req.indicators
        )
        if err:
            return {"error": err, "trades": [], "equity": [], "stats": {}}

        if not isinstance(raw_trades, list):
            return {"error": "❌ strategy() must return a list of trade dicts", "trades": [], "equity": [], "stats": {}}
        if not raw_trades:
            return {"error": "⚠️ strategy() returned 0 trades for this pair/range.", "trades": [], "equity": [], "stats": {}}

        required = {"entry", "exit", "side", "entry_price", "exit_price"}
        trades: list = []
        for t in raw_trades:
            if not required.issubset(t):
                continue
            ep   = float(t["entry_price"])
            xp   = float(t["exit_price"])
            side = str(t["side"]).lower()
            ret  = ((ep - xp) / ep * 100) if side == "short" else ((xp - ep) / ep * 100)
            trades.append({
                "entry":       int(t["entry"]),
                "exit":        int(t["exit"]),
                "side":        side,
                "entry_price": round(ep, 6),
                "exit_price":  round(xp, 6),
                "return_pct":  round(ret, 4),
            })
        trades.sort(key=lambda x: x["entry"])

        equity_curve  = build_equity_curve(trades)
        stats         = compute_stats(trades)

        MAX_CANDLES = 400
        ohlcv_df    = df[["time", "open", "high", "low", "close"]].copy()
        step        = max(1, len(ohlcv_df) // MAX_CANDLES)
        if len(ohlcv_df) > MAX_CANDLES:
            ohlcv_df = ohlcv_df.iloc[::step]
        ohlcv_list = ohlcv_df.to_dict("records")

        requested_ids = {ind.get("id", "") for ind in req.indicators}
        indicator_data, indicator_meta = build_indicator_overlay(df, step, requested_ids)

        return {
            "trades":         trades,
            "equity":         equity_curve,
            "stats":          stats,
            "ohlcv":          ohlcv_list,
            "indicator_data": indicator_data,
            "indicator_meta": indicator_meta,
            "error":          None,
        }

    except Exception as exc:
        return {
            "error": f"{type(exc).__name__}: {exc}\n\n{traceback.format_exc()}",
            "trades": [], "equity": [], "stats": {},
        }


def run_backtest_multi(req: MultiBacktestRequest):
    if not HAS_PANDAS:
        return {"error": "pandas not installed", "results": [], "aggregate": {}}
    if not req.script.strip():
        return {"error": "Script is empty", "results": [], "aggregate": {}}
    if not req.pairs:
        return {"error": "No pairs specified", "results": [], "aggregate": {}}

    def run_one(pair: str):
        sub    = BacktestRequest(pair=pair, interval=req.interval,
                                 start=req.start, end=req.end, script=req.script)
        result = run_backtest(sub)
        result["pair"] = pair
        return result

    workers = min(req.max_workers, len(req.pairs), 16)
    results: list = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(run_one, p): p for p in req.pairs}
        for fut in as_completed(futures):
            results.append(fut.result())

    results.sort(key=lambda r: r.get("stats", {}).get("total_return", -9999), reverse=True)

    good         = [r for r in results if not r.get("error") and r.get("trades")]
    all_returns  = [t["return_pct"] for r in good for t in r["trades"]]
    all_per_pair = [r["stats"]["total_return"] for r in good]

    def sharpe(rets: list, risk_free: float = 0.0) -> float:
        if len(rets) < 2:
            return 0.0
        mu  = statistics.mean(rets) - risk_free
        std = statistics.stdev(rets)
        return round(mu / std, 3) if std else 0.0

    wins   = [r for r in all_returns if r > 0]
    losses = [r for r in all_returns if r <= 0]
    gp     = sum(wins)
    gl     = abs(sum(losses))

    aggregate = {
        "pairs_run":               len(req.pairs),
        "pairs_with_trades":       len(good),
        "total_trades":            len(all_returns),
        "avg_return_per_trade":    round(statistics.mean(all_returns), 4) if all_returns else 0,
        "median_return_per_trade": round(statistics.median(all_returns), 4) if all_returns else 0,
        "win_rate":                round(len(wins) / len(all_returns) * 100, 1) if all_returns else 0,
        "profit_factor":           round(gp / gl, 2) if gl else 999.0,
        "sharpe_ratio":            sharpe(all_returns),
        "avg_pair_return":         round(statistics.mean(all_per_pair), 2) if all_per_pair else 0,
        "best_pair":               results[0]["pair"] if results else "",
        "best_pair_return":        results[0].get("stats", {}).get("total_return", 0) if results else 0,
    }
    return {"results": results, "aggregate": aggregate, "error": None}

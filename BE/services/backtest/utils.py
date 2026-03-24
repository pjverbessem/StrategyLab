import pandas as pd


# ── Indicator pre-computation ─────────────────────────────────────────────────

def precompute_indicators(df: pd.DataFrame, indicators: list, ta_lib) -> pd.DataFrame:
    close = df["close"]
    high  = df.get("high",  close)
    low   = df.get("low",   close)
    vol   = df.get("volume", pd.Series(dtype=float))

    for ind in indicators:
        iid = ind.get("id", "")
        p   = int(ind.get("period", ind.get("p", 14)))
        col = ind.get("col", f"{iid.upper()}_{p}")

        try:
            if iid == "sma":
                df[col] = close.rolling(p).mean()
            elif iid == "ema":
                df[col] = close.ewm(span=p, adjust=False).mean()
            elif iid == "rsi":
                if ta_lib:
                    df[col] = ta_lib.momentum.RSIIndicator(close, window=p).rsi()
                else:
                    delta = close.diff()
                    gain  = delta.clip(lower=0).rolling(p).mean()
                    loss  = (-delta.clip(upper=0)).rolling(p).mean()
                    rs    = gain / loss.replace(0, float("nan"))
                    df[col] = 100 - (100 / (1 + rs))
            elif iid == "macd":
                fast   = int(ind.get("fast", 12))
                slow   = int(ind.get("slow", 26))
                signal = int(ind.get("signal", 9))
                macd_line   = close.ewm(span=fast, adjust=False).mean() - close.ewm(span=slow, adjust=False).mean()
                signal_line = macd_line.ewm(span=signal, adjust=False).mean()
                df["MACD"]        = macd_line
                df["MACD_SIGNAL"] = signal_line
                df["MACD_HIST"]   = macd_line - signal_line
            elif iid == "bbands":
                std_mult = float(ind.get("std", 2.0))
                mid = close.rolling(p).mean()
                std = close.rolling(p).std()
                df["BB_MID"]   = mid
                df["BB_UPPER"] = mid + std_mult * std
                df["BB_LOWER"] = mid - std_mult * std
                df["BB_WIDTH"] = (df["BB_UPPER"] - df["BB_LOWER"]) / mid
            elif iid == "atr":
                if ta_lib:
                    df[col] = ta_lib.volatility.AverageTrueRange(high, low, close, window=p).average_true_range()
                else:
                    hl  = high - low
                    hc  = (high - close.shift()).abs()
                    lc  = (low  - close.shift()).abs()
                    tr  = pd.concat([hl, hc, lc], axis=1).max(axis=1)
                    df[col] = tr.rolling(p).mean()
            elif iid == "stoch":
                k_period = int(ind.get("k", 14))
                d_period = int(ind.get("d", 3))
                low_min  = low.rolling(k_period).min()
                high_max = high.rolling(k_period).max()
                df["STOCH_K"] = 100 * (close - low_min) / (high_max - low_min + 1e-9)
                df["STOCH_D"] = df["STOCH_K"].rolling(d_period).mean()
            elif iid == "vwap":
                typ     = (high + low + close) / 3
                df["VWAP"] = (typ * vol).cumsum() / vol.cumsum().replace(0, float("nan"))
            elif iid == "obv":
                direction = close.diff().apply(lambda x: 1 if x > 0 else (-1 if x < 0 else 0))
                df["OBV"]  = (vol * direction).cumsum()
            elif iid == "wr":
                high_max = high.rolling(p).max()
                low_min  = low.rolling(p).min()
                df[col]  = -100 * (high_max - close) / (high_max - low_min + 1e-9)
            elif iid == "adr":
                df[col] = (high - low).rolling(p).mean()
        except Exception as e:
            print(f"[indicators] skipped {iid}: {e}")

    return df


# ── Stats computation ─────────────────────────────────────────────────────────

def compute_stats(trades: list) -> dict:
    returns      = [t["return_pct"] for t in trades]
    wins         = [r for r in returns if r > 0]
    losses       = [r for r in returns if r <= 0]
    gross_profit = sum(wins)
    gross_loss   = abs(sum(losses))

    peak, eq, max_dd = 100.0, 100.0, 0.0
    for t in trades:
        eq    *= (1 + t["return_pct"] / 100)
        peak   = max(peak, eq)
        max_dd = min(max_dd, (eq - peak) / peak * 100)

    return {
        "total_return":   round(eq - 100, 2),
        "win_rate":       round(len(wins) / len(trades) * 100, 1),
        "total_trades":   len(trades),
        "winning_trades": len(wins),
        "losing_trades":  len(losses),
        "max_drawdown":   round(max_dd, 2),
        "profit_factor":  round(gross_profit / gross_loss, 2) if gross_loss else 999.0,
        "avg_win":        round(sum(wins) / len(wins), 2) if wins else 0.0,
        "avg_loss":       round(sum(losses) / len(losses), 2) if losses else 0.0,
    }


def build_equity_curve(trades: list) -> list:
    equity        = 100.0
    equity_curve  = []
    for t in trades:
        equity_curve.append({"time": t["entry"], "value": round(equity, 4)})
        equity *= (1 + t["return_pct"] / 100)
        equity_curve.append({"time": t["exit"], "value": round(equity, 4)})
    return equity_curve


def build_indicator_overlay(df: pd.DataFrame, step: int, requested_ids: set | None = None) -> tuple[dict, dict]:
    PRICE_SCALE_COLS  = {"SMA", "EMA", "BB_UPPER", "BB_MID", "BB_LOWER", "VWAP", "volume"}
    OSCILLATOR_COLS   = {
        "RSI": (0, 100), "MACD": None, "MACD_SIGNAL": None, "MACD_HIST": None,
        "STOCH_K": (0, 100), "STOCH_D": (0, 100),
        "ATR": None, "OBV": None, "BB_WIDTH": None, "ADR": None,
    }
    PRICE_PREFIXES    = ("SMA_", "EMA_", "BB_UPPER", "BB_MID", "BB_LOWER", "VWAP", "WR_")
    OSC_PREFIXES      = ("RSI_", "ATR_", "OBV", "ADR_")

    indicator_data: dict = {}
    indicator_meta: dict = {}
    base_times = df["time"].iloc[::step].reset_index(drop=True)

    ignore = {"time", "open", "high", "low", "close", "volume", "vwap", "trades", "date", "fg_value", "fg_class"}
    # Only expose volume if it was explicitly requested
    if requested_ids and "volume" in requested_ids:
        ignore.discard("volume")
    for col in sorted(set(df.columns) - ignore):
        series   = df[col].iloc[::step].reset_index(drop=True)
        is_price = any(col.startswith(p) for p in PRICE_PREFIXES) or col in PRICE_SCALE_COLS
        is_osc   = (
            any(col.startswith(p) for p in OSC_PREFIXES) or
            col in OSCILLATOR_COLS or
            col.startswith("MACD") or
            col in ("STOCH_K", "STOCH_D")
        )
        if not (is_price or is_osc):
            continue

        points = []
        for t, v in zip(base_times, series):
            if pd.notna(v) and pd.notna(t):
                points.append({"time": int(t), "value": round(float(v), 8)})
        if not points:
            continue

        rng = None
        if col.startswith("RSI") or col.startswith("STOCH"):
            rng = [0, 100]

        indicator_data[col] = points
        indicator_meta[col] = {
            "type":  "price" if is_price else "oscillator",
            "range": rng,
            "group": (
                "macd"  if col.startswith("MACD") else
                "stoch" if col.startswith("STOCH") else
                col.split("_")[0].lower()
            ),
        }

    return indicator_data, indicator_meta

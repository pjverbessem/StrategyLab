#!/usr/bin/env python3
"""
backtest.py
-----------
Core backtesting engine for Kraken OHLCVT data.

Usage:
    from src.backtest import BacktestEngine, Strategy

    engine = BacktestEngine(pair="ARBUSD", interval=60)
    result = engine.run(MyStrategy(), start="2023-01-01", end="2024-01-01")
    result.summary()
    result.plot()
"""

import sqlite3
import pandas as pd
import numpy as np
from dataclasses import dataclass, field
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

# ── Config ────────────────────────────────────────────────────────────────────

BASE_DIR = Path(__file__).parent.parent
DB_PATH  = BASE_DIR / "data" / "kraken.db"

# ── Data loading ──────────────────────────────────────────────────────────────

def load_ohlcvt(
    pair: str,
    interval: int,
    start: Optional[str] = None,
    end:   Optional[str] = None,
    db_path: Path = DB_PATH,
) -> pd.DataFrame:
    """
    Load OHLCVT data from SQLite into a Pandas DataFrame.

    Parameters
    ----------
    pair     : e.g. 'ARBUSD'
    interval : minutes — 1, 5, 15, 60, 240, 1440, …
    start    : 'YYYY-MM-DD' inclusive, UTC (optional)
    end      : 'YYYY-MM-DD' inclusive, UTC (optional)

    Returns
    -------
    DataFrame with DatetimeIndex (UTC) and columns:
        open, high, low, close, vwap, volume, trades
    """
    if not db_path.exists():
        raise FileNotFoundError(
            f"Database not found: {db_path}\n"
            "Run: python3 src/ingest.py"
        )

    conditions = ["pair = ?", "interval = ?"]
    params     = [pair.upper(), interval]

    if start:
        ts_start = int(datetime.fromisoformat(start).replace(tzinfo=timezone.utc).timestamp())
        conditions.append("ts >= ?")
        params.append(ts_start)

    if end:
        ts_end = int(datetime.fromisoformat(end).replace(tzinfo=timezone.utc).timestamp())
        conditions.append("ts <= ?")
        params.append(ts_end + 86400)   # inclusive end-of-day

    query = f"""
        SELECT ts, open, high, low, close, vwap, volume, trades
        FROM ohlcvt
        WHERE {' AND '.join(conditions)}
        ORDER BY ts ASC
    """

    conn = sqlite3.connect(db_path)
    df = pd.read_sql_query(query, conn, params=params)
    conn.close()

    if df.empty:
        raise ValueError(
            f"No data found for {pair} @ {interval}m"
            + (f" from {start}" if start else "")
            + (f" to {end}" if end else "")
        )

    df["datetime"] = pd.to_datetime(df["ts"], unit="s", utc=True)
    df = df.set_index("datetime").drop(columns=["ts"])
    return df


def load_chain_tvl(
    pair:     str,
    start:    Optional[str] = None,
    end:      Optional[str] = None,
    db_path:  Path = DB_PATH,
) -> pd.DataFrame:
    """
    Load DefiLlama chain TVL data for a given Kraken pair.
    Run  python3 src/download_defillama.py  first to populate the table.

    Parameters
    ----------
    pair  : Kraken pair name, e.g. 'ARBUSD'
    start : 'YYYY-MM-DD' (optional)
    end   : 'YYYY-MM-DD' (optional)

    Returns
    -------
    DataFrame with DatetimeIndex (UTC) and columns:
        tvl, tvl_chg_1d_pct, tvl_chg_7d_pct, tvl_ma7
    (from the chain_tvl_signals view)
    """
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found: {db_path}")

    conditions = ["pair = ?"]
    params     = [pair.upper()]

    if start:
        ts_start = int(datetime.fromisoformat(start).replace(tzinfo=timezone.utc).timestamp())
        conditions.append("date >= ?")
        params.append(ts_start)
    if end:
        ts_end = int(datetime.fromisoformat(end).replace(tzinfo=timezone.utc).timestamp())
        conditions.append("date <= ?")
        params.append(ts_end + 86400)

    query = f"""
        SELECT date, tvl, tvl_chg_1d_pct, tvl_chg_7d_pct, tvl_ma7
        FROM chain_tvl_signals
        WHERE {' AND '.join(conditions)}
        ORDER BY date ASC
    """
    conn = sqlite3.connect(db_path)
    df = pd.read_sql_query(query, conn, params=params)
    conn.close()

    if df.empty:
        raise ValueError(f"No TVL data for {pair}. Run: python3 src/download_defillama.py")

    df["datetime"] = pd.to_datetime(df["date"], unit="s", utc=True)
    df = df.set_index("datetime").drop(columns=["date"])
    return df


def merge_ohlcvt_tvl(
    ohlcvt: pd.DataFrame,
    tvl:    pd.DataFrame,
) -> pd.DataFrame:
    """
    Merge OHLCVT candle data with daily TVL data.
    TVL is forward-filled from daily to the candle frequency.

    Returns a combined DataFrame with all OHLCVT columns plus
    tvl, tvl_chg_1d_pct, tvl_chg_7d_pct, tvl_ma7.
    """
    tvl_reindexed = tvl.reindex(ohlcvt.index, method="ffill")
    return pd.concat([ohlcvt, tvl_reindexed], axis=1)


def load_token_unlocks(
    pair:    str,
    start:   Optional[str] = None,
    end:     Optional[str] = None,
    db_path: Path = DB_PATH,
) -> pd.DataFrame:
    """
    Load daily token unlock / vesting schedule for a Kraken pair.
    Run  python3 src/build_unlock_schedule.py  first to populate.

    Parameters
    ----------
    pair  : e.g. 'ARBUSD'
    start : 'YYYY-MM-DD' (optional)
    end   : 'YYYY-MM-DD' (optional)

    Returns
    -------
    DataFrame with DatetimeIndex (UTC, midnight) and columns:
        daily_new_tokens      — tokens newly unlocked on this day
        cumulative_tokens     — total unlocked to date
        has_cliff_event       — 1 if a cliff fires today, else 0
        cliff_event_tokens    — sum of cliff tokens on this day
        inflation_pct_of_supply — daily_new / max_supply × 100
        days_to_next_cliff    — calendar days until next cliff event
        days_since_cliff      — calendar days since last cliff event
    """
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found: {db_path}")

    conditions = ["pair = ?"]
    params: list = [pair.upper()]

    if start:
        ts_start = int(datetime.fromisoformat(start)
                       .replace(tzinfo=timezone.utc).timestamp())
        conditions.append("date >= ?")
        params.append(ts_start)
    if end:
        ts_end = int(datetime.fromisoformat(end)
                     .replace(tzinfo=timezone.utc).timestamp())
        conditions.append("date <= ?")
        params.append(ts_end + 86400)

    query = f"""
        SELECT date, daily_new_tokens, cumulative_tokens,
               has_cliff_event, cliff_event_tokens,
               inflation_pct_of_supply
        FROM token_unlocks
        WHERE {' AND '.join(conditions)}
        ORDER BY date ASC
    """

    conn = sqlite3.connect(db_path)
    df = pd.read_sql_query(query, conn, params=params)
    conn.close()

    if df.empty:
        raise ValueError(
            f"No unlock data for {pair}. "
            "Run: python3 src/build_unlock_schedule.py"
        )

    df["datetime"] = pd.to_datetime(df["date"], unit="s", utc=True)
    df = df.set_index("datetime").drop(columns=["date"])

    # ── Build a DENSE daily grid so the countdown is correct every day ──────
    # The DB only stores rows where tokens actually unlock (sparse).
    # We need every calendar day to correctly compute "days until next cliff".
    full_range = pd.date_range(
        start = df.index.min(),
        end   = df.index.max(),
        freq  = "D",
        tz    = "UTC",
    )
    df = df.reindex(full_range).fillna({
        "daily_new_tokens":        0.0,
        "has_cliff_event":         0,
        "cliff_event_tokens":      0.0,
        "inflation_pct_of_supply": 0.0,
    })
    # Forward-fill cumulative_tokens (it never goes backwards)
    df["cumulative_tokens"] = df["cumulative_tokens"].ffill()

    # ── Derived columns useful for strategy logic ──────────────────────────
    # Note: days_to_next_cliff is computed in merge_ohlcvt_unlocks so it
    # covers every candle frequency correctly. Here we just ensure the dense
    # grid is populated with cliff indicators.
    return df


def merge_ohlcvt_unlocks(
    ohlcvt:  pd.DataFrame,
    unlocks: pd.DataFrame,
) -> pd.DataFrame:
    """
    Merge OHLCVT candle data with daily token unlock data.
    Unlock figures are forward-filled from the dense unlock daily grid
    to whatever candle frequency the OHLCVT data uses.

    Returns a combined DataFrame with all OHLCVT columns plus:
        daily_new_tokens, cumulative_tokens, has_cliff_event,
        cliff_event_tokens, inflation_pct_of_supply,
        days_to_next_cliff, days_since_cliff
    """
    unlocks_reindexed = unlocks.reindex(ohlcvt.index, method="ffill")
    merged = pd.concat([ohlcvt, unlocks_reindexed], axis=1)

    # ── Compute countdown columns on the merged (dense) frame ─────────────
    cliff_dates = merged.index[merged["has_cliff_event"].fillna(0) == 1]

    def _days_to_next(dt):
        future = cliff_dates[cliff_dates >= dt]
        return int((future[0] - dt).days) if len(future) else 9999

    def _days_since_last(dt):
        past = cliff_dates[cliff_dates < dt]
        return int((dt - past[-1]).days) if len(past) else 9999

    merged["days_to_next_cliff"] = [_days_to_next(dt) for dt in merged.index]
    merged["days_since_cliff"]   = [_days_since_last(dt) for dt in merged.index]

    return merged


# ── Strategy base class ───────────────────────────────────────────────────────

class Strategy:
    """
    Subclass this and override `next()`.

    Inside next(), use:
        self.buy(size=1.0)
        self.sell(size=1.0)
        self.close_position()
        self.position        → current position size (float)
        self.data            → slice of OHLCVT up to current bar (inclusive)
        self.index           → current integer bar index
        self.cash            → available cash
        self.equity          → cash + position value
    """
    def init(self):
        """Called once before the backtest loop. Set up indicators here."""
        pass

    def next(self):
        """Called once per bar. Implement your trading logic here."""
        raise NotImplementedError


# ── Trade & Result ────────────────────────────────────────────────────────────

@dataclass
class Trade:
    entry_dt:    pd.Timestamp
    entry_price: float
    exit_dt:     Optional[pd.Timestamp] = None
    exit_price:  Optional[float]        = None
    size:        float                  = 1.0
    side:        str                    = "long"  # 'long' | 'short'

    @property
    def pnl(self) -> float:
        if self.exit_price is None:
            return 0.0
        if self.side == "long":
            return (self.exit_price - self.entry_price) * self.size
        return (self.entry_price - self.exit_price) * self.size

    @property
    def pct_return(self) -> float:
        if self.exit_price is None or self.entry_price == 0:
            return 0.0
        if self.side == "long":
            return (self.exit_price - self.entry_price) / self.entry_price
        return (self.entry_price - self.exit_price) / self.entry_price


@dataclass
class BacktestResult:
    pair:           str
    interval:       int
    start:          Optional[str]
    end:            Optional[str]
    initial_cash:   float
    final_equity:   float
    trades:         list = field(default_factory=list)
    equity_curve:   Optional[pd.Series] = None
    data:           Optional[pd.DataFrame] = None

    # ── Stats ──────────────────────────────────────────────────────────────

    def summary(self) -> dict:
        closed = [t for t in self.trades if t.exit_price is not None]
        if not closed:
            print("⚠️   No completed trades.")
            return {}

        pnls    = [t.pnl for t in closed]
        rets    = [t.pct_return for t in closed]
        winners = [p for p in pnls if p > 0]
        losers  = [p for p in pnls if p < 0]

        total_return = (self.final_equity - self.initial_cash) / self.initial_cash
        win_rate     = len(winners) / len(closed) if closed else 0
        avg_win      = np.mean(winners) if winners else 0
        avg_loss     = np.mean(losers)  if losers  else 0
        profit_factor = (sum(winners) / abs(sum(losers))) if losers else float("inf")

        # Max drawdown from equity curve
        if self.equity_curve is not None:
            peak = self.equity_curve.cummax()
            dd   = (self.equity_curve - peak) / peak
            max_dd = dd.min()
        else:
            max_dd = float("nan")

        # Sharpe (annualised, assuming daily returns from equity curve)
        if self.equity_curve is not None and len(self.equity_curve) > 1:
            daily_ret = self.equity_curve.pct_change().dropna()
            sharpe = (daily_ret.mean() / daily_ret.std() * np.sqrt(252)
                      if daily_ret.std() > 0 else float("nan"))
        else:
            sharpe = float("nan")

        stats = {
            "Pair":           self.pair,
            "Interval (min)": self.interval,
            "Initial cash":   f"${self.initial_cash:,.2f}",
            "Final equity":   f"${self.final_equity:,.2f}",
            "Total return":   f"{total_return*100:.2f}%",
            "Total trades":   len(closed),
            "Win rate":       f"{win_rate*100:.1f}%",
            "Avg win":        f"${avg_win:,.2f}",
            "Avg loss":       f"${avg_loss:,.2f}",
            "Profit factor":  f"{profit_factor:.2f}",
            "Max drawdown":   f"{max_dd*100:.2f}%",
            "Sharpe (ann.)":  f"{sharpe:.2f}",
        }

        width = max(len(k) for k in stats) + 2
        print("\n" + "="*50)
        print(f"  Backtest Results — {self.pair} @ {self.interval}m")
        print("="*50)
        for k, v in stats.items():
            print(f"  {k:<{width}} {v}")
        print("="*50 + "\n")
        return stats

    def plot(self, show_signals: bool = True):
        """Plot equity curve and signals (requires matplotlib)."""
        try:
            import matplotlib.pyplot as plt
            import matplotlib.dates as mdates
        except ImportError:
            print("⚠️   matplotlib not installed. Run: pip3 install matplotlib")
            return

        fig, axes = plt.subplots(
            2, 1, figsize=(14, 8),
            gridspec_kw={"height_ratios": [3, 1]},
            sharex=True
        )
        fig.patch.set_facecolor("#0d1117")
        for ax in axes:
            ax.set_facecolor("#161b22")
            ax.tick_params(colors="#8b949e")
            ax.spines[:].set_color("#30363d")

        # ── Price + signals ────────────────────────────────────────────────
        ax1 = axes[0]
        if self.data is not None:
            ax1.plot(self.data.index, self.data["close"],
                     color="#58a6ff", linewidth=0.8, label="Close")

        if show_signals:
            entries = [(t.entry_dt, t.entry_price, t.side) for t in self.trades]
            exits   = [(t.exit_dt,  t.exit_price)
                       for t in self.trades if t.exit_dt is not None]

            for dt, price, side in entries:
                color  = "#3fb950" if side == "long" else "#f85149"
                marker = "^"       if side == "long" else "v"
                ax1.scatter(dt, price, color=color, marker=marker,
                            s=80, zorder=5, label=f"{side} entry")

            for dt, price in exits:
                ax1.scatter(dt, price, color="#e3b341", marker="o",
                            s=60, zorder=5, label="exit")

        ax1.set_ylabel("Price (USD)", color="#c9d1d9")
        ax1.set_title(
            f"{self.pair}  ·  {self.interval}m  ·  Backtest",
            color="#c9d1d9", fontsize=13
        )

        # de-dup legend
        handles, labels = ax1.get_legend_handles_labels()
        seen, h2, l2 = set(), [], []
        for h, lbl in zip(handles, labels):
            if lbl not in seen:
                seen.add(lbl); h2.append(h); l2.append(lbl)
        ax1.legend(h2, l2, facecolor="#161b22", labelcolor="#c9d1d9",
                   edgecolor="#30363d", fontsize=8)

        # ── Equity curve ───────────────────────────────────────────────────
        ax2 = axes[1]
        if self.equity_curve is not None:
            ax2.fill_between(self.equity_curve.index, self.equity_curve,
                             self.initial_cash, alpha=0.3,
                             where=self.equity_curve >= self.initial_cash,
                             color="#3fb950")
            ax2.fill_between(self.equity_curve.index, self.equity_curve,
                             self.initial_cash, alpha=0.3,
                             where=self.equity_curve <  self.initial_cash,
                             color="#f85149")
            ax2.plot(self.equity_curve.index, self.equity_curve,
                     color="#c9d1d9", linewidth=0.8)
            ax2.axhline(self.initial_cash, color="#8b949e", linestyle="--",
                        linewidth=0.8)
        ax2.set_ylabel("Equity ($)", color="#c9d1d9")
        ax2.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))

        plt.tight_layout()
        plt.show()


# ── Engine ────────────────────────────────────────────────────────────────────

class BacktestEngine:
    """
    Event-driven OHLCVT backtesting engine.

    Parameters
    ----------
    pair        : e.g. 'ARBUSD'
    interval    : minute interval for candles (1, 5, 15, 60, 240, 1440 …)
    initial_cash: starting capital in USD
    commission  : fraction per trade (e.g. 0.0026 = 0.26 % taker fee)
    slippage    : fraction applied to entry/exit price
    """

    def __init__(
        self,
        pair:         str   = "ARBUSD",
        interval:     int   = 60,
        initial_cash: float = 10_000.0,
        commission:   float = 0.0026,
        slippage:     float = 0.0005,
        db_path:      Path  = DB_PATH,
    ):
        self.pair         = pair.upper()
        self.interval     = interval
        self.initial_cash = initial_cash
        self.commission   = commission
        self.slippage     = slippage
        self.db_path      = db_path

    # ── Public API ─────────────────────────────────────────────────────────

    def run(
        self,
        strategy:  Strategy,
        start:     Optional[str] = None,
        end:       Optional[str] = None,
    ) -> BacktestResult:

        df = load_ohlcvt(self.pair, self.interval, start, end, self.db_path)

        # ── Inject context into strategy ───────────────────────────────────
        strategy._engine   = self
        strategy._data_all = df
        strategy._trades   = []
        strategy._cash     = self.initial_cash
        strategy._position = 0.0      # units held (positive = long)
        strategy._entry_price = 0.0

        strategy.init()

        equity_values = []

        for i in range(len(df)):
            strategy.index = i
            strategy.data  = df.iloc[: i + 1]
            strategy._bar  = df.iloc[i]

            strategy.next()

            # Mark-to-market equity
            close = strategy._bar["close"]
            equity = strategy._cash + strategy._position * close
            equity_values.append(equity)

        # Close any open position at last bar
        if strategy._position != 0:
            last_bar   = df.iloc[-1]
            last_close = last_bar["close"]
            self._close_position(strategy, last_close, last_bar.name)

        equity_series = pd.Series(equity_values, index=df.index)

        return BacktestResult(
            pair         = self.pair,
            interval     = self.interval,
            start        = start,
            end          = end,
            initial_cash = self.initial_cash,
            final_equity = equity_series.iloc[-1],
            trades       = strategy._trades,
            equity_curve = equity_series,
            data         = df,
        )

    # ── Internal order helpers (called by Strategy) ────────────────────────

    def _buy(self, strategy: Strategy, size: float):
        bar   = strategy._bar
        price = bar["close"] * (1 + self.slippage)
        cost  = price * size
        fee   = cost * self.commission

        if strategy._cash < cost + fee:
            size  = strategy._cash / (price * (1 + self.commission))
            cost  = price * size
            fee   = cost * self.commission

        strategy._cash    -= cost + fee
        strategy._position += size
        strategy._entry_price = price

        strategy._trades.append(Trade(
            entry_dt    = bar.name,
            entry_price = price,
            size        = size,
            side        = "long",
        ))

    def _sell_short(self, strategy: Strategy, size: float):
        bar   = strategy._bar
        price = bar["close"] * (1 - self.slippage)

        strategy._position  -= size
        strategy._cash      += price * size * (1 - self.commission)
        strategy._entry_price = price

        strategy._trades.append(Trade(
            entry_dt    = bar.name,
            entry_price = price,
            size        = size,
            side        = "short",
        ))

    def _close_position(self, strategy: Strategy, price: float,
                         dt: pd.Timestamp):
        if strategy._position == 0:
            return

        side = "long" if strategy._position > 0 else "short"
        size = abs(strategy._position)
        if side == "long":
            proceeds = price * (1 - self.slippage) * size
            fee      = proceeds * self.commission
            strategy._cash += proceeds - fee
        else:
            cost  = price * (1 + self.slippage) * size
            fee   = cost * self.commission
            strategy._cash -= cost + fee

        strategy._position = 0.0

        # Fill exit on most recent open trade
        for t in reversed(strategy._trades):
            if t.exit_dt is None:
                t.exit_dt    = dt
                t.exit_price = price
                break


# ── Strategy mixin methods (injected at run-time) ─────────────────────────────

def _buy(self, size: float = 1.0):
    self._engine._buy(self, size)

def _sell(self, size: Optional[float] = None):
    """Close long position (sell all or partial)."""
    if self._position <= 0:
        return
    size = size or self._position
    self._engine._close_position(self, self._bar["close"], self._bar.name)

def _short(self, size: float = 1.0):
    self._engine._sell_short(self, size)

def _close_position(self):
    self._engine._close_position(self, self._bar["close"], self._bar.name)

def _equity(self) -> float:
    return self._cash + self._position * self._bar["close"]

# Attach methods to Strategy
Strategy.buy            = _buy
Strategy.sell           = _sell
Strategy.short          = _short
Strategy.close_position = _close_position
Strategy.position       = property(lambda self: self._position)
Strategy.cash           = property(lambda self: self._cash)
Strategy.equity         = property(_equity)


# ── Built-in example strategies ───────────────────────────────────────────────

class SMACrossStrategy(Strategy):
    """
    Simple Moving Average crossover:
        Buy  when fast SMA crosses above slow SMA.
        Sell when fast SMA crosses below slow SMA.

    Parameters
    ----------
    fast  : fast SMA window (bars)
    slow  : slow SMA window (bars)
    """
    def __init__(self, fast: int = 20, slow: int = 50):
        self.fast = fast
        self.slow = slow

    def init(self):
        print(f"  Strategy: SMA Cross ({self.fast}/{self.slow})")

    def next(self):
        if len(self.data) < self.slow + 1:
            return

        close   = self.data["close"]
        sma_f   = close.iloc[-self.fast:].mean()
        sma_f1  = close.iloc[-self.fast - 1:-1].mean()
        sma_s   = close.iloc[-self.slow:].mean()
        sma_s1  = close.iloc[-self.slow - 1:-1].mean()

        cross_up   = (sma_f1 <= sma_s1) and (sma_f > sma_s)
        cross_down = (sma_f1 >= sma_s1) and (sma_f < sma_s)

        if cross_up and self._position <= 0:
            if self._position < 0:
                self.close_position()
            self.buy(size=self._cash / self._bar["close"])

        elif cross_down and self._position > 0:
            self.close_position()


class RSIStrategy(Strategy):
    """
    RSI mean-reversion:
        Buy  when RSI < oversold
        Sell when RSI > overbought
    """
    def __init__(self, period: int = 14, oversold: float = 30,
                 overbought: float = 70):
        self.period     = period
        self.oversold   = oversold
        self.overbought = overbought

    def init(self):
        print(f"  Strategy: RSI({self.period})  "
              f"OS={self.oversold}  OB={self.overbought}")

    def _rsi(self) -> float:
        close  = self.data["close"].values
        if len(close) < self.period + 1:
            return 50.0
        deltas = np.diff(close[-(self.period + 1):])
        gains  = deltas[deltas > 0].mean() if (deltas > 0).any() else 0
        losses = -deltas[deltas < 0].mean() if (deltas < 0).any() else 0
        if losses == 0:
            return 100.0
        rs = gains / losses
        return 100 - 100 / (1 + rs)

    def next(self):
        if len(self.data) < self.period + 2:
            return
        rsi = self._rsi()
        if rsi < self.oversold and self._position <= 0:
            self.buy(size=self._cash / self._bar["close"])
        elif rsi > self.overbought and self._position > 0:
            self.close_position()


class UnlockShortStrategy(Strategy):
    """
    Unlock Event Short Strategy
    ---------------------------
    Thesis: token insiders (team, investors) tend to sell when their vesting
    cliff unlocks. This creates predictable downward price pressure around
    unlock dates.

    Logic:
        • Enter SHORT  `entry_days_before` days before a cliff event
          (only if cliff is >= min_cliff_pct % of max supply)
        • Cover (close) SHORT after holding `hold_days` days
        • Skip if already in a position
        • Optional: also short when daily linear-vest inflation exceeds
          `inflation_threshold_pct` (chronic selling pressure)

    Parameters
    ----------
    entry_days_before     : days before cliff to enter (default 3)
    hold_days             : days to hold short after entry (default 7)
    size_pct              : fraction of equity to short (default 0.9 = 90%)
    min_cliff_pct         : minimum cliff size as % of max supply (default 0.5%)
    inflation_threshold   : if daily inflation > this %, also short (0 = disabled)
    pair                  : must match BacktestEngine pair (for unlock loading)

    Usage
    -----
        engine = BacktestEngine(pair="ARBUSD", interval=1440)  # daily candles
        strat  = UnlockShortStrategy(entry_days_before=5, hold_days=10)
        result = engine.run(strat)
        result.summary()
    """

    def __init__(
        self,
        entry_days_before:   int   = 3,
        hold_days:           int   = 7,
        size_pct:            float = 0.9,
        min_cliff_pct:       float = 0.5,
        inflation_threshold: float = 0.0,
    ):
        self.entry_days_before   = entry_days_before
        self.hold_days           = hold_days
        self.size_pct            = size_pct
        self.min_cliff_pct       = min_cliff_pct
        self.inflation_threshold = inflation_threshold

        self._unlock_df:   Optional[pd.DataFrame] = None
        self._entry_bar:   Optional[int]           = None   # bar index of last entry

    # ── Called once before the loop ────────────────────────────────────────

    def init(self):
        pair = self._engine.pair
        print(f"  Strategy : Unlock Short  [{pair}]")
        print(f"  Entry     : {self.entry_days_before}d before cliff")
        print(f"  Hold      : {self.hold_days}d")
        print(f"  Min cliff : {self.min_cliff_pct}% of max supply")

        # Load unlock schedule aligned to full data range
        idx  = self._data_all.index
        s    = idx[0].strftime("%Y-%m-%d")
        e    = idx[-1].strftime("%Y-%m-%d")
        try:
            unlocks = load_token_unlocks(pair, start=s, end=e,
                                         db_path=self._engine.db_path)
            self._unlock_df = merge_ohlcvt_unlocks(self._data_all, unlocks)
        except ValueError as err:
            print(f"  ⚠️   {err}")
            self._unlock_df = None

    # ── Called every bar ───────────────────────────────────────────────────

    def next(self):
        if self._unlock_df is None:
            return

        bar_dt  = self._bar.name

        # Look up unlock signals for this bar from the pre-merged frame
        if bar_dt not in self._unlock_df.index:
            return
        u = self._unlock_df.loc[bar_dt]

        days_to_cliff  = u.get("days_to_next_cliff",  9999)
        days_since     = u.get("days_since_cliff",     9999)
        inflation_pct  = u.get("inflation_pct_of_supply", 0) or 0

        # ── Cover: exit short after hold_days ──────────────────────────────
        if self._position < 0 and self._entry_bar is not None:
            bars_held = self.index - self._entry_bar
            if bars_held >= self.hold_days:
                self.close_position()
                self._entry_bar = None

        # ── Entry: short if upcoming cliff is significant ───────────────────
        if self._position == 0:
            # Cliff-driven entry
            cliff_trigger = (
                0 < days_to_cliff <= self.entry_days_before
            )

            # Linear-vest inflation entry (optional)
            inflation_trigger = (
                self.inflation_threshold > 0
                and inflation_pct >= self.inflation_threshold
            )

            if cliff_trigger or inflation_trigger:
                price = self._bar["close"]
                size  = (self.equity * self.size_pct) / price
                if size > 0:
                    self.short(size=size)
                    self._entry_bar = self.index
                    reason = (f"cliff in {days_to_cliff}d"
                              if cliff_trigger
                              else f"inflation {inflation_pct:.3f}%")
                    # (uncomment to debug)
                    # print(f"  SHORT @ {bar_dt.date()}  {reason}  price={price:.4f}")


# ── Quick demo ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    pair     = sys.argv[1].upper() if len(sys.argv) > 1 else "ARBUSD"
    interval = int(sys.argv[2])    if len(sys.argv) > 2 else 60
    strategy_name = sys.argv[3]    if len(sys.argv) > 3 else "sma"

    print("=" * 60)
    print(f"  Kraken Backtest Engine — {pair} @ {interval}m")
    print("=" * 60)

    engine = BacktestEngine(pair=pair, interval=interval)

    if strategy_name.lower() == "rsi":
        strat = RSIStrategy()
    else:
        strat = SMACrossStrategy()

    result = engine.run(strat)
    result.summary()

    ans = input("Show chart? [y/N] ").strip().lower()
    if ans == "y":
        result.plot()

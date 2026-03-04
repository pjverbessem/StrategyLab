# DefiLlama + Kraken Backtest Engine

A local backtesting framework built on Kraken's official **historical OHLCVT** data.

## Pairs in scope
| Pair      | Token          |
|-----------|----------------|
| ARB/USD   | Arbitrum       |
| OP/USD    | Optimism       |
| STRK/USD  | Starknet       |
| ZK/USD    | ZKsync         |

## Quickstart

### 1 — Download the data

```bash
python3 src/download_kraken.py
```

This will:
- Download **Kraken_OHLCVT.zip** (~GB+) from Google Drive  
- Extract **only** the 4 target pairs at all intervals (1m, 5m, 15m, 1h, 4h, 1d, 1w) into `data/raw/`

### 2 — Ingest into SQLite

```bash
python3 src/ingest.py
```

Reads the CSVs and loads them into `data/kraken.db` — a fast, indexed SQLite database.

### 3 — Explore the data

```bash
python3 src/inspect_data.py              # overview of all pairs/intervals
python3 src/inspect_data.py ARBUSD 60   # detail for ARB/USD 1-hour
```

### 4 — Run a backtest

```bash
python3 src/backtest.py ARBUSD 60       # SMA crossover on ARB/USD 1h
python3 src/backtest.py OPUSD 1440 rsi  # RSI strategy on OP/USD daily
```

---

## Project layout

```
DefiLlama + Kraken/
├── data/
│   ├── raw/          ← extracted CSVs (one file per pair+interval)
│   └── kraken.db     ← SQLite database (created by ingest.py)
└── src/
    ├── download_kraken.py  ← Step 1: download & extract
    ├── ingest.py           ← Step 2: CSV → SQLite
    ├── inspect_data.py     ← Step 3: explore data
    └── backtest.py         ← Step 4: backtest engine + strategies
```

## Data format

Kraken OHLCVT CSV columns (no header):

| Column    | Type   | Description                    |
|-----------|--------|--------------------------------|
| timestamp | int    | Unix seconds, UTC              |
| open      | float  | Open price (USD)               |
| high      | float  | High price (USD)               |
| low       | float  | Low price (USD)                |
| close     | float  | Close price (USD)              |
| vwap      | float  | Volume-weighted average price  |
| volume    | float  | Volume in base currency        |
| trades    | int    | Number of trades in period     |

## Writing a custom strategy

```python
from src.backtest import BacktestEngine, Strategy

class MyStrategy(Strategy):
    def init(self):
        # Called once. Set up indicators.
        self.window = 20

    def next(self):
        # Called every bar.
        close = self.data["close"]
        sma   = close.rolling(self.window).mean().iloc[-1]

        if close.iloc[-1] > sma and self.position <= 0:
            self.buy(size=self.cash / self.data["close"].iloc[-1])

        elif close.iloc[-1] < sma and self.position > 0:
            self.close_position()

engine = BacktestEngine(pair="ARBUSD", interval=60, initial_cash=10_000)
result = engine.run(MyStrategy(), start="2023-01-01", end="2024-01-01")
result.summary()
result.plot()
```

## Available intervals

| Minutes | Label | Description        |
|---------|-------|--------------------|
| 1       | 1m    | 1-minute candles   |
| 5       | 5m    | 5-minute candles   |
| 15      | 15m   | 15-minute candles  |
| 60      | 1h    | 1-hour candles     |
| 240     | 4h    | 4-hour candles     |
| 1440    | 1d    | Daily candles      |
| 10080   | 1w    | Weekly candles     |
# StrategyLab

import re


def extract_code_from_reply(reply: str) -> str:
    m   = re.search(r"\[Python Code\]([\s\S]*?)(?=\[Parameters\]|$)", reply, re.IGNORECASE)
    raw = m.group(1).strip() if m else reply
    fence = re.search(r"```(?:python)?\n?([\s\S]*?)```", raw)
    if fence:
        return fence.group(1).strip()
    return raw.strip()


def code_looks_complete(code: str) -> bool:
    if not code or "def strategy" not in code:
        return False
    lines = [l.strip() for l in code.splitlines() if l.strip() and not l.strip().startswith("#")]
    if len(lines) < 8:
        return False
    body_lines = [l for l in lines if l not in ("trades = []", "return trades", '"""') and
                  not l.startswith("def strategy") and not l.startswith('"""')]
    return len(body_lines) >= 4


def build_context_prompt(sources: list, indicators: list) -> str:
    lines = [
        "You are an expert quantitative trading strategy builder for a crypto backtesting platform.",
        "Always structure responses with three labelled sections:",
        "[Algorithm] — plain-English explanation (3-5 sentences)",
        "[Python Code] — complete implementation",
        "[Parameters] — key parameters with defaults and ranges",
        "",
        "CRITICAL: The df DataFrame passed to strategy() contains EXACTLY these columns.",
        "Use ONLY these column names — do not invent others:",
        "",
        "OHLCV (always available):",
        "  df['open'], df['high'], df['low'], df['close'], df['volume']",
        "  df['time']  — Unix timestamp (int)",
        "  df['date']  — date string YYYY-MM-DD",
    ]

    if "feargreed" in sources:
        lines += [
            "",
            "Fear & Greed Index (merged by date):",
            "  df['fg_value']  — int 0-100 (0=Extreme Fear, 100=Extreme Greed)",
            "  df['fg_class']  — string: 'Extreme Fear'|'Fear'|'Neutral'|'Greed'|'Extreme Greed'",
        ]

    if "unlocks" in sources:
        lines += [
            "",
            "Token Unlocks (separate DataFrame, 2nd arg):",
            "  unlocks['time'], unlocks['daily_new_tokens'], unlocks['cumulative_tokens']",
            "  unlocks['has_cliff_event'], unlocks['cliff_event_tokens'], unlocks['inflation_pct_of_supply']",
        ]

    ind_lines = []
    for ind in indicators:
        iid = ind.get("id", "")
        p   = int(ind.get("period", ind.get("p", 14)))
        col = ind.get("col", f"{iid.upper()}_{p}")
        if iid == "sma":
            ind_lines.append(f"  df['{col}']  — Simple Moving Average, period={p}")
        elif iid == "ema":
            ind_lines.append(f"  df['{col}']  — Exponential Moving Average, period={p}")
        elif iid == "rsi":
            ind_lines.append(f"  df['{col}']  — RSI (0-100), period={p}. Oversold<30, Overbought>70")
        elif iid == "macd":
            fast = ind.get("fast", 12); slow = ind.get("slow", 26); sig = ind.get("signal", 9)
            ind_lines.append(f"  df['MACD']        — MACD line (EMA{fast} - EMA{slow})")
            ind_lines.append(f"  df['MACD_SIGNAL'] — Signal line (EMA{sig} of MACD)")
            ind_lines.append(f"  df['MACD_HIST']   — Histogram (MACD - SIGNAL). Positive=bullish")
        elif iid == "bbands":
            std = ind.get("std", 2.0)
            ind_lines.append(f"  df['BB_UPPER'], df['BB_MID'], df['BB_LOWER']  — Bollinger Bands period={p} std={std}")
            ind_lines.append(f"  df['BB_WIDTH']  — Band width (normalised)")
        elif iid == "atr":
            ind_lines.append(f"  df['{col}']  — Average True Range, period={p} (volatility measure)")
        elif iid == "stoch":
            k = ind.get("k", 14); d = ind.get("d", 3)
            ind_lines.append(f"  df['STOCH_K']  — Stochastic %K, period={k}")
            ind_lines.append(f"  df['STOCH_D']  — Stochastic %D (smoothed), period={d}")
        elif iid == "vwap":
            ind_lines.append("  df['VWAP']  — Volume Weighted Average Price (daily reset)")
        elif iid == "obv":
            ind_lines.append("  df['OBV']  — On Balance Volume (cumulative)")
        elif iid == "wr":
            ind_lines.append(f"  df['{col}']  — Williams %R (-100 to 0), period={p}. Oversold<-80")

    if ind_lines:
        lines += ["", "Pre-computed Technical Indicators (ready to use):"]
        lines += ind_lines

    lines += [
        "",
        "strategy() signature:",
        "  def strategy(df, unlocks):",
        "    # df has all columns above. unlocks is a DataFrame.",
        "    trades = []",
        "    # ... your logic ...",
        "    return trades  # list of dicts with: entry, exit, side, entry_price, exit_price",
        "",
        "NEVER use column names not listed above. NEVER use df['RSI'] if only df['RSI_14'] is listed.",
        "Write the COMPLETE implementation — no placeholders, no '# ...' stubs.",
    ]
    return "\n".join(lines)

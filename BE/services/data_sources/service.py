import datetime as _dt
import os
import time
import threading

from database import db
from config import HAS_DS
from services.data_sources.utils import (
    EXCHANGE_META, SUPPLEMENTARY_META, EXCHANGE_CONNECTORS, SUPP_CONNECTORS,
    SUPP_DATA_TYPES, EXCHANGE_DEFAULT_PAIRS,
    _pairs_cache, _pairs_cache_ts, PAIRS_CACHE_TTL,
)


# ── Exchange / source status ──────────────────────────────────────────────────

def get_exchanges_status() -> list:
    results = []
    for ex_id, meta in EXCHANGE_META.items():
        if ex_id == "kraken":
            online = True
        else:
            conn_cls = EXCHANGE_CONNECTORS.get(ex_id)
            try:
                online = bool(conn_cls and conn_cls.ping())
            except Exception:
                online = False
        results.append({**meta, "id": ex_id, "online": online})
    return results


def get_data_sources_status() -> list:
    results = []
    for src_id, meta in SUPPLEMENTARY_META.items():
        if src_id == "feargreed":
            try:
                conn   = db()
                n      = conn.execute("SELECT COUNT(*) FROM fear_greed").fetchone()[0]
                conn.close()
                online = n > 0
            except Exception:
                online = False
        else:
            conn_cls = SUPP_CONNECTORS.get(src_id)
            try:
                online = bool(conn_cls and conn_cls.ping())
            except Exception:
                online = False
        results.append({
            **meta,
            "id":      src_id,
            "online":  online,
            "has_key": bool(os.environ.get(meta.get("key_env") or "", "")),
        })
    return results


# ── Pair lists ────────────────────────────────────────────────────────────────

def get_kraken_pairs_from_db(q: str = "") -> list:
    conn    = db()
    q_upper = q.strip().upper()
    if q_upper:
        rows = conn.execute(
            "SELECT DISTINCT pair FROM ohlcvt WHERE pair LIKE ? ORDER BY pair LIMIT 40",
            (q_upper + "%",),
        ).fetchall()
        if not rows:
            rows = conn.execute(
                "SELECT DISTINCT pair FROM ohlcvt WHERE pair LIKE ? ORDER BY pair LIMIT 40",
                ("%" + q_upper + "%",),
            ).fetchall()
    else:
        rows = conn.execute("SELECT DISTINCT pair FROM ohlcvt ORDER BY pair LIMIT 40").fetchall()
    conn.close()
    return [r[0] for r in rows]


def get_exchange_pairs(exchange_id: str, q: str = "") -> dict:
    if exchange_id == "kraken":
        try:
            return {"pairs": get_kraken_pairs_from_db(q)}
        except Exception:
            from config import KRAKEN_PAIR_MAP
            return {"pairs": list(KRAKEN_PAIR_MAP.keys())}

    conn_cls = EXCHANGE_CONNECTORS.get(exchange_id)
    if not conn_cls:
        return {"pairs": [], "error": f"Unknown exchange: {exchange_id}"}
    try:
        pairs = conn_cls.fetch_pairs()
        return {"pairs": sorted(pairs)[:2000]}
    except Exception as e:
        return {"pairs": [], "error": str(e)}


def get_ds_pairs(source_id: str, q: str = "") -> dict:
    sid     = source_id.lower()
    q_upper = q.strip().upper()
    q_lower = q.strip().lower()

    if sid == "kraken":
        return {"pairs": get_kraken_pairs_from_db(q)}

    if sid in EXCHANGE_CONNECTORS:
        connector = EXCHANGE_CONNECTORS.get(sid)
        if not connector:
            return {"pairs": []}
        cache_key = f"pairs_{sid}"
        now       = time.time()
        if cache_key not in _pairs_cache or (now - _pairs_cache_ts.get(cache_key, 0)) > PAIRS_CACHE_TTL:
            try:
                _pairs_cache[cache_key]    = connector.fetch_pairs()
                _pairs_cache_ts[cache_key] = now
            except Exception:
                return {"pairs": []}
        all_pairs: list = _pairs_cache.get(cache_key, [])
        filtered        = [p for p in all_pairs if q_upper in p.upper()][:40] if q_upper else all_pairs[:40]
        return {"pairs": filtered}

    # Supplementary sources
    if sid == "defillama":
        import requests as _req
        CHAINS = ["Ethereum","BSC","Arbitrum","Polygon","Avalanche","Solana","Optimism",
                  "Base","Fantom","Cronos","Near","Harmony","Celo","zkSync Era","Linea",
                  "Scroll","Starknet","Manta","Blast","Mantle"]
        chain_matches = [c for c in CHAINS if not q_lower or q_lower in c.lower()]

        proto_key = "defillama_protocols"
        now       = time.time()
        if proto_key not in _pairs_cache:
            def _load():
                try:
                    import requests as _rq
                    r = _rq.get("https://api.llama.fi/protocols", timeout=15)
                    raw = r.json()
                    _pairs_cache[proto_key]    = [(p.get("slug",""), p.get("name","")) for p in raw if p.get("slug") and p.get("name")]
                    _pairs_cache_ts[proto_key] = time.time()
                except Exception:
                    _pairs_cache[proto_key] = []
            threading.Thread(target=_load, daemon=True).start()
        elif (now - _pairs_cache_ts.get(proto_key, 0)) > 300:
            def _refresh():
                try:
                    import requests as _rq
                    r = _rq.get("https://api.llama.fi/protocols", timeout=15)
                    raw = r.json()
                    _pairs_cache[proto_key]    = [(p.get("slug",""), p.get("name","")) for p in raw if p.get("slug") and p.get("name")]
                    _pairs_cache_ts[proto_key] = time.time()
                except Exception:
                    pass
            threading.Thread(target=_refresh, daemon=True).start()

        protocol_list = _pairs_cache.get(proto_key, [])
        proto_matches = [(s, n) for s, n in protocol_list if not q_lower or q_lower in n.lower() or q_lower in s.lower()][:30]

        labels: dict = {}
        pairs:  list = []
        if not q_lower or any(q_lower in c.lower() for c in CHAINS):
            for c in chain_matches[:8]:
                pairs.append(f"chain::{c}")
                labels[f"chain::{c}"] = f"🔗 {c} (Chain TVL)"
        for slug, name in proto_matches[:25]:
            pairs.append(slug)
            labels[slug] = name
        if not pairs and not protocol_list:
            return {"pairs": [], "labels": {}, "note": "Loading protocol list — try typing again in a moment"}
        return {"pairs": pairs, "labels": labels}

    if sid == "coingecko":
        if not q_lower:
            POPULAR = ["bitcoin","ethereum","solana","binancecoin","ripple","cardano",
                       "avalanche-2","dogecoin","polkadot","matic-network","chainlink",
                       "uniswap","litecoin","algorand","stellar"]
            return {"pairs": POPULAR, "labels": {
                "bitcoin":"Bitcoin (BTC)", "ethereum":"Ethereum (ETH)",
                "solana":"Solana (SOL)", "binancecoin":"BNB", "ripple":"XRP",
                "cardano":"Cardano (ADA)", "avalanche-2":"Avalanche (AVAX)",
                "dogecoin":"Dogecoin (DOGE)", "polkadot":"Polkadot (DOT)",
                "matic-network":"Polygon (MATIC)", "chainlink":"Chainlink (LINK)",
                "uniswap":"Uniswap (UNI)", "litecoin":"Litecoin (LTC)",
            }}
        try:
            import requests as _req
            r     = _req.get(f"https://api.coingecko.com/api/v3/search?query={q_lower}", timeout=4)
            coins = r.json().get("coins", [])[:20]
            return {
                "pairs":  [c["id"] for c in coins],
                "labels": {c["id"]: f"{c['name']} ({c['symbol'].upper()})" for c in coins},
            }
        except Exception:
            return {"pairs": [], "labels": {}}

    if sid in ("coinglass", "coinmarketcap"):
        SYMBOLS  = ["BTC","ETH","SOL","BNB","XRP","ADA","AVAX","DOGE","DOT","MATIC",
                    "LINK","LTC","ATOM","NEAR","FTM","ALGO","SAND","AXS","XLM","ICP",
                    "THETA","EOS","CAKE","AAVE","UNI","SUSHI","CRV","SNX","MKR","COMP",
                    "SUI","APT","ARB","OP","INJ","SEI","TIA","PYTH","JUP","STRK"]
        filtered = [s for s in SYMBOLS if not q_upper or q_upper in s][:30]
        return {"pairs": filtered, "labels": {}}

    if sid == "messari":
        ASSETS   = [("bitcoin","Bitcoin (BTC)"),("ethereum","Ethereum (ETH)"),
                    ("solana","Solana (SOL)"),("cardano","Cardano (ADA)"),
                    ("polkadot","Polkadot (DOT)"),("avalanche","Avalanche (AVAX)"),
                    ("chainlink","Chainlink (LINK)"),("uniswap","Uniswap (UNI)"),
                    ("aave","Aave (AAVE)"),("compound","Compound (COMP)"),
                    ("maker","Maker (MKR)"),("curve-dao-token","Curve (CRV)")]
        filtered = [(s, l) for s, l in ASSETS if not q_lower or q_lower in s or q_lower in l.lower()][:20]
        return {"pairs": [s for s, _ in filtered], "labels": {s: l for s, l in filtered}}

    if sid == "feargreed":
        return {"pairs": [], "labels": {}}

    return {"pairs": [], "labels": {}}


def get_ds_data_types(source_id: str) -> dict:
    sid = source_id.lower()
    if sid in EXCHANGE_CONNECTORS or sid == "kraken":
        return {"data_types": ["OHLCVT (candlestick)"]}
    return {"data_types": SUPP_DATA_TYPES.get(sid, [])}


def get_ds_preview(source_id: str, pair: str = "", data_type: str = "") -> dict:
    sid = source_id.lower()

    # ── Exchange OHLCV preview ────────────────────────────────────────────────
    if sid in EXCHANGE_CONNECTORS or sid == "kraken":
        try:
            end_dt   = _dt.datetime.utcnow()
            start_dt = end_dt - _dt.timedelta(days=30)

            if sid == "kraken":
                conn = db()
                prefer = ["BTCUSD","ETHUSD","ADAUSD","SOLUSD","STRKUSD"]
                pair_row = pair.upper() if pair else None
                if not pair_row:
                    for p in prefer:
                        r = conn.execute("SELECT pair FROM ohlcvt WHERE pair=? LIMIT 1", (p,)).fetchone()
                        if r:
                            pair_row = p
                            break
                    if not pair_row:
                        r = conn.execute("SELECT pair FROM ohlcvt LIMIT 1").fetchone()
                        pair_row = r[0] if r else "BTCUSD"
                rows = conn.execute(
                    "SELECT ts AS time, open, high, low, close, volume, vwap, trades "
                    "FROM ohlcvt WHERE pair=? AND interval=1440 ORDER BY ts DESC LIMIT 15",
                    (pair_row,),
                ).fetchall()
                conn.close()
                if not rows:
                    return {"columns": [], "rows": [], "note": f"No Kraken daily data cached for {pair_row}."}
                cols      = ["time (UTC)", "open", "high", "low", "close", "volume", "vwap", "trades"]
                data_rows = []
                for r in reversed(rows):
                    d = dict(r)
                    d["time (UTC)"] = _dt.datetime.utcfromtimestamp(d.pop("time")).strftime("%Y-%m-%d")
                    data_rows.append([str(d.get(c, "") or "") for c in cols])
                return {"columns": cols, "rows": data_rows, "source": "Kraken Local DB", "pair": pair_row}

            connector = EXCHANGE_CONNECTORS.get(sid)
            if not connector:
                return {"error": f"No connector for {sid}", "columns": [], "rows": []}
            pair_sym = (pair.strip().upper() if pair else None) or EXCHANGE_DEFAULT_PAIRS.get(sid, "BTCUSDT")
            df       = connector.fetch_ohlcv(
                symbol=pair_sym, interval_minutes=1440,
                start_ts=int(start_dt.timestamp()), end_ts=int(end_dt.timestamp()),
            )
            if df is None or df.empty:
                return {"columns": [], "rows": [], "note": f"No data returned for {pair}."}
            df = df.tail(15).copy()
            if "ts" in df.columns and "time" not in df.columns:
                df = df.rename(columns={"ts": "time"})
            if "time" in df.columns:
                df["time (UTC)"] = df["time"].apply(
                    lambda t: _dt.datetime.utcfromtimestamp(int(t)).strftime("%Y-%m-%d") if t else ""
                )
                df = df.drop(columns=["time"])
                df = df[["time (UTC)"] + [c for c in df.columns if c != "time (UTC)"]]
            df   = df.round(6)
            cols = list(df.columns)
            rows = [[str(v) if v != "" else "" for v in row] for row in df.fillna("").values.tolist()]
            return {"columns": cols, "rows": rows, "source": sid.title(), "pair": pair}
        except Exception as e:
            return {"error": str(e), "columns": [], "rows": []}

    # ── Supplementary source preview ──────────────────────────────────────────
    connector = SUPP_CONNECTORS.get(sid)
    if not connector and sid not in {"feargreed", "defillama"}:
        return {"error": f"Unknown source: {sid}", "columns": [], "rows": []}

    try:
        if sid == "feargreed":
            conn = db()
            rows = conn.execute(
                "SELECT date AS 'date', value, classification FROM fear_greed ORDER BY date DESC LIMIT 15"
            ).fetchall()
            conn.close()
            if not rows:
                return {"columns": [], "rows": [], "note": "No Fear & Greed data cached."}
            cols = ["date", "value", "classification"]
            return {
                "columns": cols,
                "rows":    [[dict(r).get(c, "") for c in cols] for r in reversed(rows)],
                "source":  "Fear & Greed Index",
            }

        if sid == "defillama":
            import requests as _req
            dt     = data_type.lower() if data_type else ""
            entity = pair.strip() if pair else ""
            try:
                if entity.startswith("chain::") or "chain tvl" in dt:
                    chain_name = entity.replace("chain::", "") if entity.startswith("chain::") else (entity or "Ethereum")
                    r = _req.get(f"https://api.llama.fi/v2/historicalChainTvl/{chain_name}", timeout=12)
                    if r.ok:
                        points = r.json()[-30:]
                        cols   = ["date", "tvl_usd"]
                        rows   = [[_dt.datetime.utcfromtimestamp(int(p["date"])).strftime("%Y-%m-%d"),
                                   str(round(p["tvl"], 2))] for p in points]
                        return {"columns": cols, "rows": rows, "source": f"DefiLlama · {chain_name} Chain TVL", "pair": chain_name}
                    return {"columns": [], "rows": [], "note": f"No TVL data for chain '{chain_name}'."}

                if entity and "stable" not in dt and "yield" not in dt:
                    r = _req.get(f"https://api.llama.fi/protocol/{entity}", timeout=12)
                    if r.ok:
                        tvl_series = r.json().get("tvl", [])[-30:]
                        if tvl_series:
                            cols = ["date", "tvl_usd"]
                            rows = [[_dt.datetime.utcfromtimestamp(int(p["date"])).strftime("%Y-%m-%d"),
                                     str(round(p.get("totalLiquidityUSD", 0), 2))] for p in tvl_series]
                            return {"columns": cols, "rows": rows, "source": f"DefiLlama · {entity} TVL", "pair": entity}

                if "yield" in dt:
                    dll = SUPP_CONNECTORS.get("defillama")
                    if dll:
                        df = dll.fetch_yields()
                        if df is not None and not df.empty:
                            if entity:
                                df = df[df["protocol"].str.lower().str.contains(entity.lower(), na=False)]
                            keep = ["protocol","chain","symbol","apy","tvl_usd","apy_base","apy_reward"]
                            df   = df[[c for c in keep if c in df.columns]].head(30).round(4)
                            return {"columns": list(df.columns), "rows": df.fillna("").values.tolist(),
                                    "source": f"DefiLlama Yield Pools{f' · {entity}' if entity else ''}"}
                    return {"columns": [], "rows": [], "note": "No yield data."}

                if "stable" in dt:
                    dll   = SUPP_CONNECTORS.get("defillama")
                    items = dll.fetch_stablecoins() if dll else []
                    if entity:
                        items = [s for s in items if entity.lower() in (s.get("symbol","") or "").lower()
                                 or entity.lower() in (s.get("name","") or "").lower()] or items
                    cols  = ["name","symbol","pegType","pegMechanism","circulating","price"]
                    rows  = []
                    for s in items[:15]:
                        circ = s.get("circulating", {})
                        if isinstance(circ, dict):
                            circ = circ.get("peggedUSD", "")
                        rows.append([str(s.get("name","")), str(s.get("symbol","")),
                                     str(s.get("pegType","")), str(s.get("pegMechanism","")),
                                     str(round(float(circ), 2) if circ else ""), str(s.get("price",""))])
                    return {"columns": cols, "rows": rows, "source": "DefiLlama Stablecoins"}

                r         = _req.get("https://api.llama.fi/protocols", timeout=10)
                protocols = r.json()[:20] if r.ok else []
                if entity:
                    protocols = [p for p in protocols if entity.lower() in p.get("name","").lower()][:15] or protocols[:15]
                cols = ["name","chain","category","tvl","change_1d","change_7d"]
                rows = [[str(p.get("name","")), str(p.get("chain","")), str(p.get("category","")),
                         str(round(p.get("tvl",0),2)), str(p.get("change_1d","")), str(p.get("change_7d",""))]
                        for p in protocols[:15]]
                return {"columns": cols, "rows": rows, "source": "DefiLlama Protocol TVL"}
            except Exception as e:
                return {"error": f"DefiLlama error: {e}", "columns": [], "rows": []}

        if sid == "coingecko":
            dt = data_type.lower() if data_type else ""
            try:
                import requests as _req
                if "global" in dt:
                    result = connector.fetch_global() if HAS_DS else {}
                    if result and not result.get("error"):
                        cols = list(result.keys())
                        rows = [[str(round(v, 4) if isinstance(v, float) else (v or "")) for v in result.values()]]
                        return {"columns": cols, "rows": rows, "source": "CoinGecko Global"}
                elif "chart" in dt:
                    df = connector.fetch_market_chart("bitcoin", days=15) if HAS_DS else None
                    if df is not None and not df.empty:
                        df2 = df.tail(15).copy()
                        if "time" in df2.columns:
                            df2["date"] = df2["time"].apply(lambda t: _dt.datetime.utcfromtimestamp(int(t)).strftime("%Y-%m-%d"))
                            df2 = df2.drop(columns=["time"])
                        return {"columns": list(df2.round(2).columns), "rows": df2.round(2).fillna("").values.tolist(), "source": "CoinGecko BTC Chart"}
                r     = _req.get("https://api.coingecko.com/api/v3/coins/markets",
                                  params={"vs_currency":"usd","order":"market_cap_desc","per_page":15,"page":1,"sparkline":False},
                                  timeout=10)
                items = r.json() if r.ok else []
                if items and isinstance(items, list):
                    keep = ["name","symbol","current_price","market_cap","total_volume","price_change_percentage_24h"]
                    rows = [[str(round(item.get(c,0),4) if isinstance(item.get(c),float) else (item.get(c) or "")) for c in keep] for item in items]
                    return {"columns": keep, "rows": rows, "source": "CoinGecko Markets"}
            except Exception as eg:
                return {"columns": [], "rows": [], "note": f"CoinGecko error: {eg}"}
            return {"columns": [], "rows": [], "note": "CoinGecko returned no data."}

        if sid == "coinmarketcap":
            try:
                result = connector.fetch_latest_quotes(["BTC","ETH","SOL","BNB","XRP","ADA","AVAX","DOGE","DOT","MATIC"])
                if result and not result.get("error"):
                    cols = ["symbol","price_usd","market_cap_usd","volume_24h_usd","price_change_24h","rank"]
                    rows = [[str(sym)] + [str(round(d.get(c[:-4] if c.endswith("_usd") else c, 0) or 0, 4)) for c in cols[1:]] for sym, d in result.items()]
                    return {"columns": cols, "rows": rows, "source": "CoinMarketCap"}
            except Exception:
                pass
            return {"columns": [], "rows": [], "note": "CMC returned no data (API key may be required)."}

        if sid == "coinglass":
            dt = data_type.lower() if data_type else ""
            try:
                if "open" in dt:
                    result = connector.fetch_open_interest("BTC")
                    if result:
                        cols = list(result.keys())[:10]
                        return {"columns": cols, "rows": [[str(result.get(c,"")) for c in cols]], "source": "Coinglass Open Interest (BTC)"}
                elif "liquid" in dt:
                    df = connector.fetch_liquidations("BTC")
                    if df is not None and not df.empty:
                        return {"columns": list(df.tail(15).round(2).columns), "rows": df.tail(15).round(2).fillna("").values.tolist(), "source": "Coinglass Liquidations (BTC)"}
                elif "long" in dt or "short" in dt:
                    df = connector.fetch_long_short_ratio("BTC")
                    if df is not None and not df.empty:
                        return {"columns": list(df.tail(15).round(4).columns), "rows": df.tail(15).round(4).fillna("").values.tolist(), "source": "Coinglass L/S Ratio (BTC)"}
                else:
                    df = connector.fetch_funding_rates("BTC")
                    if df is not None and not df.empty:
                        return {"columns": list(df.tail(15).round(6).columns), "rows": df.tail(15).round(6).fillna("").values.tolist(), "source": "Coinglass Funding Rates (BTC)"}
            except Exception as e:
                return {"error": f"Coinglass error: {e}", "columns": [], "rows": []}
            return {"columns": [], "rows": [], "note": "Coinglass returned no data (API key may be required)."}

        if sid == "messari":
            dt = data_type.lower() if data_type else ""
            try:
                if "time" in dt or "series" in dt:
                    df = connector.fetch_timeseries("bitcoin", "price-usd", days=15)
                    if df is not None and not df.empty:
                        df2 = df.tail(15).copy()
                        if "time" in df2.columns:
                            df2["date"] = df2["time"].apply(lambda t: _dt.datetime.utcfromtimestamp(int(t)).strftime("%Y-%m-%d"))
                            df2 = df2.drop(columns=["time"])
                        return {"columns": list(df2.columns), "rows": df2.fillna("").values.tolist(), "source": "Messari BTC Price"}
                else:
                    result = connector.fetch_asset_metrics("bitcoin")
                    if result and not result.get("error"):
                        cols = list(result.keys())
                        rows = [[str(round(v, 6) if isinstance(v, float) else (v or "")) for v in result.values()]]
                        return {"columns": cols, "rows": rows, "source": "Messari Asset Metrics"}
            except Exception as e:
                return {"error": f"Messari error: {e}", "columns": [], "rows": []}
            return {"columns": [], "rows": [], "note": "Messari returned no data (API key required)."}

        return {"error": f"No preview method for {sid}", "columns": [], "rows": []}

    except Exception as e:
        return {"error": str(e), "columns": [], "rows": []}


def get_coins_from_db(min_rank=None, max_rank=None, min_volume_24h=None,
                      min_market_cap=None, kraken_only=True, limit=500) -> list:
    conn   = db()
    loaded = {r[0] for r in conn.execute("SELECT DISTINCT pair FROM ohlcvt WHERE interval=1440").fetchall()}
    conds: list  = []
    params: list = []
    if kraken_only:
        conds.append("kraken_pair IS NOT NULL")
    if min_rank is not None:
        conds.append("cmc_rank >= ?"); params.append(min_rank)
    if max_rank is not None:
        conds.append("cmc_rank <= ?"); params.append(max_rank)
    if min_volume_24h is not None:
        conds.append("volume_24h_usd >= ?"); params.append(min_volume_24h)
    if min_market_cap is not None:
        conds.append("market_cap_usd >= ?"); params.append(min_market_cap)
    where = ("WHERE " + " AND ".join(conds)) if conds else ""
    params.append(limit)
    rows = conn.execute(
        f"SELECT symbol, name, cmc_rank, market_cap_usd, volume_24h_usd, "
        f"price_usd, kraken_pair, last_updated FROM coins {where} ORDER BY cmc_rank LIMIT ?",
        params,
    ).fetchall()
    conn.close()
    return [{**dict(r), "in_db": r["kraken_pair"] in loaded if r["kraken_pair"] else False} for r in rows]


def save_api_key(key_name: str, key_value: str) -> dict:
    allowed = {"COINGECKO_API_KEY", "CMC_API_KEY", "COINGLASS_API_KEY", "MESSARI_API_KEY", "GEMINI_API_KEY"}
    if key_name not in allowed:
        return {"error": f"Key name not allowed: {key_name}"}

    from config import BASE_DIR
    env_path = BASE_DIR / ".env"
    lines: list = []
    if env_path.exists():
        lines = env_path.read_text().splitlines()
    found = False
    for i, line in enumerate(lines):
        if line.startswith(f"{key_name}="):
            lines[i] = f"{key_name}={key_value}"
            found = True
            break
    if not found:
        lines.append(f"{key_name}={key_value}")
    env_path.write_text("\n".join(lines) + "\n")
    os.environ[key_name] = key_value
    return {"ok": True, "message": f"{key_name} saved and applied."}

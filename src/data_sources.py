"""
data_sources.py — Exchange OHLCVT + supplementary data connectors
Each exchange connector: fetch_ohlcv(symbol, interval_minutes, start_ts, end_ts) → pd.DataFrame
Each supplementary connector: fetch_*(symbol, ...) → pd.DataFrame or dict
All timestamps are UNIX seconds.
"""

from __future__ import annotations
import os, time, datetime, requests
import pandas as pd

# ── Interval mapping helpers ──────────────────────────────────────────────────
def _minutes_to_binance(m: int) -> str:
    return {1:'1m',3:'3m',5:'5m',15:'15m',30:'30m',60:'1h',120:'2h',
            240:'4h',360:'6h',480:'8h',720:'12h',1440:'1d',4320:'3d',
            10080:'1w'}.get(m, '1d')

def _minutes_to_okx(m: int) -> str:
    return {1:'1m',3:'3m',5:'5m',15:'15m',30:'30m',60:'1H',120:'2H',
            240:'4H',360:'6H',720:'12H',1440:'1D',10080:'1W'}.get(m, '1D')

def _minutes_to_bybit(m: int) -> str:
    return {1:'1',3:'3',5:'5',15:'15',30:'30',60:'60',120:'120',
            240:'240',360:'360',720:'720',1440:'D',10080:'W'}.get(m, 'D')

def _minutes_to_coinbase(m: int) -> str:
    return {1:'ONE_MINUTE',5:'FIVE_MINUTE',15:'FIFTEEN_MINUTE',30:'THIRTY_MINUTE',
            60:'ONE_HOUR',120:'TWO_HOUR',360:'SIX_HOUR',1440:'ONE_DAY'}.get(m, 'ONE_DAY')

def _minutes_to_hyperliquid(m: int) -> str:
    return {1:'1m',3:'3m',5:'5m',15:'15m',30:'30m',60:'1h',120:'2h',
            240:'4h',360:'6h',720:'12h',1440:'1d'}.get(m, '1d')

def _minutes_to_dydx(m: int) -> str:
    return {1:'1MIN',5:'5MINS',15:'15MINS',30:'30MINS',
            60:'1HOUR',240:'4HOURS',1440:'1DAY'}.get(m, '1DAY')

# ── Shared helper ─────────────────────────────────────────────────────────────
def _to_df(rows: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    for c in ['open','high','low','close','volume']:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors='coerce')
    df = df.dropna(subset=['time','open','high','low','close'])
    df['time'] = df['time'].astype(int)
    return df.sort_values('time').reset_index(drop=True)

# ─────────────────────────────────────────────────────────────────────────────
# EXCHANGE CONNECTORS
# ─────────────────────────────────────────────────────────────────────────────

class BinanceConnector:
    """Binance — free, no API key required for market data."""
    id   = 'binance'
    name = 'Binance'
    BASE = 'https://api.binance.com'
    # symbol format: BTCUSDT

    @classmethod
    def ping(cls) -> bool:
        try:
            r = requests.get(f'{cls.BASE}/api/v3/ping', timeout=4)
            return r.status_code == 200
        except Exception:
            return False

    @classmethod
    def fetch_pairs(cls) -> list[str]:
        try:
            r = requests.get(f'{cls.BASE}/api/v3/exchangeInfo', timeout=10)
            data = r.json()
            return [s['symbol'] for s in data.get('symbols', [])
                    if s.get('status') == 'TRADING' and s.get('quoteAsset') in ('USDT','USDC','BTC','ETH')]
        except Exception:
            return []

    @classmethod
    def fetch_ohlcv(cls, symbol: str, interval_minutes: int,
                    start_ts: int, end_ts: int) -> pd.DataFrame:
        """Fetch up to full history via pagination (max 1000 candles/request)."""
        interval = _minutes_to_binance(interval_minutes)
        rows: list[dict] = []
        cursor = start_ts * 1000  # ms
        end_ms = end_ts * 1000

        while cursor < end_ms:
            try:
                r = requests.get(f'{cls.BASE}/api/v3/klines', params={
                    'symbol': symbol, 'interval': interval,
                    'startTime': cursor, 'endTime': end_ms, 'limit': 1000
                }, timeout=10)
                candles = r.json()
                if not candles or isinstance(candles, dict):
                    break
                for c in candles:
                    rows.append({'time': int(c[0])//1000, 'open': c[1], 'high': c[2],
                                 'low': c[3], 'close': c[4], 'volume': c[5]})
                if len(candles) < 1000:
                    break
                cursor = int(candles[-1][0]) + 1
            except Exception:
                break

        return _to_df(rows)


class OKXConnector:
    """OKX — free market data, no key required."""
    id   = 'okx'
    name = 'OKX'
    BASE = 'https://www.okx.com'
    # symbol format: BTC-USDT

    @classmethod
    def ping(cls) -> bool:
        try:
            r = requests.get(f'{cls.BASE}/api/v5/public/time', timeout=4)
            return r.status_code == 200 and r.json().get('code') == '0'
        except Exception:
            return False

    @classmethod
    def fetch_pairs(cls) -> list[str]:
        try:
            r = requests.get(f'{cls.BASE}/api/v5/public/instruments',
                             params={'instType': 'SPOT'}, timeout=10)
            data = r.json()
            return [i['instId'] for i in data.get('data', [])
                    if i.get('quoteCcy') in ('USDT','USDC')]
        except Exception:
            return []

    @classmethod
    def fetch_ohlcv(cls, symbol: str, interval_minutes: int,
                    start_ts: int, end_ts: int) -> pd.DataFrame:
        interval = _minutes_to_okx(interval_minutes)
        rows: list[dict] = []
        # OKX returns newest-first; paginate with 'after' param (oldest ts in ms)
        after_ts: int | None = None
        start_ms = start_ts * 1000
        end_ms   = end_ts   * 1000

        while True:
            params: dict = {'instId': symbol, 'bar': interval, 'limit': '300'}
            if after_ts:
                params['before'] = str(after_ts)
            try:
                r = requests.get(f'{cls.BASE}/api/v5/market/history-candles',
                                 params=params, timeout=10)
                data = r.json().get('data', [])
                if not data:
                    break
                added = 0
                for c in data:
                    t = int(c[0])
                    if t < start_ms:
                        continue
                    if t > end_ms:
                        continue
                    rows.append({'time': t//1000, 'open': c[1], 'high': c[2],
                                 'low': c[3], 'close': c[4], 'volume': c[5]})
                    added += 1
                oldest = int(data[-1][0])
                if oldest <= start_ms or added == 0:
                    break
                after_ts = oldest
            except Exception:
                break

        return _to_df(rows)


class BybitConnector:
    """Bybit — free market data."""
    id   = 'bybit'
    name = 'Bybit'
    BASE = 'https://api.bybit.com'
    # symbol format: BTCUSDT (linear) or BTCUSD (inverse)

    @classmethod
    def ping(cls) -> bool:
        try:
            r = requests.get(f'{cls.BASE}/v5/market/time', timeout=4)
            return r.status_code == 200 and r.json().get('retCode') == 0
        except Exception:
            return False

    @classmethod
    def fetch_pairs(cls) -> list[str]:
        try:
            r = requests.get(f'{cls.BASE}/v5/market/instruments-info',
                             params={'category': 'spot', 'limit': 1000}, timeout=10)
            data = r.json()
            return [i['symbol'] for i in data.get('result', {}).get('list', [])
                    if i.get('quoteCoin') in ('USDT','USDC')]
        except Exception:
            return []

    @classmethod
    def fetch_ohlcv(cls, symbol: str, interval_minutes: int,
                    start_ts: int, end_ts: int) -> pd.DataFrame:
        interval = _minutes_to_bybit(interval_minutes)
        rows: list[dict] = []
        cursor = start_ts * 1000
        end_ms  = end_ts   * 1000

        while cursor < end_ms:
            try:
                r = requests.get(f'{cls.BASE}/v5/market/kline', params={
                    'category': 'spot', 'symbol': symbol, 'interval': interval,
                    'start': cursor, 'end': end_ms, 'limit': 1000
                }, timeout=10)
                data = r.json()
                candles = data.get('result', {}).get('list', [])
                if not candles:
                    break
                for c in candles:
                    rows.append({'time': int(c[0])//1000, 'open': c[1], 'high': c[2],
                                 'low': c[3], 'close': c[4], 'volume': c[5]})
                if len(candles) < 1000:
                    break
                cursor = int(candles[0][0]) + 1  # Bybit returns newest-first
            except Exception:
                break

        return _to_df(rows)


class CoinbaseConnector:
    """Coinbase Advanced — free market data without authentication."""
    id   = 'coinbase'
    name = 'Coinbase'
    BASE = 'https://api.coinbase.com/api/v3/brokerage'
    # symbol format: BTC-USD or BTC-USDC

    @classmethod
    def ping(cls) -> bool:
        try:
            r = requests.get('https://api.coinbase.com/api/v3/brokerage/products',
                             params={'product_type': 'SPOT', 'limit': 1}, timeout=4)
            return r.status_code in (200, 401)  # 401 is expected without auth key
        except Exception:
            return False

    @classmethod
    def fetch_pairs(cls) -> list[str]:
        try:
            r = requests.get(f'{cls.BASE}/products', params={'product_type': 'SPOT'}, timeout=10)
            if r.status_code == 401:
                # Fallback static list
                return ['BTC-USD','ETH-USD','SOL-USD','XRP-USD','ADA-USD',
                        'DOGE-USD','AVAX-USD','LINK-USD','DOT-USD','MATIC-USD']
            data = r.json()
            return [p['product_id'] for p in data.get('products', [])
                    if p.get('quote_currency_id') in ('USD','USDC')]
        except Exception:
            return ['BTC-USD','ETH-USD','SOL-USD']

    @classmethod
    def fetch_ohlcv(cls, symbol: str, interval_minutes: int,
                    start_ts: int, end_ts: int) -> pd.DataFrame:
        granularity = _minutes_to_coinbase(interval_minutes)
        rows: list[dict] = []
        # Coinbase limits to 350 candles per request
        chunk = interval_minutes * 60 * 350
        cursor = start_ts

        while cursor < end_ts:
            chunk_end = min(cursor + chunk, end_ts)
            try:
                r = requests.get(
                    f'{cls.BASE}/products/{symbol}/candles',
                    params={'start': str(cursor), 'end': str(chunk_end),
                            'granularity': granularity}, timeout=10)
                if r.status_code != 200:
                    break
                candles = r.json().get('candles', [])
                for c in candles:
                    rows.append({'time': int(c['start']), 'open': c['open'],
                                 'high': c['high'], 'low': c['low'],
                                 'close': c['close'], 'volume': c['volume']})
                cursor = chunk_end + 1
                time.sleep(0.05)
            except Exception:
                break

        return _to_df(rows)


class HyperliquidConnector:
    """Hyperliquid DEX — free, no key required."""
    id   = 'hyperliquid'
    name = 'Hyperliquid'
    BASE = 'https://api.hyperliquid.xyz/info'
    # symbol format: BTC (coin name, no pair)

    @classmethod
    def ping(cls) -> bool:
        try:
            r = requests.post(cls.BASE, json={'type': 'meta'}, timeout=4)
            return r.status_code == 200
        except Exception:
            return False

    @classmethod
    def fetch_pairs(cls) -> list[str]:
        try:
            r = requests.post(cls.BASE, json={'type': 'meta'}, timeout=10)
            data = r.json()
            return [u['name'] for u in data.get('universe', [])]
        except Exception:
            return []

    @classmethod
    def fetch_ohlcv(cls, symbol: str, interval_minutes: int,
                    start_ts: int, end_ts: int) -> pd.DataFrame:
        interval = _minutes_to_hyperliquid(interval_minutes)
        rows: list[dict] = []
        cursor_ms = start_ts * 1000
        end_ms    = end_ts   * 1000
        chunk_ms  = interval_minutes * 60_000 * 5000  # ~5000 candles per request

        while cursor_ms < end_ms:
            chunk_end = min(cursor_ms + chunk_ms, end_ms)
            try:
                r = requests.post(cls.BASE, json={
                    'type': 'candleSnapshot',
                    'req': {'coin': symbol, 'interval': interval,
                            'startTime': cursor_ms, 'endTime': chunk_end}
                }, timeout=15)
                candles = r.json()
                if not candles or not isinstance(candles, list):
                    break
                for c in candles:
                    rows.append({'time': int(c['t'])//1000, 'open': c['o'],
                                 'high': c['h'], 'low': c['l'],
                                 'close': c['c'], 'volume': c['v']})
                if len(candles) < 100:
                    break
                cursor_ms = int(candles[-1]['t']) + 1
            except Exception:
                break

        return _to_df(rows)


class DYDXConnector:
    """dYdX v4 — free market data from public indexer."""
    id   = 'dydx'
    name = 'dYdX'
    BASE = 'https://indexer.dydx.trade/v4'
    # symbol format: BTC-USD

    @classmethod
    def ping(cls) -> bool:
        try:
            r = requests.get(f'{cls.BASE}/time', timeout=4)
            return r.status_code == 200
        except Exception:
            return False

    @classmethod
    def fetch_pairs(cls) -> list[str]:
        try:
            r = requests.get(f'{cls.BASE}/perpetualMarkets', timeout=10)
            data = r.json()
            return list(data.get('markets', {}).keys())
        except Exception:
            return []

    @classmethod
    def fetch_ohlcv(cls, symbol: str, interval_minutes: int,
                    start_ts: int, end_ts: int) -> pd.DataFrame:
        resolution = _minutes_to_dydx(interval_minutes)
        rows: list[dict] = []
        # dYdX returns newest-first, paginate with fromISO
        from_iso = datetime.datetime.fromtimestamp(start_ts, tz=datetime.timezone.utc).isoformat()
        to_iso   = datetime.datetime.fromtimestamp(end_ts,   tz=datetime.timezone.utc).isoformat()

        try:
            r = requests.get(f'{cls.BASE}/candles/perpetualMarkets/{symbol}',
                             params={'resolution': resolution, 'fromISO': from_iso,
                                     'toISO': to_iso, 'limit': 1000}, timeout=15)
            candles = r.json().get('candles', [])
            for c in candles:
                ts = int(datetime.datetime.fromisoformat(
                    c['startedAt'].replace('Z','+00:00')).timestamp())
                rows.append({'time': ts, 'open': c['open'], 'high': c['high'],
                             'low': c['low'], 'close': c['close'],
                             'volume': c.get('baseTokenVolume', c.get('usdVolume', 0))})
        except Exception:
            pass

        return _to_df(rows)


# ─────────────────────────────────────────────────────────────────────────────
# SUPPLEMENTARY DATA CONNECTORS
# ─────────────────────────────────────────────────────────────────────────────

class CoinGeckoConnector:
    """CoinGecko — free tier (50 req/min without key, 500 with free key)."""
    id   = 'coingecko'
    name = 'CoinGecko'
    BASE = 'https://api.coingecko.com/api/v3'
    KEY_ENV = 'COINGECKO_API_KEY'

    @classmethod
    def _headers(cls) -> dict:
        key = os.environ.get(cls.KEY_ENV, '')
        return {'x-cg-demo-api-key': key} if key else {}

    @classmethod
    def ping(cls) -> bool:
        try:
            r = requests.get(f'{cls.BASE}/ping', headers=cls._headers(), timeout=5)
            return r.status_code == 200
        except Exception:
            return False

    @classmethod
    def fetch_market_data(cls, coin_id: str = 'bitcoin') -> dict:
        """Returns price, market cap, volume, rank, 24h change, etc."""
        try:
            r = requests.get(f'{cls.BASE}/coins/{coin_id}', headers=cls._headers(),
                             params={'localization': 'false', 'sparkline': 'false',
                                     'community_data': 'false', 'developer_data': 'false'},
                             timeout=10)
            data = r.json()
            md = data.get('market_data', {})
            return {
                'coin_id':          coin_id,
                'price_usd':        md.get('current_price', {}).get('usd'),
                'market_cap_usd':   md.get('market_cap', {}).get('usd'),
                'volume_24h_usd':   md.get('total_volume', {}).get('usd'),
                'price_change_24h': md.get('price_change_percentage_24h'),
                'price_change_7d':  md.get('price_change_percentage_7d'),
                'ath_usd':          md.get('ath', {}).get('usd'),
                'ath_change_pct':   md.get('ath_change_percentage', {}).get('usd'),
                'circulating_supply': md.get('circulating_supply'),
                'total_supply':     md.get('total_supply'),
                'market_cap_rank':  data.get('market_cap_rank'),
            }
        except Exception as e:
            return {'error': str(e)}

    @classmethod
    def fetch_market_chart(cls, coin_id: str, days: int = 365) -> pd.DataFrame:
        """Returns daily price, market cap, volume series."""
        try:
            r = requests.get(f'{cls.BASE}/coins/{coin_id}/market_chart',
                             headers=cls._headers(),
                             params={'vs_currency': 'usd', 'days': days,
                                     'interval': 'daily'}, timeout=15)
            data = r.json()
            prices   = data.get('prices', [])
            mktcaps  = {int(p[0])//1000: p[1] for p in data.get('market_caps', [])}
            volumes  = {int(p[0])//1000: p[1] for p in data.get('total_volumes', [])}
            rows = []
            for p in prices:
                t = int(p[0]) // 1000
                rows.append({'time': t, 'price_usd': p[1],
                             'market_cap_usd': mktcaps.get(t),
                             'volume_usd': volumes.get(t)})
            return _to_df(rows)[['time','price_usd','market_cap_usd','volume_usd']]
        except Exception:
            return pd.DataFrame()

    @classmethod
    def fetch_global(cls) -> dict:
        """BTC dominance, total market cap, etc."""
        try:
            r = requests.get(f'{cls.BASE}/global', headers=cls._headers(), timeout=5)
            d = r.json().get('data', {})
            return {
                'total_market_cap_usd': d.get('total_market_cap', {}).get('usd'),
                'total_volume_24h_usd': d.get('total_volume', {}).get('usd'),
                'btc_dominance':        d.get('market_cap_percentage', {}).get('btc'),
                'eth_dominance':        d.get('market_cap_percentage', {}).get('eth'),
                'active_coins':         d.get('active_cryptocurrencies'),
                'markets':              d.get('markets'),
            }
        except Exception as e:
            return {'error': str(e)}


class CoinMarketCapConnector:
    """CoinMarketCap — free tier: 333 req/day. API key required."""
    id   = 'coinmarketcap'
    name = 'CoinMarketCap'
    BASE = 'https://pro-api.coinmarketcap.com/v1'
    KEY_ENV = 'CMC_API_KEY'

    @classmethod
    def _headers(cls) -> dict:
        key = os.environ.get(cls.KEY_ENV, '')
        return {'X-CMC_PRO_API_KEY': key, 'Accept': 'application/json'}

    @classmethod
    def ping(cls) -> bool:
        key = os.environ.get(cls.KEY_ENV, '')
        if not key:
            return False
        try:
            r = requests.get(f'{cls.BASE}/key/info', headers=cls._headers(), timeout=5)
            return r.status_code == 200
        except Exception:
            return False

    @classmethod
    def fetch_latest_quotes(cls, symbols: list[str]) -> dict:
        """Returns price, market cap, volume, rank for symbols."""
        try:
            r = requests.get(f'{cls.BASE}/cryptocurrency/quotes/latest',
                             headers=cls._headers(),
                             params={'symbol': ','.join(symbols), 'convert': 'USD'},
                             timeout=10)
            data = r.json().get('data', {})
            out = {}
            for sym, info in data.items():
                q = (info.get('quote', {}) or {}).get('USD', {}) or {}
                out[sym] = {
                    'price_usd':        q.get('price'),
                    'market_cap_usd':   q.get('market_cap'),
                    'volume_24h_usd':   q.get('volume_24h'),
                    'price_change_24h': q.get('percent_change_24h'),
                    'price_change_7d':  q.get('percent_change_7d'),
                    'rank':             info.get('cmc_rank'),
                    'circulating_supply': info.get('circulating_supply'),
                    'total_supply':     info.get('total_supply'),
                }
            return out
        except Exception as e:
            return {'error': str(e)}

    @classmethod
    def fetch_global_metrics(cls) -> dict:
        try:
            r = requests.get(f'{cls.BASE}/global-metrics/quotes/latest',
                             headers=cls._headers(), timeout=10)
            d = r.json().get('data', {})
            q = (d.get('quote', {}) or {}).get('USD', {}) or {}
            return {
                'total_market_cap_usd':   q.get('total_market_cap'),
                'total_volume_24h_usd':   q.get('total_volume_24h'),
                'btc_dominance':          d.get('btc_dominance'),
                'eth_dominance':          d.get('eth_dominance'),
                'active_cryptocurrencies': d.get('active_cryptocurrencies'),
                'active_exchanges':       d.get('active_exchanges'),
                'defi_volume_24h':        d.get('defi_volume_24h'),
                'defi_market_cap':        d.get('defi_market_cap'),
            }
        except Exception as e:
            return {'error': str(e)}


class CoinglassConnector:
    """Coinglass — derivatives data: funding rates, OI, liquidations, L/S ratio.
    Free tier with API key (50 req/min)."""
    id   = 'coinglass'
    name = 'Coinglass'
    BASE = 'https://open-api.coinglass.com/public/v2'
    KEY_ENV = 'COINGLASS_API_KEY'

    @classmethod
    def _headers(cls) -> dict:
        key = os.environ.get(cls.KEY_ENV, '')
        return {'coinglassSecret': key}

    @classmethod
    def ping(cls) -> bool:
        key = os.environ.get(cls.KEY_ENV, '')
        if not key:
            return False
        try:
            r = requests.get(f'{cls.BASE}/indicator/funding_rates_ohlc',
                             headers=cls._headers(), params={'symbol': 'BTC', 'interval': '1d', 'limit': 1},
                             timeout=5)
            return r.status_code in (200, 429)
        except Exception:
            return False

    @classmethod
    def fetch_funding_rates(cls, symbol: str = 'BTC') -> pd.DataFrame:
        """Current funding rates across exchanges."""
        try:
            r = requests.get(f'{cls.BASE}/funding', headers=cls._headers(),
                             params={'symbol': symbol}, timeout=10)
            data = r.json().get('data', {})
            rows = []
            # data is a dict of exchange -> funding info
            for ex, info in (data.items() if isinstance(data, dict) else []):
                if isinstance(info, list):
                    for item in info:
                        rows.append({'exchange': ex, **item})
                elif isinstance(info, dict):
                    rows.append({'exchange': ex, **info})
            return pd.DataFrame(rows) if rows else pd.DataFrame()
        except Exception:
            return pd.DataFrame()

    @classmethod
    def fetch_open_interest(cls, symbol: str = 'BTC') -> dict:
        """Aggregate open interest across all exchanges."""
        try:
            r = requests.get(f'{cls.BASE}/open_interest',
                             headers=cls._headers(), params={'symbol': symbol}, timeout=10)
            return r.json().get('data', {})
        except Exception:
            return {}

    @classmethod
    def fetch_liquidations(cls, symbol: str = 'BTC', interval: str = '1d') -> pd.DataFrame:
        """Historical liquidation data."""
        try:
            r = requests.get(f'{cls.BASE}/indicator/liquidation_history',
                             headers=cls._headers(),
                             params={'symbol': symbol, 'interval': interval, 'limit': 365},
                             timeout=10)
            raw = r.json().get('data', [])
            if not raw:
                return pd.DataFrame()
            rows = []
            for item in raw:
                rows.append({'time': int(item.get('t', 0))//1000 if item.get('t', 0) > 1e10 else int(item.get('t', 0)),
                             'long_liq_usd': item.get('buyUsdAmt', 0),
                             'short_liq_usd': item.get('sellUsdAmt', 0)})
            return _to_df(rows) if rows else pd.DataFrame()
        except Exception:
            return pd.DataFrame()

    @classmethod
    def fetch_long_short_ratio(cls, symbol: str = 'BTC', interval: str = '1d') -> pd.DataFrame:
        try:
            r = requests.get(f'{cls.BASE}/indicator/long_short_ratio',
                             headers=cls._headers(),
                             params={'symbol': symbol, 'interval': interval, 'limit': 365},
                             timeout=10)
            raw = r.json().get('data', [])
            rows = []
            for item in raw:
                t = int(item.get('t', 0))
                if t > 1e10:
                    t = t // 1000
                rows.append({'time': t, 'long_ratio': item.get('longRatio'),
                             'short_ratio': item.get('shortRatio'),
                             'long_short_ratio': item.get('longShortRatio')})
            return _to_df(rows) if rows else pd.DataFrame()
        except Exception:
            return pd.DataFrame()


class MessariConnector:
    """Messari — free tier with API key. On-chain metrics, asset profiles."""
    id   = 'messari'
    name = 'Messari'
    BASE = 'https://data.messari.io/api/v1'
    KEY_ENV = 'MESSARI_API_KEY'

    @classmethod
    def _headers(cls) -> dict:
        key = os.environ.get(cls.KEY_ENV, '')
        return {'x-messari-api-key': key} if key else {}

    @classmethod
    def ping(cls) -> bool:
        try:
            r = requests.get(f'{cls.BASE}/assets/bitcoin/metrics',
                             headers=cls._headers(), timeout=5)
            return r.status_code in (200, 401)
        except Exception:
            return False

    @classmethod
    def fetch_asset_metrics(cls, asset: str = 'bitcoin') -> dict:
        """On-chain + market metrics for an asset."""
        try:
            r = requests.get(f'{cls.BASE}/assets/{asset}/metrics',
                             headers=cls._headers(), timeout=10)
            data = r.json().get('data', {})
            metrics = data.get('metrics', {})
            m = metrics.get('market_data', {})
            on = metrics.get('on_chain_data', {})
            return {
                'price_usd':            m.get('price_usd'),
                'volume_last_24h':      m.get('volume_last_24_hours'),
                'real_volume_last_24h': m.get('real_volume_last_24_hours'),
                'percent_change_24h':   m.get('percent_change_usd_last_24_hours'),
                'ohlcv_last_24h':       m.get('ohlcv_last_24_hour'),
                'txn_count_last_24h':   on.get('txn_count_last_24_hours'),
                'active_addresses':     on.get('active_addresses'),
                'transfer_erc20_count': on.get('transfer_erc_20_count'),
            }
        except Exception as e:
            return {'error': str(e)}

    @classmethod
    def fetch_timeseries(cls, asset: str, metric: str, days: int = 365) -> pd.DataFrame:
        """Timeseries for a specific metric (e.g. 'sma_7_day_price_return_usd')."""
        try:
            end   = datetime.datetime.utcnow().strftime('%Y-%m-%d')
            start = (datetime.datetime.utcnow() - datetime.timedelta(days=days)).strftime('%Y-%m-%d')
            r = requests.get(f'{cls.BASE}/assets/{asset}/metrics/{metric}/time-series',
                             headers=cls._headers(),
                             params={'start': start, 'end': end, 'interval': '1d'},
                             timeout=10)
            raw = r.json().get('data', {}).get('values', [])
            rows = [{'time': int(datetime.datetime.fromisoformat(v[0]).timestamp()),
                     metric: v[1]} for v in raw if len(v) >= 2]
            return _to_df(rows) if rows else pd.DataFrame()
        except Exception:
            return pd.DataFrame()


class DefiLlamaConnector:
    """DefiLlama — completely free, no key required."""
    id   = 'defillama'
    name = 'DefiLlama'
    BASE = 'https://api.llama.fi'

    @classmethod
    def ping(cls) -> bool:
        try:
            r = requests.get(f'{cls.BASE}/chains', timeout=5)
            return r.status_code == 200
        except Exception:
            return False

    @classmethod
    def fetch_protocol_tvl(cls, protocol_slug: str) -> pd.DataFrame:
        """Historical TVL for a protocol."""
        try:
            r = requests.get(f'{cls.BASE}/protocol/{protocol_slug}', timeout=10)
            data = r.json()
            rows = [{'time': int(p['date']), 'tvl_usd': p['totalLiquidityUSD']}
                    for p in data.get('tvl', [])]
            return _to_df(rows) if rows else pd.DataFrame()
        except Exception:
            return pd.DataFrame()

    @classmethod
    def fetch_chain_tvl(cls, chain: str = 'Ethereum') -> pd.DataFrame:
        """Historical TVL for a chain."""
        try:
            r = requests.get(f'{cls.BASE}/v2/historicalChainTvl/{chain}', timeout=10)
            rows = [{'time': int(p['date']), 'tvl_usd': p['tvl']} for p in r.json()]
            return _to_df(rows) if rows else pd.DataFrame()
        except Exception:
            return pd.DataFrame()

    @classmethod
    def fetch_yields(cls) -> pd.DataFrame:
        """Yield farming opportunities across DeFi."""
        try:
            r = requests.get('https://yields.llama.fi/pools', timeout=10)
            pools = r.json().get('data', [])
            rows = []
            for p in pools[:500]:  # Limit for performance
                rows.append({
                    'pool_id':  p.get('pool'),
                    'protocol': p.get('project'),
                    'chain':    p.get('chain'),
                    'symbol':   p.get('symbol'),
                    'apy':      p.get('apy'),
                    'tvl_usd':  p.get('tvlUsd'),
                    'apy_base': p.get('apyBase'),
                    'apy_reward': p.get('apyReward'),
                })
            return pd.DataFrame(rows)
        except Exception:
            return pd.DataFrame()

    @classmethod
    def fetch_token_unlocks(cls, protocol: str) -> pd.DataFrame:
        """Token unlock events for a protocol."""
        try:
            r = requests.get(f'https://api.llama.fi/unlocks/{protocol}', timeout=10)
            data = r.json()
            rows = []
            for event in data.get('events', []):
                rows.append({'time': int(event.get('timestamp', 0)),
                             'amount_usd': event.get('unlocked', 0),
                             'event_type': event.get('type', 'unlock'),
                             'protocol': protocol})
            return pd.DataFrame(rows) if rows else pd.DataFrame()
        except Exception:
            return pd.DataFrame()

    @classmethod
    def fetch_stablecoins(cls) -> list[dict]:
        """Stablecoin market cap and peg data."""
        try:
            r = requests.get('https://stablecoins.llama.fi/stablecoins', timeout=10)
            return r.json().get('peggedAssets', [])[:50]
        except Exception:
            return []


# ─────────────────────────────────────────────────────────────────────────────
# REGISTRY
# ─────────────────────────────────────────────────────────────────────────────

EXCHANGE_CONNECTORS: dict[str, type] = {
    'binance':     BinanceConnector,
    'kraken':      None,           # handled natively in api.py
    'okx':         OKXConnector,
    'bybit':       BybitConnector,
    'coinbase':    CoinbaseConnector,
    'hyperliquid': HyperliquidConnector,
    'dydx':        DYDXConnector,
}

SUPPLEMENTARY_CONNECTORS: dict[str, type] = {
    'coingecko':    CoinGeckoConnector,
    'coinmarketcap': CoinMarketCapConnector,
    'coinglass':    CoinglassConnector,
    'messari':      MessariConnector,
    'defillama':    DefiLlamaConnector,
}

def get_exchange(exchange_id: str):
    """Return connector class for an exchange, or None for Kraken (native)."""
    return EXCHANGE_CONNECTORS.get(exchange_id)

def get_supplementary(source_id: str):
    return SUPPLEMENTARY_CONNECTORS.get(source_id)

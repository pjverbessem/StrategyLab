// Pairs
export interface Pair {
  pair: string
  name: string
  color: string
  intervals: number[]
  start: string
  end: string
  count: number
}

// OHLCVT candle
export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  vwap: number
  trades: number
}

// Token unlock
export interface UnlockEvent {
  time: number
  category: string
  amount: number
  event_type: string
  note: string
}

export interface UpcomingCliff {
  pair: string
  time: number
  cliff_event_tokens: number
  category: string
  date_str: string
  color: string
  name: string
  amount_fmt: string
}

export interface FearGreedEntry {
  date: string
  timestamp_utc: number
  value: number
  classification: string
  source: string
}

// Backtest
export interface Trade {
  entry: number
  exit: number
  side: 'long' | 'short'
  entry_price: number
  exit_price: number
  return_pct: number
}

export interface EquityPoint {
  time: number
  value: number
}

export interface BacktestStats {
  total_return: number
  win_rate: number
  total_trades: number
  winning_trades: number
  losing_trades: number
  max_drawdown: number
  profit_factor: number
  avg_win: number
  avg_loss: number
}

export interface BacktestResult {
  trades: Trade[]
  equity: EquityPoint[]
  stats: BacktestStats
  ohlcv: Candle[]
  indicator_data: Record<string, { time: number; value: number }[]>
  indicator_meta: Record<string, { type: 'price' | 'oscillator'; range: [number, number] | null; group: string }>
  error: string | null
}

export interface BacktestRequest {
  pair: string
  interval: number
  start?: string
  end?: string
  script: string
  indicators?: unknown[]
  exchange?: string
}

// Strategy
export interface BacktestResultSummary {
  net_pnl?: number
  total_return?: number
  win_rate?: number
  max_drawdown?: number
  profit_factor?: number
  sharpe_ratio?: number
  total_trades?: number
}

export interface Strategy {
  id: string
  name: string
  description: string
  code: string
  algo: string
  params_text: string
  pair: string
  interval: number
  stats: Partial<BacktestStats>
  backtest_results?: BacktestResultSummary
  tags: string[]
  created_at: number
  updated_at: number
}

export interface SaveStrategyRequest {
  name: string
  description?: string
  code: string
  algo?: string
  params_text?: string
  pair?: string
  interval?: number
  stats?: Partial<BacktestStats>
  tags?: string[]
}

// Bot / Trading
export interface BotStatus {
  running: boolean
  strategy_id: string | null
  strategy_name: string
  pair: string | null
  interval: number
  allocation: number
  position: 'long' | 'short' | null
  position_qty: number
  entry_price: number | null
  entry_time: number | null
  order_id: string | null
  realized_pnl: number
  unrealized_pnl: number
  logs: BotLog[]
  started_at: number | null
  last_tick: number | null
  last_signal: string | null
}

export interface BotLog {
  ts: number
  level: string
  msg: string
  meta: Record<string, unknown>
}

export interface KrakenStatus {
  connected: boolean
  key_prefix?: string
  error?: string
}

export interface LivePrice {
  pair: string
  bid: number
  ask: number
  last: number
  high24: number
  low24: number
  volume24: number
  vwap24: number
  trades24: number
  ts: number
  error?: string
}

// Data sources
export interface Exchange {
  id: string
  name: string
  icon: string
  color: string
  pairs_hint: string
  key_required: boolean
  description: string
  online: boolean
}

export interface DataSource {
  id: string
  name: string
  icon: string
  color: string
  key_env: string | null
  key_required: boolean
  description: string
  online: boolean
  has_key: boolean
}

export interface DataPreview {
  columns: string[]
  rows: string[][]
  source?: string
  pair?: string
  note?: string
  error?: string
}

// Chat
export interface ChatMessage {
  role: 'user' | 'model'
  text: string
}

export interface ChatRequest {
  message: string
  system?: string
  history?: ChatMessage[]
  current_code?: string
  selected_sources?: string[]
  selected_indicators?: unknown[]
}

export interface ChatResponse {
  reply: string
  error: string | null
}

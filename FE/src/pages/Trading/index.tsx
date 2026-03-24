import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { tradingApi } from '@/api/trading'
import { strategiesApi } from '@/api/strategies'
import { useBotStatus } from '@/hooks/useBotStatus'
import type { BotLog } from '@/types'

const PAIR_OPTIONS = ['XBTUSD', 'ETHUSD', 'STRKUSD', 'ARBUSD', 'OPUSD', 'ZKUSD']
const INTERVAL_OPTIONS = [
  { label: '1h', val: '60' },
  { label: '4h', val: '240' },
  { label: '1D', val: '1440' },
]

function formatUptime(startedAt: number): string {
  const secs = Math.floor(Date.now() / 1000) - startedAt
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return `${h}h ${m}m`
}

function logClass(level?: string): string {
  if (level === 'error') return 'err'
  if (level === 'success') return 'ok'
  if (level === 'warn') return 'warn'
  return ''
}

export function Trading() {
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [strategyId, setStrategyId] = useState('')
  const [pair, setPair] = useState('STRKUSD')
  const [interval, setIntervalVal] = useState('1440')
  const [allocation, setAllocation] = useState(10)

  const { data: krakenStatus, refetch: refetchStatus } = useQuery({
    queryKey: ['krakenStatus'],
    queryFn: tradingApi.krakenStatus,
    refetchInterval: 30000,
  })

  const { data: balanceData, refetch: refetchBalance } = useQuery({
    queryKey: ['krakenBalance'],
    queryFn: tradingApi.krakenBalance,
    enabled: krakenStatus?.connected === true,
  })

  const { data: strategies = [] } = useQuery({
    queryKey: ['strategies'],
    queryFn: strategiesApi.list,
  })

  const { data: botStatus } = useBotStatus()

  const connectMutation = useMutation({
    mutationFn: () => tradingApi.krakenSetKeys({ api_key: apiKey, api_secret: apiSecret }),
    onSuccess: (data) => {
      if (data.ok) {
        setApiKey('')
        setApiSecret('')
        refetchStatus()
      }
    },
  })

  const disconnectMutation = useMutation({
    mutationFn: () => tradingApi.krakenSetKeys({ api_key: '', api_secret: '' }),
    onSuccess: () => refetchStatus(),
  })

  const startMutation = useMutation({
    mutationFn: () =>
      tradingApi.botStart({
        strategy_id: strategyId,
        pair,
        interval: Number(interval),
        allocation,
      }),
  })

  const stopMutation = useMutation({
    mutationFn: tradingApi.botStop,
  })

  const connected = krakenStatus?.connected === true
  const running = botStatus?.running === true
  const logs: BotLog[] = botStatus?.logs ?? []

  const balances = balanceData?.balances
    ? Object.entries(balanceData.balances).filter(([, v]) => (v as number) > 0.000001)
    : []

  function handleConnect() {
    if (!apiKey.trim() || !apiSecret.trim()) return
    connectMutation.mutate()
  }

  function handleStart() {
    if (!connected || !strategyId) return
    startMutation.mutate()
  }

  function handleStop() {
    stopMutation.mutate()
  }

  const unrealizedPnl = botStatus?.unrealized_pnl ?? 0
  const realizedPnl = botStatus?.realized_pnl ?? 0

  return (
    <div className="trading-layout">
      {/* Left sidebar: connection + config */}
      <aside className="trading-sidebar">
        {/* Kraken connection */}
        <section className="trading-section">
          <div className="trading-section-header">
            <span className="trading-section-title">Kraken API</span>
            <span className={`trading-conn-badge ${connected ? 'connected' : 'disconnected'}`} id="tradingConnBadge">
              {connected ? `✓ Kraken (${krakenStatus?.key_prefix ?? ''})` : '✗ Not connected'}
            </span>
          </div>

          {!connected && (
            <div id="connKrakenForm" className="trading-form">
              <label className="trading-label">API Key</label>
              <input
                type="password"
                id="connApiKey"
                className="trading-input"
                placeholder="Enter API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <label className="trading-label">API Secret</label>
              <input
                type="password"
                id="connApiSecret"
                className="trading-input"
                placeholder="Enter API secret"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
              />
              <button
                id="connConnectBtn"
                className="btn-primary"
                style={{ width: '100%', marginTop: 8 }}
                disabled={connectMutation.isPending || !apiKey.trim() || !apiSecret.trim()}
                onClick={handleConnect}
              >
                {connectMutation.isPending ? 'Verifying…' : 'Connect'}
              </button>
              {connectMutation.isError && (
                <div style={{ color: 'var(--neg)', fontSize: 12, marginTop: 6 }}>
                  Connection failed. Check your credentials.
                </div>
              )}
            </div>
          )}

          {connected && (
            <div id="connBalances">
              <div className="trading-balance-header">
                <span className="trading-label">Balances</span>
                <button
                  className="btn-xs"
                  id="connBalanceRefreshBtn"
                  onClick={() => refetchBalance()}
                >
                  Refresh
                </button>
              </div>
              <div className="conn-balance-grid" id="connBalanceGrid">
                {balances.length === 0 && (
                  <div className="trading-empty-hint">No balances found</div>
                )}
                {balances.map(([coin, val]) => (
                  <div key={coin} className="conn-balance-cell">
                    <div className="conn-balance-coin">{coin}</div>
                    <div className="conn-balance-val">
                      {(val as number) >= 1
                        ? (val as number).toFixed(4)
                        : (val as number).toFixed(8)}
                    </div>
                  </div>
                ))}
              </div>
              <button
                id="connDisconnectBtn"
                className="btn-outline"
                style={{ width: '100%', marginTop: 10 }}
                onClick={() => disconnectMutation.mutate()}
                disabled={disconnectMutation.isPending}
              >
                Disconnect
              </button>
            </div>
          )}
        </section>

        {/* Strategy config */}
        <section className="trading-section">
          <div className="trading-section-header">
            <span className="trading-section-title">Bot Configuration</span>
          </div>
          <div className="trading-form">
            <label className="trading-label">Strategy</label>
            <select
              id="tradingStrategySelect"
              className="trading-select"
              value={strategyId}
              onChange={(e) => setStrategyId(e.target.value)}
            >
              <option value="">— Select a strategy —</option>
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            {strategies.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>
                No strategies found — create one in Creator
              </div>
            )}

            <label className="trading-label" style={{ marginTop: 10 }}>Pair</label>
            <select
              id="tradingPairSelect"
              className="trading-select"
              value={pair}
              onChange={(e) => setPair(e.target.value)}
            >
              {PAIR_OPTIONS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>

            <label className="trading-label" style={{ marginTop: 10 }}>Interval</label>
            <select
              id="tradingIntervalSelect"
              className="trading-select"
              value={interval}
              onChange={(e) => setIntervalVal(e.target.value)}
            >
              {INTERVAL_OPTIONS.map((iv) => (
                <option key={iv.val} value={iv.val}>{iv.label}</option>
              ))}
            </select>

            <label className="trading-label" style={{ marginTop: 10 }}>Allocation (%)</label>
            <input
              type="number"
              id="tradingAllocation"
              className="trading-input"
              min={1}
              max={100}
              step={1}
              value={allocation}
              onChange={(e) => setAllocation(+e.target.value)}
            />

            <div className="trading-btn-row" style={{ marginTop: 14 }}>
              <button
                id="tradingStartBtn"
                className="btn-primary"
                style={{ flex: 1 }}
                disabled={running || !connected || !strategyId || startMutation.isPending}
                onClick={handleStart}
              >
                {startMutation.isPending ? 'Starting…' : '▶ Start'}
              </button>
              <button
                id="tradingStopBtn"
                className="btn-outline"
                style={{ flex: 1 }}
                disabled={!running || stopMutation.isPending}
                onClick={handleStop}
              >
                ■ Stop
              </button>
            </div>

            {!connected && (
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 8 }}>
                Connect Kraken above to enable trading
              </div>
            )}
          </div>
        </section>
      </aside>

      {/* Main area: status + log */}
      <main className="trading-main">
        {/* Status banner */}
        {running && (
          <div className="trading-run-banner" id="tradingRunBanner">
            <div className="trading-indicator-dot active" id="tradingIndicatorDot" />
            <span id="tradingStatusText">
              Running · {botStatus?.strategy_name ?? ''}
            </span>
            {botStatus?.started_at && (
              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }} id="tradingUptime">
                {formatUptime(botStatus.started_at)}
              </span>
            )}
          </div>
        )}

        {!running && (
          <div className="trading-idle-banner">
            <div className="trading-indicator-dot inactive" id="tradingIndicatorDot" />
            <span id="tradingStatusText">Inactive</span>
          </div>
        )}

        {/* Metrics strip */}
        <div className="trading-metrics-strip">
          <div className="trading-metric-cell">
            <div className="trading-metric-label">Signal</div>
            <div className="trading-metric-val" id="tradingMetricSignal">
              {botStatus?.last_signal ? botStatus.last_signal.toUpperCase() : '—'}
            </div>
          </div>
          <div className="trading-metric-cell">
            <div className="trading-metric-label">Position</div>
            <div className="trading-metric-val" id="tradingMetricPosition">
              {botStatus?.position ? botStatus.position.toUpperCase() : 'Flat'}
            </div>
          </div>
          <div className="trading-metric-cell">
            <div className="trading-metric-label">Pair</div>
            <div className="trading-metric-val" id="tradingMetricPair">
              {botStatus?.pair ?? '—'}
            </div>
          </div>
          <div className="trading-metric-cell">
            <div className="trading-metric-label">Entry Price</div>
            <div className="trading-metric-val" id="tradingMetricEntry">
              {botStatus?.entry_price ? `$${botStatus.entry_price.toFixed(4)}` : '—'}
            </div>
          </div>
          <div className="trading-metric-cell">
            <div className="trading-metric-label">Unrealized P&L</div>
            <div
              className={`trading-metric-val ${unrealizedPnl > 0 ? 'pos' : unrealizedPnl < 0 ? 'neg' : ''}`}
              id="tradingMetricUnrealized"
            >
              {(unrealizedPnl >= 0 ? '+' : '') + '$' + unrealizedPnl.toFixed(4)}
            </div>
          </div>
          <div className="trading-metric-cell">
            <div className="trading-metric-label">Realized P&L</div>
            <div
              className={`trading-metric-val ${realizedPnl > 0 ? 'pos' : realizedPnl < 0 ? 'neg' : ''}`}
              id="tradingMetricRealized"
            >
              {(realizedPnl >= 0 ? '+' : '') + '$' + realizedPnl.toFixed(4)}
            </div>
          </div>
          {botStatus?.last_tick && (
            <div className="trading-metric-cell">
              <div className="trading-metric-label">Last Tick</div>
              <div className="trading-metric-val" id="tradingLastTick" style={{ fontSize: 11 }}>
                {new Date(botStatus.last_tick * 1000).toLocaleTimeString()}
              </div>
            </div>
          )}
        </div>

        {/* Activity log */}
        <div className="trading-log-panel">
          <div className="trading-log-header">Activity Log</div>
          <div className="trading-log" id="tradingLog">
            {logs.length === 0 ? (
              <div className="trading-log-empty">No activity yet</div>
            ) : (
              logs.map((l, i) => (
                <div key={i} className={`trading-log-row ${logClass(l.level)}`}>
                  <span className="trading-log-time">
                    {new Date(l.ts * 1000).toLocaleTimeString()}
                  </span>
                  <span className="trading-log-msg">{l.msg}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

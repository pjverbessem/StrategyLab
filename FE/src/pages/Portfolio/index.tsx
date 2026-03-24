import { useQuery } from '@tanstack/react-query'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js'
import { Bar, Doughnut } from 'react-chartjs-2'
import { strategiesApi } from '@/api/strategies'
import { tradingApi } from '@/api/trading'
import type { Strategy, BotStatus } from '@/types'

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Title, Tooltip, Legend)

const PAIR_LABELS: Record<string, string> = {
  ARBUSD: 'ARB/USD',
  OPUSD: 'OP/USD',
  STRKUSD: 'STRK/USD',
  ZKUSD: 'ZK/USD',
}

const CHART_PALETTE = [
  '#12B947', '#0ea5e9', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6',
  '#f97316', '#6366f1', '#84cc16', '#06b6d4',
]

function fmt$(v: number): string {
  return (v >= 0 ? '+' : '') + '$' + Math.abs(v).toFixed(4)
}

function fmtPct(v: number): string {
  return (v * (v <= 1 ? 100 : 1)).toFixed(1) + '%'
}

function sumArr(arr: Strategy[], fn: (s: Strategy) => number): number {
  return arr.reduce((a, x) => a + (fn(x) || 0), 0)
}

function avgArr(arr: Strategy[], fn: (s: Strategy) => number | null, skipNull = false): number {
  const vals = arr.map(fn).filter((v): v is number => skipNull ? v !== null && v !== undefined : true) as number[]
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
}

export function Portfolio() {
  const { data: strategies = [], isLoading, refetch } = useQuery({
    queryKey: ['strategies'],
    queryFn: strategiesApi.list,
  })

  const { data: botStatus } = useQuery<BotStatus>({
    queryKey: ['botStatus'],
    queryFn: tradingApi.botStatus,
    refetchInterval: 10000,
  })

  const withBT = strategies.filter((s) => s.backtest_results)

  // Aggregates
  const totalPnl = sumArr(withBT, (s) => s.backtest_results?.net_pnl ?? 0)
  const avgWinRate = avgArr(withBT, (s) => s.backtest_results?.win_rate ?? 0)
  const avgPF = avgArr(withBT, (s) => s.backtest_results?.profit_factor ?? 0)
  const avgSharpe = avgArr(
    withBT,
    (s) => s.backtest_results?.sharpe_ratio ?? null,
    true
  )
  const totalTrades = sumArr(withBT, (s) => s.backtest_results?.total_trades ?? 0)

  const worstDD = withBT.length
    ? withBT.reduce((a, b) =>
        (b.backtest_results?.max_drawdown ?? 0) > (a.backtest_results?.max_drawdown ?? 0) ? b : a
      )
    : null

  const bestStrat = withBT.length
    ? withBT.reduce((a, b) =>
        (b.backtest_results?.net_pnl ?? -Infinity) > (a.backtest_results?.net_pnl ?? -Infinity)
          ? b
          : a
      )
    : null

  const pairCounts: Record<string, number> = {}
  strategies.forEach((s) => {
    const p = s.pair || 'Unknown'
    pairCounts[p] = (pairCounts[p] || 0) + 1
  })
  const uniquePairs = Object.keys(pairCounts).length

  const activeCount = botStatus?.running ? 1 : 0
  const totalAlloc = sumArr(strategies, (s) => parseFloat((s as any).allocation || '10'))
  const roi = totalAlloc > 0 ? (totalPnl / totalAlloc) * 100 : null

  const corrLabel = uniquePairs >= 4 ? 'Low' : uniquePairs >= 2 ? 'Moderate' : 'High'
  const corrClass = uniquePairs >= 4 ? 'pos' : uniquePairs >= 2 ? '' : 'neg'

  // P&L chart data
  const pnlLabels = withBT.map((s) => (s.name || s.id || 'Unnamed').slice(0, 22))
  const pnlValues = withBT.map((s) => +(s.backtest_results?.net_pnl ?? 0).toFixed(4))
  const pnlColors = pnlValues.map((v) => (v >= 0 ? 'rgba(18,185,71,.75)' : 'rgba(220,38,38,.7)'))
  const pnlBorders = pnlValues.map((v) => (v >= 0 ? '#12B947' : '#dc2626'))

  // Alloc chart data
  const allocLabels = Object.keys(pairCounts).map((p) => PAIR_LABELS[p] || p)
  const allocValues = Object.values(pairCounts)

  const runningId = botStatus?.running ? botStatus.strategy_id : null

  return (
    <div className="port-page">
      <div className="port-header">
        <h2 className="port-title">Portfolio</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 11, color: 'var(--t3)' }} id="portUpdated">
            Updated {new Date().toLocaleTimeString()}
          </span>
          <button className="btn-outline" id="portRefreshBtn" onClick={() => refetch()} disabled={isLoading}>
            {isLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="port-kpi-strip">
        <div className="port-kpi-card">
          <div className="port-kpi-label">Strategies</div>
          <div className="port-kpi-val" id="portKpiCount">{strategies.length}</div>
          <div className="port-kpi-sub" id="portKpiActive">
            {activeCount ? `${activeCount} running` : 'none running'}
          </div>
        </div>

        <div className="port-kpi-card">
          <div className="port-kpi-label">Total P&L</div>
          <div
            className={`port-kpi-val ${totalPnl > 0 ? 'pos' : totalPnl < 0 ? 'neg' : ''}`}
            id="portKpiPnl"
          >
            {withBT.length ? fmt$(totalPnl) : '—'}
          </div>
          <div className="port-kpi-sub" id="portKpiPnlSub">
            {withBT.length ? `${withBT.length} backtested` : 'no backtests yet'}
          </div>
        </div>

        <div className="port-kpi-card">
          <div className="port-kpi-label">Avg Win Rate</div>
          <div className="port-kpi-val" id="portKpiWinRate">
            {withBT.length ? fmtPct(avgWinRate) : '—'}
          </div>
        </div>

        <div className="port-kpi-card">
          <div className="port-kpi-label">Best Strategy</div>
          <div className="port-kpi-val" id="portKpiBest" style={{ fontSize: 13 }}>
            {bestStrat ? bestStrat.name || bestStrat.id : '—'}
          </div>
          {bestStrat && (
            <div
              className={`port-kpi-sub ${(bestStrat.backtest_results?.net_pnl ?? 0) > 0 ? 'pos' : 'neg'}`}
              id="portKpiBestVal"
            >
              {fmt$(bestStrat.backtest_results?.net_pnl ?? 0)}
            </div>
          )}
        </div>

        <div className="port-kpi-card">
          <div className="port-kpi-label">Worst Drawdown</div>
          <div className={`port-kpi-val neg`} id="portKpiDD">
            {worstDD ? fmtPct(worstDD.backtest_results?.max_drawdown ?? 0) : '—'}
          </div>
          {worstDD && (
            <div className="port-kpi-sub" id="portKpiDDName">
              {worstDD.name || worstDD.id || ''}
            </div>
          )}
        </div>

        <div className="port-kpi-card">
          <div className="port-kpi-label">Avg Profit Factor</div>
          <div className="port-kpi-val" id="portKpiPF">
            {withBT.length ? (avgPF > 0 ? avgPF.toFixed(2) : '—') : '—'}
          </div>
        </div>
      </div>

      {/* Charts row */}
      <div className="port-charts-row">
        <div className="port-chart-panel">
          <div className="port-chart-title">Net P&L by Strategy</div>
          {withBT.length === 0 ? (
            <div className="port-chart-empty" id="portPnlEmpty">
              No backtested strategies yet
            </div>
          ) : (
            <div style={{ height: 200 }} id="portPnlChart">
              <Bar
                data={{
                  labels: pnlLabels,
                  datasets: [
                    {
                      label: 'Net P&L ($)',
                      data: pnlValues,
                      backgroundColor: pnlColors,
                      borderColor: pnlBorders,
                      borderWidth: 1,
                      borderRadius: 4,
                    },
                  ],
                }}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    legend: { display: false },
                    tooltip: {
                      callbacks: {
                        label: (ctx) => ' $' + (ctx.parsed.y as number).toFixed(4),
                      },
                    },
                  },
                  scales: {
                    x: {
                      grid: { display: false },
                      ticks: { font: { family: 'Inter', size: 10 }, color: '#9b9285' },
                    },
                    y: {
                      grid: { color: 'rgba(0,0,0,.06)' },
                      ticks: {
                        font: { family: 'Inter', size: 10 },
                        color: '#9b9285',
                        callback: (v) => '$' + v,
                      },
                    },
                  },
                }}
              />
            </div>
          )}
        </div>

        <div className="port-chart-panel">
          <div className="port-chart-title">Exposure by Pair</div>
          {strategies.length === 0 ? (
            <div className="port-chart-empty" id="portAllocEmpty">
              No strategies saved yet
            </div>
          ) : (
            <div style={{ height: 200 }} id="portAllocChart">
              <Doughnut
                data={{
                  labels: allocLabels,
                  datasets: [
                    {
                      data: allocValues,
                      backgroundColor: CHART_PALETTE.slice(0, allocLabels.length),
                      borderColor: '#F5F4F1',
                      borderWidth: 3,
                      hoverOffset: 6,
                    },
                  ],
                }}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  cutout: '62%',
                  plugins: {
                    legend: {
                      position: 'bottom',
                      labels: {
                        font: { family: 'Inter', size: 10 },
                        color: '#6b6256',
                        padding: 12,
                        boxWidth: 10,
                        boxHeight: 10,
                      },
                    },
                    tooltip: {
                      callbacks: {
                        label: (ctx) =>
                          ` ${ctx.label}: ${ctx.parsed} strat${(ctx.parsed as number) > 1 ? 's' : ''}`,
                      },
                    },
                  },
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Risk grid */}
      <div className="port-risk-grid">
        <div className="port-risk-card">
          <div className="port-risk-label">Avg Sharpe</div>
          <div
            className={`port-risk-val ${avgSharpe > 1 ? 'pos' : avgSharpe < 0 ? 'neg' : ''}`}
            id="portRiskSharpe"
          >
            {withBT.length ? avgSharpe.toFixed(2) : '—'}
          </div>
        </div>
        <div className="port-risk-card">
          <div className="port-risk-label">Worst Drawdown</div>
          <div className="port-risk-val neg" id="portRiskDD">
            {worstDD ? fmtPct(worstDD.backtest_results?.max_drawdown ?? 0) : '—'}
          </div>
        </div>
        <div className="port-risk-card">
          <div className="port-risk-label">Avg Win Rate</div>
          <div
            className={`port-risk-val ${avgWinRate > 55 ? 'pos' : avgWinRate < 40 ? 'neg' : ''}`}
            id="portRiskWin"
          >
            {withBT.length ? fmtPct(avgWinRate) : '—'}
          </div>
        </div>
        <div className="port-risk-card">
          <div className="port-risk-label">Avg Profit Factor</div>
          <div
            className={`port-risk-val ${avgPF > 1.5 ? 'pos' : avgPF < 1 ? 'neg' : ''}`}
            id="portRiskPF"
          >
            {withBT.length && avgPF > 0 ? avgPF.toFixed(2) : '—'}
          </div>
        </div>
        <div className="port-risk-card">
          <div className="port-risk-label">Total Trades</div>
          <div className="port-risk-val" id="portRiskTrades">{totalTrades || '—'}</div>
        </div>
        <div className="port-risk-card">
          <div className="port-risk-label">Diversification</div>
          <div className="port-risk-val" id="portRiskDiv">
            {uniquePairs
              ? `${uniquePairs} pair${uniquePairs > 1 ? 's' : ''}, ${strategies.length} strat${strategies.length !== 1 ? 's' : ''}`
              : '—'}
          </div>
        </div>
        <div className="port-risk-card">
          <div className="port-risk-label">Correlation</div>
          <div className={`port-risk-val ${corrClass}`} id="portRiskCorr">
            {corrLabel}
          </div>
        </div>
        <div className="port-risk-card">
          <div className="port-risk-label">Portfolio ROI</div>
          <div
            className={`port-risk-val ${roi !== null ? (roi > 0 ? 'pos' : roi < 0 ? 'neg' : '') : ''}`}
            id="portRiskROI"
          >
            {roi !== null ? (roi >= 0 ? '+' : '') + roi.toFixed(1) + '%' : '—'}
          </div>
        </div>
      </div>

      {/* Strategy table */}
      <div className="port-strat-section">
        <div className="port-strat-header">
          <span className="port-strat-title">Strategies</span>
          <span className="port-strat-count" id="portStratCount">
            {strategies.length} strateg{strategies.length !== 1 ? 'ies' : 'y'}
          </span>
        </div>
        <div className="port-table-wrap">
          <table className="port-table">
            <thead>
              <tr>
                <th className="port-th">Name</th>
                <th className="port-th">Pair</th>
                <th className="port-th">Status</th>
                <th className="port-th port-td-r">Trades</th>
                <th className="port-th port-td-r">Win Rate</th>
                <th className="port-th port-td-r">Net P&L</th>
                <th className="port-th port-td-r">Drawdown</th>
                <th className="port-th port-td-r">Prof. Factor</th>
                <th className="port-th port-td-r">Sharpe</th>
              </tr>
            </thead>
            <tbody id="portStratTable">
              {strategies.length === 0 && (
                <tr>
                  <td colSpan={9} className="port-table-empty">
                    No strategies saved yet — create one in Creator
                  </td>
                </tr>
              )}
              {strategies.map((s) => {
                const bt = s.backtest_results
                const isLive = s.id === runningId
                const pairLabel = PAIR_LABELS[s.pair ?? ''] || s.pair || '—'

                const statusBadge = isLive ? (
                  <span className="port-status-badge port-status-live">Live</span>
                ) : bt ? (
                  <span className="port-status-badge port-status-bt">Backtested</span>
                ) : (
                  <span className="port-status-badge port-status-draft">Draft</span>
                )

                if (!bt) {
                  return (
                    <tr key={s.id}>
                      <td className="port-td-name">{s.name || s.id || 'Unnamed'}</td>
                      <td>{pairLabel}</td>
                      <td>{statusBadge}</td>
                      <td className="port-td-r" colSpan={6} style={{ color: 'var(--t3)', fontStyle: 'italic' }}>
                        No backtest data
                      </td>
                    </tr>
                  )
                }

                const pnl = bt.net_pnl ?? 0
                const dd = bt.max_drawdown ?? 0
                const wr = bt.win_rate ?? 0
                const pf = bt.profit_factor ?? 0
                const sh = bt.sharpe_ratio ?? null

                return (
                  <tr key={s.id}>
                    <td className="port-td-name">{s.name || s.id || 'Unnamed'}</td>
                    <td>{pairLabel}</td>
                    <td>{statusBadge}</td>
                    <td className="port-td-r">{bt.total_trades ?? '—'}</td>
                    <td className={`port-td-r ${wr > 55 ? 'pos' : wr < 40 ? 'neg' : ''}`}>
                      {fmtPct(wr)}
                    </td>
                    <td className={`port-td-r ${pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : ''}`}>
                      {fmt$(pnl)}
                    </td>
                    <td className="port-td-r neg">{dd > 0 ? fmtPct(dd) : '—'}</td>
                    <td className={`port-td-r ${pf > 1.5 ? 'pos' : pf < 1 ? 'neg' : ''}`}>
                      {pf > 0 ? pf.toFixed(2) : '—'}
                    </td>
                    <td className={`port-td-r ${sh !== null ? (sh > 1 ? 'pos' : sh < 0 ? 'neg' : '') : ''}`}>
                      {sh !== null ? sh.toFixed(2) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { marketDataApi } from '@/api/marketData'
import { useAppStore } from '@/store'
import type { Pair } from '@/types'

const PAIR_COLORS: Record<string, string> = {
  ARBUSD: '#0891b2',
  OPUSD: '#dc2626',
  STRKUSD: '#7c3aed',
  ZKUSD: '#2563eb',
}
const FEATURED_PAIRS = ['ARBUSD', 'OPUSD', 'STRKUSD', 'ZKUSD']

const INTERVALS = [
  { label: '1h', val: 60 },
  { label: '4h', val: 240 },
  { label: '1D', val: 1440 },
]

const DATA_SOURCES = [
  { key: 'price', label: 'Price', desc: 'OHLCVT candles from Kraken', icon: '📈', required: true },
  { key: 'feargreed', label: 'Fear & Greed', desc: 'Crypto sentiment index (0–100)', icon: '😰' },
  { key: 'unlocks', label: 'Token Unlocks', desc: 'Vesting/unlock schedule events', icon: '🔓' },
]

interface Indicator {
  id: string
  label: string
  col: string
  params: { name: string; label: string; default: number; min: number; max: number; step: number }[]
  preview: (vals: Record<string, number>) => string
}

const INDICATORS: Indicator[] = [
  {
    id: 'sma',
    label: 'SMA',
    col: 'SMA_{period}',
    params: [{ name: 'period', label: 'Period', default: 20, min: 2, max: 200, step: 1 }],
    preview: (v) => `df['SMA_${v.period}']`,
  },
  {
    id: 'ema',
    label: 'EMA',
    col: 'EMA_{period}',
    params: [{ name: 'period', label: 'Period', default: 20, min: 2, max: 200, step: 1 }],
    preview: (v) => `df['EMA_${v.period}']`,
  },
  {
    id: 'rsi',
    label: 'RSI',
    col: 'RSI_{period}',
    params: [{ name: 'period', label: 'Period', default: 14, min: 2, max: 100, step: 1 }],
    preview: (v) => `df['RSI_${v.period}']`,
  },
  {
    id: 'macd',
    label: 'MACD',
    col: 'MACD',
    params: [
      { name: 'fast', label: 'Fast', default: 12, min: 2, max: 50, step: 1 },
      { name: 'slow', label: 'Slow', default: 26, min: 5, max: 100, step: 1 },
      { name: 'signal', label: 'Signal', default: 9, min: 2, max: 50, step: 1 },
    ],
    preview: () => `df['MACD'], df['MACD_SIGNAL'], df['MACD_HIST']`,
  },
  {
    id: 'bbands',
    label: 'Bollinger Bands',
    col: 'BB_UPPER',
    params: [
      { name: 'period', label: 'Period', default: 20, min: 5, max: 100, step: 1 },
      { name: 'std', label: 'StdDev', default: 2, min: 1, max: 4, step: 0.5 },
    ],
    preview: () => `df['BB_UPPER'], df['BB_MID'], df['BB_LOWER'], df['BB_WIDTH']`,
  },
  {
    id: 'atr',
    label: 'ATR',
    col: 'ATR_{period}',
    params: [{ name: 'period', label: 'Period', default: 14, min: 2, max: 100, step: 1 }],
    preview: (v) => `df['ATR_${v.period}']`,
  },
  {
    id: 'stoch',
    label: 'Stochastic',
    col: 'STOCH_K',
    params: [
      { name: 'k', label: 'K', default: 14, min: 2, max: 50, step: 1 },
      { name: 'd', label: 'D', default: 3, min: 1, max: 20, step: 1 },
    ],
    preview: () => `df['STOCH_K'], df['STOCH_D']`,
  },
  {
    id: 'vwap',
    label: 'VWAP',
    col: 'VWAP',
    params: [],
    preview: () => `df['VWAP']`,
  },
  {
    id: 'obv',
    label: 'OBV',
    col: 'OBV',
    params: [],
    preview: () => `df['OBV']`,
  },
  {
    id: 'wr',
    label: "Williams %R",
    col: 'WR_{period}',
    params: [{ name: 'period', label: 'Period', default: 14, min: 2, max: 100, step: 1 }],
    preview: (v) => `df['WR_${v.period}']`,
  },
]

function today() {
  return new Date().toISOString().slice(0, 10)
}

export function Initiator() {
  const navigate = useNavigate()
  const setSelectedPair = useAppStore((s) => s.setPair)
  const setSelectedInterval = useAppStore((s) => s.setInterval)

  const { data: pairsData } = useQuery({
    queryKey: ['pairs'],
    queryFn: marketDataApi.getPairs,
    staleTime: 5 * 60 * 1000,
  })

  const pairs: Pair[] = pairsData ?? []

  const [selectedPair, setLocalPair] = useState('STRKUSD')
  const [selectedInterval, setLocalInterval] = useState(1440)
  const [datasets, setDatasets] = useState<Set<string>>(new Set(['price']))
  const [enabledIndicators, setEnabledIndicators] = useState<Set<string>>(new Set())
  const [indicatorParams, setIndicatorParams] = useState<Record<string, Record<string, number>>>(() =>
    Object.fromEntries(INDICATORS.map((ind) => [ind.id, Object.fromEntries(ind.params.map((p) => [p.name, p.default]))]))
  )
  const [startDate, setStartDate] = useState('2024-04-01')
  const [endDate, setEndDate] = useState(today())
  const [prompt, setPrompt] = useState('')
  const [launching, setLaunching] = useState(false)

  useEffect(() => {
    const pd = pairs.find((p) => (typeof p === 'string' ? p : p.pair) === selectedPair)
    if (pd && typeof pd === 'object') {
      setStartDate(pd.start || '2024-01-01')
      setEndDate(pd.end || today())
    }
  }, [selectedPair, pairs])

  const featured = pairs.length > 0
    ? pairs.filter((p) => {
        const sym = typeof p === 'string' ? p : p.pair
        return FEATURED_PAIRS.includes(sym)
      })
    : FEATURED_PAIRS.map(sym => ({
        pair: sym,
        name: sym.replace('USD', ''),
        color: PAIR_COLORS[sym] || '#6366f1',
        intervals: [1440],
        start: '2024-04-01',
        end: new Date().toISOString().slice(0, 10),
        count: 0,
      } as Pair))

  const others = pairs.filter((p) => {
    const sym = typeof p === 'string' ? p : p.pair
    return !FEATURED_PAIRS.includes(sym)
  })

  function toggleDataset(key: string) {
    if (key === 'price') return // price always required
    setDatasets((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleIndicator(id: string) {
    setEnabledIndicators((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function setParam(indId: string, paramName: string, value: number) {
    setIndicatorParams((prev) => ({
      ...prev,
      [indId]: { ...prev[indId], [paramName]: value },
    }))
  }

  async function launch() {
    if (!prompt.trim()) return
    setLaunching(true)

    const dsLabels: Record<string, string> = {
      price: 'Kraken OHLCVT price data (open, high, low, close, volume)',
      feargreed: "Crypto Fear & Greed Index → df['fg_value'] (0-100), df['fg_class']",
      unlocks: 'Token unlock/vesting schedule → unlocks DataFrame',
    }
    const datasetList = [...datasets]
    const dataDesc = datasetList.map((k) => `  • ${dsLabels[k] || k}`).join('\n')
    const pairLabel = selectedPair.replace('USD', '')
    const intLabel = { 60: '1-hour', 240: '4-hour', 1440: 'daily' }[selectedInterval] ?? 'daily'

    const activeInds = INDICATORS.filter((ind) => enabledIndicators.has(ind.id))
    const indDesc = activeInds.length
      ? '\nPre-computed indicators ready in df:\n' +
        activeInds
          .map((ind) => {
            const params = indicatorParams[ind.id] ?? {}
            return `  • ${ind.preview(params)}`
          })
          .join('\n')
      : ''

    const hasFg = datasetList.includes('feargreed')
    const enrichedPrompt = `${prompt.trim()}

Context:
  - Pair: ${pairLabel}/USD · Interval: ${intLabel} · Period: ${startDate} → ${endDate}
  - Data sources:\n${dataDesc}${indDesc}

IMPORTANT: Use ONLY the exact column names listed above. Do not invent or derive other column names.
Use def strategy(df, unlocks${hasFg ? ', fear_greed_df' : ''}):
Return list of trade dicts: entry_time, exit_time, side ('long'/'short'), entry_price, exit_price.`

    // Save config to sessionStorage for Creator to pick up
    sessionStorage.setItem(
      'initConfig',
      JSON.stringify({
        pair: selectedPair,
        interval: selectedInterval,
        start: startDate,
        end: endDate,
        datasets: datasetList,
        indicators: activeInds.map((ind) => ({ id: ind.id, ...indicatorParams[ind.id] })),
        enrichedPrompt,
      })
    )

    setSelectedPair(selectedPair)
    setSelectedInterval(selectedInterval)

    setLaunching(false)
    navigate('/')
  }

  const indCount = enabledIndicators.size

  return (
    <div className="init-wrap">
      <div className="init-header">
        <h2 className="init-title">Strategy Initiator</h2>
        <p className="init-subtitle">Configure your strategy context, then describe what you want to build.</p>
      </div>

      {/* Pair Selection */}
      <section className="init-section">
        <h3 className="init-section-title">Asset Pair</h3>
        <div id="initPairChips">
          <div className="init-pair-row featured-row">
            {featured.map((p) => {
              const sym = typeof p === 'string' ? p : p.pair
              const color = PAIR_COLORS[sym] || '#6366f1'
              const active = sym === selectedPair
              return (
                <button
                  key={sym}
                  className={`init-pair-chip init-pair-chip-featured${active ? ' active' : ''}`}
                  style={{ '--chip-color': color } as React.CSSProperties}
                  onClick={() => setLocalPair(sym)}
                >
                  {sym.replace('USD', '')}
                </button>
              )
            })}
          </div>
          {others.length > 0 && (
            <details className="init-pair-more">
              <summary>All pairs ({pairs.length} available)</summary>
              <div className="init-pair-row init-pair-row-all">
                {others.map((p) => {
                  const sym = typeof p === 'string' ? p : p.pair
                  const color = PAIR_COLORS[sym] || '#6366f1'
                  const active = sym === selectedPair
                  return (
                    <button
                      key={sym}
                      className={`init-pair-chip${active ? ' active' : ''}`}
                      style={{ '--chip-color': color } as React.CSSProperties}
                      onClick={() => setLocalPair(sym)}
                    >
                      {sym.replace('USD', '')}
                    </button>
                  )
                })}
              </div>
            </details>
          )}
        </div>
      </section>

      {/* Date Range + Interval */}
      <section className="init-section init-section-row">
        <div className="init-field">
          <label className="init-label">Start Date</label>
          <input
            type="date"
            id="initStart"
            className="init-date-input"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div className="init-field">
          <label className="init-label">End Date</label>
          <input
            type="date"
            id="initEnd"
            className="init-date-input"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>
        <div className="init-field">
          <label className="init-label">Interval</label>
          <div className="init-int-group" id="initIntervalGroup">
            {INTERVALS.map((iv) => (
              <button
                key={iv.val}
                className={`init-int-btn${selectedInterval === iv.val ? ' active' : ''}`}
                data-val={iv.val}
                onClick={() => setLocalInterval(iv.val)}
              >
                {iv.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Data Sources */}
      <section className="init-section">
        <h3 className="init-section-title">Data Sources</h3>
        <div className="init-ds-grid">
          {DATA_SOURCES.map((ds) => (
            <div
              key={ds.key}
              className={`init-ds-card${datasets.has(ds.key) ? ' checked' : ''}`}
              data-key={ds.key}
              onClick={() => toggleDataset(ds.key)}
            >
              <input
                type="checkbox"
                checked={datasets.has(ds.key)}
                readOnly
                className="init-ds-cb"
                onClick={(e) => e.stopPropagation()}
              />
              <span className="init-ds-icon">{ds.icon}</span>
              <div>
                <div className="init-ds-label">{ds.label}</div>
                <div className="init-ds-desc">{ds.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Indicators */}
      <section className="init-section">
        <h3 className="init-section-title">
          Technical Indicators
          {indCount > 0 && <span className="init-ind-badge" id="initIndCount">{indCount} selected</span>}
        </h3>
        <div className="init-ind-grid">
          {INDICATORS.map((ind) => {
            const active = enabledIndicators.has(ind.id)
            const params = indicatorParams[ind.id] ?? {}
            return (
              <div
                key={ind.id}
                className={`init-ind-card${active ? ' active' : ''}`}
                data-id={ind.id}
              >
                <div className="init-ind-header" onClick={() => toggleIndicator(ind.id)}>
                  <input
                    type="checkbox"
                    className="init-ind-cb"
                    checked={active}
                    onChange={() => toggleIndicator(ind.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span className="init-ind-name">{ind.label}</span>
                </div>
                {active && (
                  <div className="init-ind-params" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {ind.params.map((param) => (
                      <label key={param.name} className="init-ind-param-label">
                        <span>{param.label}</span>
                        <input
                          type="number"
                          className="init-ind-param"
                          data-param={param.name}
                          value={params[param.name] ?? param.default}
                          min={param.min}
                          max={param.max}
                          step={param.step}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setParam(ind.id, param.name, +e.target.value)}
                        />
                      </label>
                    ))}
                    <div className="init-ind-col-preview">{ind.preview(params)}</div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* Prompt */}
      <section className="init-section">
        <h3 className="init-section-title">Describe Your Strategy</h3>
        <textarea
          id="initPrompt"
          className="init-prompt-ta"
          placeholder="e.g. Buy when RSI crosses above 30 and price is above SMA(50), sell when RSI crosses 70 or price drops 5% below entry. Use stop-loss and take-profit."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
        />
        <div className="init-char-row">
          <span
            id="initCharCount"
            className={`init-char-count${prompt.length > 400 ? ' warn' : ''}`}
          >
            {prompt.length} chars
          </span>
        </div>
      </section>

      {/* Launch */}
      <div className="init-launch-row">
        <button
          id="initLaunchBtn"
          className="init-launch-btn"
          disabled={!prompt.trim() || launching}
          onClick={launch}
        >
          {launching ? 'Launching…' : 'Launch in Creator →'}
        </button>
      </div>
    </div>
  )
}

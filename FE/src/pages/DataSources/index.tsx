import { useState, useRef, useEffect, useCallback } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { dataSourcesApi } from '@/api/dataSources'
import type { Exchange, DataSource, DataPreview } from '@/types'

const STATIC_EXCHANGES = [
  { id: 'binance', icon: 'B', name: 'Binance', color: '#f0b90b' },
  { id: 'bybit', icon: 'By', name: 'Bybit', color: '#f7a600' },
  { id: 'coinbase', icon: 'C', name: 'Coinbase', color: '#0052ff' },
  { id: 'dydx', icon: 'D', name: 'dYdX', color: '#6c7c99' },
  { id: 'hyperliquid', icon: 'H', name: 'Hyperliquid', color: '#4ade80' },
  { id: 'kraken', icon: 'K', name: 'Kraken', color: '#5741d9' },
  { id: 'okx', icon: 'O', name: 'OKX', color: '#1a56db' },
]

const STATIC_SUPPS = [
  { id: 'coingecko', icon: '🦎', name: 'CoinGecko', sub: 'Market cap' },
  { id: 'coinglass', icon: '📊', name: 'Coinglass', sub: 'OI · funding' },
  { id: 'coinmarketcap', icon: '📈', name: 'CMC', sub: 'Rankings' },
  { id: 'defillama', icon: '🦙', name: 'DefiLlama', sub: 'TVL · yields' },
  { id: 'feargreed', icon: '😱', name: 'Fear & Greed', sub: 'Daily index' },
  { id: 'messari', icon: '🔗', name: 'Messari', sub: 'On-chain' },
]

interface InvModalState {
  open: boolean
  sourceId: string
  sourceName: string
  kind: 'exchange' | 'supp'
  icon: string
  dataTypes: string[]
  selectedType: string
  entityValue: string
  entityDisplay: string
  dropdownItems: string[]
  dropdownLabels: Record<string, string>
  previewData: DataPreview | null
  previewLoading: boolean
  previewError: string
}

function entityConfig(sourceId: string, kind: string, dataType: string) {
  const dt = (dataType || '').toLowerCase()
  if (kind === 'exchange') {
    return { show: true, label: 'Trading Pair', placeholder: 'Type to search pairs… e.g. BTCUSDT' }
  }
  if (sourceId === 'feargreed') return { show: false, label: '', placeholder: '' }
  if (sourceId === 'defillama') {
    if (dt.includes('chain')) return { show: true, label: 'Blockchain', placeholder: 'e.g. Ethereum, Arbitrum, Solana…' }
    if (dt.includes('stable')) return { show: true, label: 'Stablecoin', placeholder: 'e.g. USDT, USDC, DAI…' }
    if (dt.includes('yield')) return { show: true, label: 'Protocol / Pool', placeholder: 'e.g. Aave, Curve, Uniswap…' }
    return { show: true, label: 'Protocol', placeholder: 'e.g. Lido, Aave, MakerDAO…' }
  }
  if (sourceId === 'coingecko') return { show: true, label: 'Coin', placeholder: 'e.g. bitcoin, ethereum, solana…' }
  if (sourceId === 'coinglass') return { show: true, label: 'Asset Symbol', placeholder: 'e.g. BTC, ETH, SOL…' }
  if (sourceId === 'messari') return { show: true, label: 'Asset', placeholder: 'e.g. bitcoin, ethereum, solana…' }
  if (sourceId === 'coinmarketcap') return { show: true, label: 'Symbol', placeholder: 'e.g. BTC, ETH, SOL…' }
  return { show: false, label: '', placeholder: '' }
}

const DEFAULT_INV: InvModalState = {
  open: false,
  sourceId: '',
  sourceName: '',
  kind: 'exchange',
  icon: '',
  dataTypes: [],
  selectedType: '',
  entityValue: '',
  entityDisplay: '',
  dropdownItems: [],
  dropdownLabels: {},
  previewData: null,
  previewLoading: false,
  previewError: '',
}

export function DataSources() {
  const [selectedExchange, setSelectedExchange] = useState(
    () => localStorage.getItem('selectedExchange') || 'kraken'
  )
  const [activeSources, setActiveSources] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('activeSources') || '{}') }
    catch { return {} }
  })
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [askOpen, setAskOpen] = useState(false)
  const [askText, setAskText] = useState('')
  const [inv, setInv] = useState<InvModalState>(DEFAULT_INV)
  const [toast, setToast] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { data: exchangeData = [] } = useQuery<Exchange[]>({
    queryKey: ['exchanges'],
    queryFn: dataSourcesApi.getExchanges,
    staleTime: 60000,
  })

  const { data: sourcesData = [] } = useQuery<DataSource[]>({
    queryKey: ['dataSources'],
    queryFn: dataSourcesApi.getDataSources,
    staleTime: 60000,
  })

  const saveKeyMutation = useMutation({
    mutationFn: ({ keyName, keyValue }: { keyName: string; keyValue: string }) =>
      dataSourcesApi.saveApiKey(keyName, keyValue),
    onSuccess: (data) => {
      if (data.ok) showToast('Key saved successfully')
      else showToast('Failed to save key: ' + data.error)
    },
  })

  // Resolve display data: use API response if available, otherwise fall back to static lists
  const exchanges: Array<Exchange & { icon?: string; color?: string }> = exchangeData.length
    ? exchangeData.map((ex) => {
        const stat = STATIC_EXCHANGES.find((s) => s.id === ex.id) || {}
        return { ...stat, ...ex } as Exchange & { icon?: string; color?: string }
      })
    : (STATIC_EXCHANGES as any)

  const sources: Array<DataSource & { icon?: string; sub?: string }> = sourcesData.length
    ? sourcesData.map((src) => {
        const stat = STATIC_SUPPS.find((s) => s.id === src.id) || {}
        return { ...stat, ...src } as DataSource & { icon?: string; sub?: string }
      })
    : (STATIC_SUPPS as any)

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  function selectExchange(id: string) {
    setSelectedExchange(id)
    localStorage.setItem('selectedExchange', id)
  }

  function toggleSource(id: string, active: boolean) {
    const next = { ...activeSources, [id]: active }
    setActiveSources(next)
    localStorage.setItem('activeSources', JSON.stringify(next))
  }

  function saveKey(srcId: string, keyEnv: string) {
    const val = apiKeys[srcId]?.trim()
    if (!val) return
    saveKeyMutation.mutate({ keyName: keyEnv, keyValue: val })
    setApiKeys((prev) => ({ ...prev, [srcId]: '' }))
  }

  // Investigate modal
  async function openInvestigate(sourceId: string, sourceName: string, kind: 'exchange' | 'supp') {
    const allMeta = [...STATIC_EXCHANGES, ...STATIC_SUPPS]
    const meta = allMeta.find((m) => m.id === sourceId) || {}
    const icon = (meta as any).icon || '📊'

    setInv({
      ...DEFAULT_INV,
      open: true,
      sourceId,
      sourceName,
      kind,
      icon,
      dataTypes: [],
      selectedType: '',
      entityValue: '',
      entityDisplay: '',
    })

    // Load data types
    try {
      const data = await dataSourcesApi.getDsDataTypes(sourceId)
      const types: string[] = data.data_types || []
      const firstType = types[0] || ''

      // If no entity needed (e.g. feargreed), fetch suggestions immediately
      const cfg = entityConfig(sourceId, kind, firstType)
      let suggestions: { pairs: string[]; labels?: Record<string, string> } = { pairs: [], labels: {} }
      if (!cfg.show || kind === 'supp') {
        try {
          suggestions = await dataSourcesApi.getDsPairs(sourceId, '', firstType)
        } catch {}
      }

      setInv((prev) => ({
        ...prev,
        dataTypes: types,
        selectedType: firstType,
        dropdownItems: suggestions.pairs || [],
        dropdownLabels: suggestions.labels || {},
      }))
    } catch {
      setInv((prev) => ({ ...prev, dataTypes: [] }))
    }
  }

  function closeInvestigate() {
    setInv(DEFAULT_INV)
  }

  async function onTypeSelect(type: string) {
    setInv((prev) => ({
      ...prev,
      selectedType: type,
      entityValue: '',
      entityDisplay: '',
      dropdownItems: [],
    }))

    const cfg = entityConfig(inv.sourceId, inv.kind, type)
    if (cfg.show && inv.kind === 'supp') {
      try {
        const data = await dataSourcesApi.getDsPairs(inv.sourceId, '', type)
        setInv((prev) => ({
          ...prev,
          dropdownItems: data.pairs || [],
          dropdownLabels: data.labels || {},
        }))
      } catch {}
    }
  }

  async function onPairInput(q: string) {
    setInv((prev) => ({ ...prev, entityDisplay: q, entityValue: '' }))
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      if (q.length < 1 && inv.kind === 'exchange') {
        setInv((prev) => ({ ...prev, dropdownItems: [] }))
        return
      }
      try {
        const data = await dataSourcesApi.getDsPairs(inv.sourceId, q, inv.selectedType)
        setInv((prev) => ({
          ...prev,
          dropdownItems: data.pairs || [],
          dropdownLabels: data.labels || {},
        }))
      } catch {}
    }, 200)
  }

  function selectPair(pair: string, display: string) {
    setInv((prev) => ({
      ...prev,
      entityValue: pair,
      entityDisplay: display || pair,
      dropdownItems: [],
    }))
  }

  async function loadData() {
    setInv((prev) => ({ ...prev, previewLoading: true, previewError: '', previewData: null }))
    try {
      const data = await dataSourcesApi.getDsPreview(
        inv.sourceId,
        inv.entityValue !== '__no_entity__' ? inv.entityValue : undefined,
        inv.selectedType || undefined
      )
      if (data.error) {
        setInv((prev) => ({ ...prev, previewLoading: false, previewError: data.error ?? 'Unknown error' }))
      } else {
        setInv((prev) => ({ ...prev, previewLoading: false, previewData: data }))
      }
    } catch (e) {
      setInv((prev) => ({
        ...prev,
        previewLoading: false,
        previewError: 'Network error: ' + (e as Error).message,
      }))
    }
  }

  const cfg = entityConfig(inv.sourceId, inv.kind, inv.selectedType)
  const entityOk = !cfg.show || (inv.entityValue && inv.entityValue !== '__no_entity__')
  const canLoad = entityOk && !!inv.selectedType

  return (
    <div className="ds-page">
      {/* Toast */}
      {toast && (
        <div className="ds-toast" style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: '#1a1a2e', color: '#f1f5f9', padding: '10px 20px', borderRadius: 8,
          fontSize: 13, zIndex: 9999, border: '1px solid rgba(255,255,255,.12)'
        }}>
          {toast}
        </div>
      )}

      <div className="ds-header">
        <div>
          <h1 className="ds-title">Data Sources</h1>
          <p className="ds-subtitle">
            Select your execution exchange and supplementary signals. Sources are sorted A–Z.
          </p>
        </div>
        <button className="ds-ask-btn" onClick={() => setAskOpen(true)}>
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Request Data Source
        </button>
      </div>

      {/* Exchanges section */}
      <div className="ds-section">
        <div className="ds-section-header">
          <span className="ds-section-title">Execution Exchanges</span>
          <span className="ds-section-desc">
            OHLCVT price data · bot execution venue · one active at a time
          </span>
        </div>
        <div className="ds-list" id="dsExchangeList">
          {exchanges.map((ex) => {
            const sel = ex.id === selectedExchange
            const color = (ex as any).color || '#888'
            const icon = (ex as any).icon || ex.id.slice(0, 1).toUpperCase()
            return (
              <div
                key={ex.id}
                className={`ds-row${sel ? ' ds-row--selected' : ''}`}
                data-exchange={ex.id}
                onClick={() => selectExchange(ex.id)}
              >
                <div className="ds-row-left">
                  <div
                    className="ds-row-icon"
                    style={{
                      background: `${color}1a`,
                      borderColor: `${color}33`,
                      color,
                    }}
                  >
                    {icon}
                  </div>
                  <div className="ds-row-info">
                    <div className="ds-row-name">
                      {ex.name}
                      {sel && <span className="ds-row-active-tag">▶ Active</span>}
                    </div>
                    <div className="ds-row-meta">
                      {(ex as any).description || ex.name}
                      {(ex as any).pairs_hint ? ` · ${(ex as any).pairs_hint}` : ''}
                    </div>
                  </div>
                </div>
                <div className="ds-row-right">
                  {(ex as any).online !== undefined && (
                    <div className={`ds-row-status ${(ex as any).online ? 'online' : 'offline'}`}>
                      <span className="ds-dot" />
                      {(ex as any).online ? 'Online' : 'Offline'}
                    </div>
                  )}
                  <button
                    className="ds-investigate-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      openInvestigate(ex.id, ex.name, 'exchange')
                    }}
                  >
                    🔍 Investigate
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Supplementary section */}
      <div className="ds-section">
        <div className="ds-section-header">
          <span className="ds-section-title">Supplementary Signals</span>
          <span className="ds-section-desc">
            Toggle to enrich the AI context · each adds context to the strategy
          </span>
        </div>
        <div className="ds-list" id="dsSuppList">
          {sources.map((src) => {
            const isActive = activeSources[src.id] === true
            const needsKey = (src as any).key_required && !(src as any).has_key
            const statusTxt = (src as any).online
              ? 'Connected'
              : needsKey
              ? 'Needs API key'
              : 'Offline'
            const statusCls = (src as any).online
              ? 'online'
              : needsKey
              ? 'needskey'
              : 'offline'
            const color = (src as any).color || '#888'
            const icon = (src as any).icon || '📊'

            return (
              <div key={src.id} className={`ds-row${isActive ? ' ds-row--active' : ''}`}>
                <div className="ds-row-left">
                  <div className="ds-row-icon" style={{ background: `${color}1a`, color, fontSize: 14 }}>
                    {icon}
                  </div>
                  <div className="ds-row-info">
                    <div className="ds-row-name">{src.name}</div>
                    <div className="ds-row-meta">
                      {(src as any).description || (src as any).sub || src.name}
                    </div>
                    {needsKey && (
                      <div className="ds-key-row" style={{ marginTop: 6 }}>
                        <input
                          className="ds-key-input"
                          type="password"
                          placeholder="Enter API key…"
                          id={`dsKey_${src.id}`}
                          autoComplete="off"
                          value={apiKeys[src.id] || ''}
                          onChange={(e) =>
                            setApiKeys((prev) => ({ ...prev, [src.id]: e.target.value }))
                          }
                        />
                        <button
                          className="ds-key-save"
                          onClick={() => saveKey(src.id, (src as any).key_env || src.id)}
                        >
                          Save
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                <div className="ds-row-right">
                  {(src as any).online !== undefined && (
                    <div className={`ds-row-status ${statusCls}`}>
                      <span className="ds-dot" />
                      {statusTxt}
                    </div>
                  )}
                  <button
                    className="ds-investigate-btn"
                    onClick={() => openInvestigate(src.id, src.name, 'supp')}
                  >
                    🔍 Investigate
                  </button>
                  <label className="ds-supp-toggle" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isActive}
                      onChange={(e) => toggleSource(src.id, e.target.checked)}
                    />
                    <span className="ds-toggle-track" />
                  </label>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Investigate Modal ─────────────────────────────────────────────────── */}
      {inv.open && (
        <div
          className="ds-inv-overlay"
          id="dsInvOverlay"
          style={{ display: 'flex' }}
          onClick={(e) => {
            if ((e.target as HTMLElement).id === 'dsInvOverlay') closeInvestigate()
          }}
        >
          <div className="ds-inv-modal" id="dsInvModal">
            <div className="ds-inv-header">
              <div className="ds-inv-header-left">
                <div className="ds-inv-icon" id="dsInvIcon">{inv.icon}</div>
                <div>
                  <div className="ds-inv-title">{inv.sourceName} — Investigate</div>
                  <div className="ds-inv-subtitle">
                    {inv.kind === 'exchange'
                      ? 'Search a trading pair, choose data type, then press Load Data'
                      : 'Search below to explore specific data for this source'}
                  </div>
                </div>
              </div>
              <button className="ds-inv-close" onClick={closeInvestigate}>✕</button>
            </div>

            <div className="ds-inv-builder" id="dsInvBuilder">
              {/* Entity field */}
              {cfg.show && (
                <div className="ds-inv-field" id="dsInvEntityField">
                  <label className="ds-inv-label">{cfg.label}</label>
                  <div className="ds-inv-pair-wrap">
                    <input
                      className="ds-inv-pair-input"
                      id="dsInvPairInput"
                      type="text"
                      placeholder={cfg.placeholder}
                      autoComplete="off"
                      value={inv.entityDisplay}
                      onChange={(e) => onPairInput(e.target.value)}
                      onFocus={() => {
                        if (!inv.entityDisplay && inv.kind === 'supp') onPairInput('')
                      }}
                    />
                    {inv.dropdownItems.length > 0 && (
                      <div className="ds-inv-pair-dropdown" id="dsInvDropdown" style={{ display: 'block' }}>
                        {inv.dropdownItems.map((p) => {
                          const display = inv.dropdownLabels[p] || p
                          return (
                            <div
                              key={p}
                              className="ds-inv-dd-item"
                              onMouseDown={() => selectPair(p, display)}
                            >
                              {display}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Data type pills */}
              <div className="ds-inv-field" id="dsInvTypeField">
                <label className="ds-inv-label">Data Type</label>
                <div className="ds-inv-type-pills" id="dsInvTypePills">
                  {inv.dataTypes.length === 0 && (
                    <span style={{ color: 'var(--t3)', fontSize: 12 }}>Loading…</span>
                  )}
                  {inv.dataTypes.map((t) => (
                    <button
                      key={t}
                      className={`ds-inv-type-pill${inv.selectedType === t ? ' active' : ''}`}
                      onClick={() => onTypeSelect(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <button
                className="ds-inv-go-btn"
                id="dsInvGoBtn"
                disabled={!canLoad || inv.previewLoading}
                onClick={loadData}
              >
                <svg width="14" height="14" fill="none" viewBox="0 0 24 24">
                  <path
                    d="M5 12h14M13 6l6 6-6 6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {inv.previewLoading ? 'Loading…' : 'Load Data'}
              </button>
            </div>

            {/* Results */}
            {(inv.previewData || inv.previewError || inv.previewLoading) && (
              <div className="ds-inv-results" id="dsInvResults" style={{ display: 'block' }}>
                {inv.previewLoading && (
                  <div className="ds-inv-loading">
                    <span className="ds-spinner" /> Fetching data…
                  </div>
                )}
                {inv.previewError && (
                  <div className="ds-inv-error">⚠️ {inv.previewError}</div>
                )}
                {inv.previewData && !inv.previewLoading && !inv.previewError && (
                  <>
                    <div className="ds-inv-results-meta" id="dsInvResultsMeta">
                      <span className="ds-inv-meta-tag">{inv.previewData.source || inv.sourceName}</span>
                      {inv.entityValue && inv.entityValue !== '__no_entity__' && (
                        <span className="ds-inv-meta-tag">
                          {inv.dropdownLabels[inv.entityValue] || inv.entityValue}
                        </span>
                      )}
                      {inv.selectedType && (
                        <span className="ds-inv-meta-tag">{inv.selectedType}</span>
                      )}
                      <span className="ds-inv-meta-count">
                        {inv.previewData.rows.length} rows · {inv.previewData.columns.length} columns
                      </span>
                    </div>
                    <div className="ds-inv-table-wrap" id="dsInvTableWrap">
                      <table className="ds-data-table">
                        <thead>
                          <tr>
                            {inv.previewData.columns.map((c) => (
                              <th key={c}>{c}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {inv.previewData.rows.map((row, i) => (
                            <tr key={i}>
                              {row.map((cell, j) => (
                                <td key={j}>{cell}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Ask modal */}
      {askOpen && (
        <div
          className="ds-ask-overlay"
          style={{ display: 'flex' }}
          onClick={(e) => {
            if ((e.target as HTMLElement).className === 'ds-ask-overlay') setAskOpen(false)
          }}
        >
          <div className="ds-ask-modal">
            <div className="ds-ask-modal-header">
              <span>Request a Data Source</span>
              <button className="ds-ask-close" onClick={() => setAskOpen(false)}>✕</button>
            </div>
            <p className="ds-ask-body">
              Tell us which exchange or data provider you need. We'll add it in a future update.
            </p>
            <textarea
              className="ds-ask-input"
              id="dsAskText"
              rows={4}
              placeholder="e.g. 'I want to trade on Gate.io...'"
              value={askText}
              onChange={(e) => setAskText(e.target.value)}
            />
            <div className="ds-ask-actions">
              <button className="btn-secondary" onClick={() => setAskOpen(false)}>Cancel</button>
              <button
                className="btn-primary"
                onClick={() => {
                  showToast("Request noted — we'll review it soon!")
                  setAskOpen(false)
                  setAskText('')
                }}
              >
                Submit Request
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

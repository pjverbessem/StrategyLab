import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { strategiesApi } from '@/api/strategies'
import { useAppStore } from '@/store'
import type { Strategy } from '@/types'

function formatDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function Library() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const setLoadedStrategy = useAppStore((s) => s.setLoadedStrategy)

  const { data: strategies = [], isLoading, error, refetch } = useQuery({
    queryKey: ['strategies'],
    queryFn: strategiesApi.list,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => strategiesApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['strategies'] })
    },
  })

  const filtered = search.trim()
    ? strategies.filter((s) => {
        const q = search.toLowerCase()
        return (
          s.name.toLowerCase().includes(q) ||
          (s.description || '').toLowerCase().includes(q) ||
          (s.pair || '').toLowerCase().includes(q) ||
          (Array.isArray(s.tags) ? s.tags.join(' ') : '').toLowerCase().includes(q)
        )
      })
    : strategies

  function handleLoad(strat: Strategy) {
    setLoadedStrategy(strat)
    navigate('/')
  }

  async function handleDelete(strat: Strategy) {
    if (!confirm(`Delete "${strat.name}"? This cannot be undone.`)) return
    deleteMutation.mutate(strat.id)
  }

  return (
    <div className="lib-page">
      <div className="lib-topbar">
        <div className="lib-topbar-left">
          <h2 className="lib-title">Strategy Library</h2>
          <span className="lib-count">{strategies.length} saved</span>
        </div>
        <div className="lib-topbar-right">
          <input
            type="text"
            id="librarySearch"
            className="lib-search"
            placeholder="Search by name, pair or tag…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            className="btn-outline"
            id="libraryRefreshBtn"
            onClick={() => refetch()}
            disabled={isLoading}
          >
            {isLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ color: 'var(--neg)', fontSize: 13, padding: '20px 0' }}>
          Failed to load strategies: {(error as Error).message}
        </div>
      )}

      {!isLoading && !error && filtered.length === 0 && (
        <div className="lib-empty" id="libraryEmpty">
          <div className="lib-empty-icon">📭</div>
          <div className="lib-empty-title">
            {search ? 'No strategies match your search' : 'No strategies saved yet'}
          </div>
          <div className="lib-empty-sub">
            {search
              ? 'Try a different search term'
              : 'Generate a strategy in the Creator and save it here.'}
          </div>
          {!search && (
            <button className="btn-primary" onClick={() => navigate('/')}>
              Open Creator →
            </button>
          )}
        </div>
      )}

      <div className="lib-grid" id="libraryGrid">
        {filtered.map((s) => {
          const stats = s.stats ?? {}
          const ret = stats.total_return
          const wr = stats.win_rate
          const dd = stats.max_drawdown
          const trades = stats.total_trades
          const tags: string[] = Array.isArray(s.tags) ? s.tags : []

          return (
            <div className="lib-card" key={s.id} data-id={s.id}>
              <div className="lib-card-header">
                <div className="lib-card-title">{s.name}</div>
                <div className="lib-card-actions">
                  <button
                    className="btn-xs lib-load-btn"
                    title="Load into Creator"
                    onClick={(e) => { e.stopPropagation(); handleLoad(s) }}
                  >
                    Load
                  </button>
                  <button
                    className="btn-xs lib-del-btn"
                    title="Delete strategy"
                    onClick={(e) => { e.stopPropagation(); handleDelete(s) }}
                    disabled={deleteMutation.isPending}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {s.description && (
                <div className="lib-card-desc">{s.description}</div>
              )}

              {tags.length > 0 && (
                <div className="lib-card-tags">
                  {tags.map((t) => (
                    <span key={t} className="lib-tag">{t}</span>
                  ))}
                </div>
              )}

              <div className="lib-card-stats">
                <div className="lib-stat">
                  <div className="lib-stat-label">Return</div>
                  <div className="lib-stat-value">
                    {ret != null ? (
                      <span className={ret >= 0 ? 'lib-pos' : 'lib-neg'}>
                        {ret >= 0 ? '+' : ''}{Number(ret).toFixed(1)}%
                      </span>
                    ) : (
                      <span className="lib-na">—</span>
                    )}
                  </div>
                </div>
                <div className="lib-stat">
                  <div className="lib-stat-label">Win Rate</div>
                  <div className="lib-stat-value">
                    {wr != null ? `${Number(wr).toFixed(1)}%` : '—'}
                  </div>
                </div>
                <div className="lib-stat">
                  <div className="lib-stat-label">Drawdown</div>
                  <div className="lib-stat-value">
                    {dd != null ? `${Number(dd).toFixed(1)}%` : '—'}
                  </div>
                </div>
                <div className="lib-stat">
                  <div className="lib-stat-label">Trades</div>
                  <div className="lib-stat-value">{trades ?? '—'}</div>
                </div>
              </div>

              <div className="lib-card-footer">
                <span className="lib-pair">{s.pair || 'Any'}</span>
                <span className="lib-date">Updated {formatDate(s.updated_at)}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

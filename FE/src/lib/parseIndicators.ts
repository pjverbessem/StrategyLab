import type { Workflow } from './workflowUtils'

export interface IndicatorConfig {
  id: string
  period?: number
  col?: string
  fast?: number
  slow?: number
  signal?: number
  k?: number
  d?: number
  std?: number
}

/**
 * Parse indicators from both AI-generated code and workflow rules.
 * Results are deduplicated — safe to call with either or both.
 */
export function parseIndicators(code: string = '', workflow?: Workflow): IndicatorConfig[] {
  const found = new Map<string, IndicatorConfig>()

  // ── From code (regex) ─────────────────────────────────────────────────────

  if (code) {
    // SMA: .rolling(N).mean()  or  SMA_N
    for (const m of code.matchAll(/\.rolling\(\s*(\d+)\s*\)\.mean\(\)/gi)) {
      const p = parseInt(m[1]); const key = `sma_${p}`
      if (!found.has(key)) found.set(key, { id: 'sma', period: p, col: `SMA_${p}` })
    }
    for (const m of code.matchAll(/['"\[]?SMA_(\d+)['"\]]?/gi)) {
      const p = parseInt(m[1]); const key = `sma_${p}`
      if (!found.has(key)) found.set(key, { id: 'sma', period: p, col: `SMA_${p}` })
    }

    // EMA: .ewm(span=N)  or  EMA_N
    for (const m of code.matchAll(/\.ewm\([^)]*span\s*=\s*(\d+)[^)]*\)/gi)) {
      const p = parseInt(m[1]); const key = `ema_${p}`
      if (!found.has(key)) found.set(key, { id: 'ema', period: p, col: `EMA_${p}` })
    }
    for (const m of code.matchAll(/['"\[]?EMA_(\d+)['"\]]?/gi)) {
      const p = parseInt(m[1]); const key = `ema_${p}`
      if (!found.has(key)) found.set(key, { id: 'ema', period: p, col: `EMA_${p}` })
    }

    // RSI
    const rsiWindows = [...code.matchAll(/RSIIndicator\s*\([^)]*window\s*=\s*(\d+)/gi)]
    if (rsiWindows.length > 0) {
      for (const m of rsiWindows) {
        const p = parseInt(m[1]); const key = `rsi_${p}`
        if (!found.has(key)) found.set(key, { id: 'rsi', period: p, col: `RSI_${p}` })
      }
    } else if (/\brsi\b/i.test(code)) {
      if (!found.has('rsi_14')) found.set('rsi_14', { id: 'rsi', period: 14, col: 'RSI_14' })
    }

    // MACD
    if (/\bmacd\b/i.test(code)) {
      const fast = code.match(/window_fast\s*=\s*(\d+)/i)?.[1]
      const slow = code.match(/window_slow\s*=\s*(\d+)/i)?.[1]
      const sig  = code.match(/window_sign\s*=\s*(\d+)/i)?.[1]
      if (!found.has('macd')) found.set('macd', {
        id: 'macd',
        fast: fast ? parseInt(fast) : 12,
        slow: slow ? parseInt(slow) : 26,
        signal: sig ? parseInt(sig) : 9,
      })
    }

    // Bollinger Bands
    if (/BollingerBands|bollinger|BB_UPPER|BB_LOWER|bbands/i.test(code)) {
      const m = code.match(/BollingerBands\s*\([^)]*window\s*=\s*(\d+)/i)
      if (!found.has('bbands')) found.set('bbands', { id: 'bbands', period: m ? parseInt(m[1]) : 20, std: 2 })
    }

    // ATR
    if (/AverageTrueRange|\batr\b/i.test(code)) {
      const m = code.match(/AverageTrueRange\s*\([^)]*window\s*=\s*(\d+)/i)
      const p = m ? parseInt(m[1]) : 14
      if (!found.has('atr')) found.set('atr', { id: 'atr', period: p, col: `ATR_${p}` })
    }

    // Stochastic
    if (/StochasticOscillator|\bstoch\b/i.test(code)) {
      const m = code.match(/StochasticOscillator\s*\([^)]*window\s*=\s*(\d+)/i)
      if (!found.has('stoch')) found.set('stoch', { id: 'stoch', k: m ? parseInt(m[1]) : 14, d: 3 })
    }

    // VWAP
    if (/\bvwap\b/i.test(code) && !found.has('vwap')) found.set('vwap', { id: 'vwap' })

    // OBV
    if (/\bobv\b/i.test(code) && !found.has('obv')) found.set('obv', { id: 'obv' })

    // Williams %R
    if (/WilliamsRIndicator|williams_r|\bWR_/i.test(code)) {
      const m = code.match(/WilliamsRIndicator\s*\([^)]*lbp\s*=\s*(\d+)/i)
      const p = m ? parseInt(m[1]) : 14
      if (!found.has('wr')) found.set('wr', { id: 'wr', period: p, col: `WR_${p}` })
    }

    // Volume — strip comments first so column listings in comments don't trigger this
    const codeNoComments = code.replace(/#[^\n]*/g, '')
    if (/df\s*\[\s*['"]volume['"]\s*\]/.test(codeNoComments) && !found.has('volume')) {
      found.set('volume', { id: 'volume' })
    }

    // ADR
    if (/\badr\b|average.daily.range|ADR_/i.test(code)) {
      const m = code.match(/ADR_(\d+)/i) || code.match(/adr.*?(\d+)/i)
      const p = m ? parseInt(m[1]) : 14
      if (!found.has('adr')) found.set('adr', { id: 'adr', period: p, col: `ADR_${p}` })
    }
  }

  // ── From workflow (structured) ────────────────────────────────────────────

  if (workflow) {
    for (const rule of workflow.rules) {
      if (!rule.enabled) continue

      for (const cond of rule.entry.conditions) {
        for (const side of [cond.left, cond.right.type === 'indicator' ? cond.right : null]) {
          if (!side || !('indicator' in side)) continue
          const { indicator, params } = side as { indicator: string; params: Record<string, number> }
          const p = params?.period ?? 14
          switch (indicator) {
            case 'sma':    { const k = `sma_${p}`; if (!found.has(k)) found.set(k, { id: 'sma', period: p, col: `SMA_${p}` }); break }
            case 'ema':    { const k = `ema_${p}`; if (!found.has(k)) found.set(k, { id: 'ema', period: p, col: `EMA_${p}` }); break }
            case 'rsi':    { const k = `rsi_${p}`; if (!found.has(k)) found.set(k, { id: 'rsi', period: p, col: `RSI_${p}` }); break }
            case 'macd':   { if (!found.has('macd')) found.set('macd', { id: 'macd', fast: 12, slow: 26, signal: 9 }); break }
            case 'bbands': { if (!found.has('bbands')) found.set('bbands', { id: 'bbands', period: p, std: 2 }); break }
          }
        }
      }

      for (const exit of rule.exit.conditions) {
        if (exit.type === 'rsi_overbought' || exit.type === 'rsi_oversold') {
          const p = exit.params?.period ?? 14
          const k = `rsi_${p}`
          if (!found.has(k)) found.set(k, { id: 'rsi', period: p, col: `RSI_${p}` })
        }
      }
    }
  }

  return Array.from(found.values())
}

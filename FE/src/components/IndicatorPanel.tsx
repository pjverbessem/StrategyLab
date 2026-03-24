import { useEffect, useRef, useState, useCallback } from 'react'
import { createChart, type IChartApi, ColorType, LineStyle } from 'lightweight-charts'

type IndicatorPoint = { time: number; value: number }
type IndicatorMeta  = { type: 'price' | 'oscillator'; range: [number, number] | null; group: string }

interface Props {
  indicatorData: Record<string, IndicatorPoint[]>
  indicatorMeta: Record<string, IndicatorMeta>
  mainChartRef: React.MutableRefObject<IChartApi | null>
  containerH?: number
}

const GROUP_COLORS: Record<string, string[]> = {
  // oscillators
  rsi:   ['#f59e0b'],
  macd:  ['#3b82f6', '#ec4899', '#6b7280'],
  stoch: ['#10b981', '#f59e0b'],
  atr:   ['#6b7280'],
  obv:   ['#6b7280'],
  wr:    ['#a78bfa'],
  bb:    ['#6b7280'],
  // price-type (each gets a distinct colour)
  sma:   ['#f59e0b', '#8b5cf6', '#06b6d4', '#f97316'],
  ema:   ['#3b82f6', '#6366f1', '#0ea5e9'],
  vwap:  ['#ec4899'],
}

const GROUP_LABELS: Record<string, string> = {
  rsi: 'RSI', macd: 'MACD', stoch: 'Stoch', atr: 'ATR', obv: 'OBV', wr: 'Williams %R', bb: 'BB Width',
  sma: 'SMA', ema: 'EMA', vwap: 'VWAP',
}

const REF_LINES: Record<string, { value: number; color: string }[]> = {
  rsi:   [{ value: 70, color: 'rgba(220,38,38,0.35)' }, { value: 30, color: 'rgba(21,163,73,0.35)' }],
  stoch: [{ value: 80, color: 'rgba(220,38,38,0.35)' }, { value: 20, color: 'rgba(21,163,73,0.35)' }],
  wr:    [{ value: -20, color: 'rgba(220,38,38,0.35)' }, { value: -80, color: 'rgba(21,163,73,0.35)' }],
}

function PanelChart({
  group, cols, height, indicatorData, mainChartRef,
}: {
  group: string
  cols: string[]
  height: number
  indicatorData: Record<string, IndicatorPoint[]>
  mainChartRef: React.MutableRefObject<IChartApi | null>
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  // ── Create chart once (data deps only, NOT height) ───────────────────────
  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight || height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#9ca3af',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(0,0,0,0.03)' },
        horzLines: { color: 'rgba(0,0,0,0.04)' },
      },
      crosshair: { mode: 1 },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.05, bottom: 0.05 },
        minimumWidth: 60,
      },
      timeScale: { borderVisible: false, visible: false },
      handleScroll: true,
      handleScale: true,
    })
    chartRef.current = chart

    const colors = GROUP_COLORS[group] ?? ['#6b7280']

    cols.forEach((col, i) => {
      const points = indicatorData[col]
      if (!points?.length) return
      const data = points.map(p => ({ time: p.time as unknown as import('lightweight-charts').Time, value: p.value }))

      if (col === 'MACD_HIST') {
        const hist = chart.addHistogramSeries({ color: '#6b7280', priceLineVisible: false, lastValueVisible: false })
        hist.setData(data.map(d => ({ ...d, color: d.value >= 0 ? 'rgba(21,163,73,0.7)' : 'rgba(220,38,38,0.7)' })))
      } else {
        chart.addLineSeries({
          color: colors[i % colors.length],
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: true,
        }).setData(data)
      }
    })

    // Reference lines
    const refs = REF_LINES[group]
    const firstCol = cols.find(c => indicatorData[c]?.length)
    if (refs && firstCol) {
      refs.forEach(ref => {
        chart.addLineSeries({
          color: ref.color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }).setData(indicatorData[firstCol].map(p => ({
          time: p.time as unknown as import('lightweight-charts').Time,
          value: ref.value,
        })))
      })
    }

    chart.timeScale().fitContent()

    // Sync scroll with main chart
    let isSyncing = false
    const onMainRange = (range: import('lightweight-charts').LogicalRange | null) => {
      if (isSyncing || !range) return; isSyncing = true
      chart.timeScale().setVisibleLogicalRange(range); isSyncing = false
    }
    const onSubRange = (range: import('lightweight-charts').LogicalRange | null) => {
      if (isSyncing || !range) return; isSyncing = true
      mainChartRef.current?.timeScale().setVisibleLogicalRange(range); isSyncing = false
    }
    mainChartRef.current?.timeScale().subscribeVisibleLogicalRangeChange(onMainRange)
    chart.timeScale().subscribeVisibleLogicalRangeChange(onSubRange)

    // Resize observer for width + height
    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return
      const w = containerRef.current.clientWidth
      const h = containerRef.current.clientHeight
      if (w > 0 && h > 0) chart.applyOptions({ width: w, height: h })
    })
    ro.observe(containerRef.current)

    return () => {
      mainChartRef.current?.timeScale().unsubscribeVisibleLogicalRangeChange(onMainRange)
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onSubRange)
      chart.remove()
      chartRef.current = null
      ro.disconnect()
    }
  }, [group, cols, indicatorData, mainChartRef]) // ← height intentionally excluded

  // ── Update height only (no chart recreation) ─────────────────────────────
  useEffect(() => {
    if (chartRef.current && containerRef.current) {
      const w = containerRef.current.clientWidth
      if (w > 0 && height > 0) chartRef.current.applyOptions({ width: w, height })
    }
  }, [height])

  return (
    <div style={{ position: 'relative', height }}>
      <span style={{
        position: 'absolute', top: 4, left: 8, zIndex: 1,
        fontSize: 10, fontWeight: 600, color: '#9ca3af',
        letterSpacing: '0.05em', pointerEvents: 'none', textTransform: 'uppercase',
      }}>
        {GROUP_LABELS[group] ?? group.toUpperCase()}
      </span>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  )
}

export function IndicatorPanel({ indicatorData, indicatorMeta, mainChartRef, containerH }: Props) {
  const groups = new Map<string, string[]>()
  for (const [col, meta] of Object.entries(indicatorMeta)) {
    if (meta.type !== 'oscillator') continue
    if (!indicatorData[col]?.length) continue
    const g = meta.group
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(col)
  }
  if (groups.size === 0) return null

  const groupKeys = [...groups.keys()]
  const defaultGroupH = containerH && groupKeys.length > 0
    ? Math.floor((containerH * 0.3) / groupKeys.length)
    : 100

  const [heights, setHeights] = useState<Record<string, number>>(() =>
    Object.fromEntries(groupKeys.map(k => [k, defaultGroupH]))
  )

  const onDragStart = useCallback((group: string, e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = heights[group]
    const onMove = (mv: MouseEvent) => {
      setHeights(prev => ({ ...prev, [group]: Math.max(50, Math.min(400, startH + mv.clientY - startY)) }))
    }
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [heights])

  return (
    <div style={{ width: '100%', borderTop: '1px solid rgba(0,0,0,0.06)' }}>
      {groupKeys.map((group) => (
        <div key={group}>
          <PanelChart
            group={group}
            cols={groups.get(group)!}
            height={heights[group]}
            indicatorData={indicatorData}
            mainChartRef={mainChartRef}
          />
          <div className="panel-drag-handle" onMouseDown={(e) => onDragStart(group, e)} />
        </div>
      ))}
    </div>
  )
}

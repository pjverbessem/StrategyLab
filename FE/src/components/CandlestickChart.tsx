import { useEffect, useRef } from 'react'
import { createChart, type IChartApi, ColorType } from 'lightweight-charts'
import type { Candle, Trade } from '@/types'

const PRICE_COLORS: Record<string, string[]> = {
  sma:  ['#f59e0b', '#8b5cf6', '#06b6d4', '#f97316'],
  ema:  ['#3b82f6', '#6366f1', '#0ea5e9'],
  bb:   ['#94a3b8', '#94a3b8', '#94a3b8'],
  vwap: ['#ec4899'],
  wr:   ['#a78bfa'],
}

type IndicatorPoint = { time: number; value: number }
type IndicatorMeta  = { type: 'price' | 'oscillator'; range: [number, number] | null; group: string }

interface Props {
  candles: Candle[]
  trades?: Trade[]
  indicatorData?: Record<string, IndicatorPoint[]>
  indicatorMeta?: Record<string, IndicatorMeta>
  chartRef?: React.MutableRefObject<IChartApi | null>
}

export function CandlestickChart({
  candles,
  trades = [],
  indicatorData: _indicatorData = {},
  indicatorMeta:  _indicatorMeta  = {},
  chartRef,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const internalChartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const initH = containerRef.current.clientHeight || 280

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: initH,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#6b7280',
      },
      grid: {
        vertLines: { color: 'rgba(0,0,0,0.03)' },
        horzLines: { color: 'rgba(0,0,0,0.03)' },
      },
      crosshair: { mode: 1 },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.05, bottom: 0.05 },
        minimumWidth: 60,
      },
      timeScale: { borderVisible: false, timeVisible: true },
    })

    internalChartRef.current = chart
    if (chartRef) chartRef.current = chart

    // ── Candlestick series ────────────────────────────────────────────────
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#15a349',
      downColor: '#dc2626',
      borderVisible: false,
      wickUpColor: '#15a349',
      wickDownColor: '#dc2626',
    })

    const sorted = [...candles].sort((a, b) => a.time - b.time)
    candleSeries.setData(sorted.map((c) => ({
      time: c.time as unknown as import('lightweight-charts').Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    })))

    // Trade markers
    if (trades.length > 0) {
      const markers = trades.flatMap((t) => [
        {
          time: t.entry as unknown as import('lightweight-charts').Time,
          position: t.side === 'long' ? 'belowBar' as const : 'aboveBar' as const,
          color: t.side === 'long' ? '#15a349' : '#dc2626',
          shape: t.side === 'long' ? 'arrowUp' as const : 'arrowDown' as const,
          text: t.side === 'long' ? 'Long ▲' : 'Short ▼',
          size: 1,
        },
        {
          time: t.exit as unknown as import('lightweight-charts').Time,
          position: t.side === 'long' ? 'aboveBar' as const : 'belowBar' as const,
          color: (t.return_pct ?? 0) >= 0 ? '#15a349' : '#dc2626',
          shape: t.side === 'long' ? 'arrowDown' as const : 'arrowUp' as const,
          text: `${(t.return_pct ?? 0) >= 0 ? '+' : ''}${Number(t.return_pct ?? 0).toFixed(1)}%`,
          size: 1,
        },
      ])
      markers.sort((a, b) => Number(a.time) - Number(b.time))
      candleSeries.setMarkers(markers)
    }

    // ── Price-type indicator overlays ─────────────────────────────────────
    const groupCounters: Record<string, number> = {}
    for (const [col, meta] of Object.entries(_indicatorMeta)) {
      if (meta.type !== 'price') continue
      const points = _indicatorData[col]
      if (!points?.length) continue
      const data = points.map(p => ({ time: p.time as unknown as import('lightweight-charts').Time, value: p.value }))

      if (col === 'volume') {
        const volSeries = chart.addHistogramSeries({
          color: 'rgba(107,114,128,0.35)',
          priceFormat: { type: 'volume' },
          priceScaleId: 'volume',
          priceLineVisible: false,
          lastValueVisible: false,
        })
        chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
        volSeries.setData(data)
      } else {
        const group = meta.group
        const idx = groupCounters[group] ?? 0
        groupCounters[group] = idx + 1
        const colors = PRICE_COLORS[group] ?? ['#6b7280']
        chart.addLineSeries({
          color: colors[idx % colors.length],
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: true,
        }).setData(data)
      }
    }

    chart.timeScale().fitContent()

    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return
      const w = containerRef.current.clientWidth
      const h = containerRef.current.clientHeight
      if (w > 0 && h > 0) chart.applyOptions({ width: w, height: h })
    })
    ro.observe(containerRef.current)

    return () => {
      chart.remove()
      ro.disconnect()
      internalChartRef.current = null
      if (chartRef) chartRef.current = null
    }
  }, [candles, trades, _indicatorData, _indicatorMeta])

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}

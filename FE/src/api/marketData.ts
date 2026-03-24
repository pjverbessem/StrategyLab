import { apiGet } from './client'
import type { Pair, Candle, UnlockEvent, UpcomingCliff, FearGreedEntry, LivePrice } from '@/types'

export const marketDataApi = {
  getPairs: () => apiGet<Pair[]>('/pairs'),

  getOhlcvt: (pair: string, interval: number, start?: string, end?: string) =>
    apiGet<Candle[]>('/ohlcvt', { pair, interval, start, end }),

  getUnlocks: (pair: string) => apiGet<UnlockEvent[]>('/unlocks', { pair }),

  getUnlockEvents: (pair: string) => apiGet<UnlockEvent[]>('/unlock-events', { pair }),

  getUpcomingCliffs: (days = 120) => apiGet<UpcomingCliff[]>('/upcoming-cliffs', { days }),

  getDbSummary: () => apiGet<unknown>('/db-summary'),

  getFearGreedLatest: () => apiGet<FearGreedEntry>('/fear-greed/latest'),

  getFearGreedHistory: (start?: string, end?: string, limit = 365) =>
    apiGet<FearGreedEntry[]>('/fear-greed', { start, end, limit }),

  getLivePrice: (pair: string) => apiGet<LivePrice>(`/live-price/${pair}`),

  getLivePrices: (pairs: string) => apiGet<Record<string, LivePrice>>('/live-prices', { pairs }),
}

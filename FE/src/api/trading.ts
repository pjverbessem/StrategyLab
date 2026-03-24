import { apiGet, apiPost } from './client'
import type { BotStatus, KrakenStatus } from '@/types'

export const tradingApi = {
  botStart: (req: { strategy_id?: string; code?: string; pair: string; interval: number; allocation: number }) =>
    apiPost<{ started: boolean; pair: string; allocation: number }>('/bot/start', req),

  botStop: () => apiPost<{ stopped: boolean }>('/bot/stop', {}),

  botStatus: () => apiGet<BotStatus>('/bot/status'),

  botLogs: (limit = 100) => apiGet<unknown[]>('/bot/logs', { limit }),

  krakenStatus: () => apiGet<KrakenStatus>('/kraken/status'),

  krakenSetKeys: (body: { api_key: string; api_secret: string }) =>
    apiPost<{ ok: boolean; key_prefix?: string; error?: string }>('/kraken/set-keys', body),

  krakenBalance: () => apiGet<{ balances: Record<string, number>; raw: Record<string, string> }>('/kraken/balance'),
}

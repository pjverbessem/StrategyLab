import { apiGet, apiPost } from './client'
import type { Exchange, DataSource, DataPreview } from '@/types'

export const dataSourcesApi = {
  getExchanges: () => apiGet<{ exchanges: Exchange[] }>('/exchanges').then((d) => d.exchanges || (d as unknown as Exchange[])),
  getDataSources: () => apiGet<{ sources: DataSource[] }>('/data-sources').then((d) => d.sources || (d as unknown as DataSource[])),
  getExchangePairs: (exchangeId: string) => apiGet<{ pairs: string[] }>(`/data-sources/pairs/${exchangeId}`),
  getDsPairs: (sourceId: string, q = '', data_type?: string) =>
    apiGet<{ pairs: string[]; labels?: Record<string, string> }>(`/data-sources/pairs/${sourceId}`, { q, ...(data_type ? { data_type } : {}) }),
  getDsDataTypes: (sourceId: string) => apiGet<{ data_types: string[] }>(`/data-sources/data-types/${sourceId}`),
  getDsPreview: (sourceId: string, pair?: string, data_type?: string) =>
    apiGet<DataPreview>(`/data-sources/preview/${sourceId}`, {
      ...(pair ? { pair } : {}),
      ...(data_type ? { data_type } : {}),
    }),
  saveApiKey: (key_name: string, key_value: string) => apiPost<{ ok: boolean; message?: string; error?: string }>('/save-api-key', { key_name, key_value }),
  getCoins: (params?: { min_rank?: number; max_rank?: number; limit?: number }) => apiGet<unknown[]>('/coins', params),
}

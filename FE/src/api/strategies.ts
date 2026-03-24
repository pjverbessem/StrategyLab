import { apiGet, apiPost, apiPut, apiDelete } from './client'
import type { Strategy, SaveStrategyRequest } from '@/types'

export const strategiesApi = {
  list: () => apiGet<Strategy[]>('/strategies'),
  get: (id: string) => apiGet<Strategy>(`/strategies/${id}`),
  save: (req: SaveStrategyRequest) => apiPost<{ id: string; created_at: number }>('/strategies', req),
  update: (id: string, req: SaveStrategyRequest) => apiPut<{ updated: boolean }>(`/strategies/${id}`, req),
  delete: (id: string) => apiDelete<{ deleted: boolean }>(`/strategies/${id}`),
}

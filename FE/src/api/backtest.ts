import { apiPost } from './client'
import type { BacktestRequest, BacktestResult } from '@/types'

export interface MultiBacktestRequest {
  pairs: string[]
  interval: number
  start?: string
  end?: string
  script: string
  max_workers?: number
}

export const backtestApi = {
  run: (req: BacktestRequest) => apiPost<BacktestResult>('/backtest', req),
  runMulti: (req: MultiBacktestRequest) => apiPost<unknown>('/backtest-multi', req),
}

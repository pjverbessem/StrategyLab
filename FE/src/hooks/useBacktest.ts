import { useMutation } from '@tanstack/react-query'
import { backtestApi } from '@/api/backtest'
import { useAppStore } from '@/store'
import type { BacktestRequest } from '@/types'

export function useBacktest() {
  const setBacktestResult = useAppStore((s) => s.setBacktestResult)

  return useMutation({
    mutationFn: (req: BacktestRequest) => backtestApi.run(req),
    onSuccess: (data) => {
      if (!data.error) setBacktestResult(data)
    },
  })
}

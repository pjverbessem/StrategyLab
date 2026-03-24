import { useQuery } from '@tanstack/react-query'
import { tradingApi } from '@/api/trading'

export function useBotStatus(enabled = true) {
  return useQuery({
    queryKey: ['bot-status'],
    queryFn: tradingApi.botStatus,
    refetchInterval: 5000,
    enabled,
  })
}

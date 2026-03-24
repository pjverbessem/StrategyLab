import { useQuery } from '@tanstack/react-query'
import { marketDataApi } from '@/api/marketData'

export function usePairs() {
  return useQuery({
    queryKey: ['pairs'],
    queryFn: marketDataApi.getPairs,
    staleTime: 5 * 60_000,
  })
}

import { useQuery } from '@tanstack/react-query'
import type { QueryKey } from '@tanstack/react-query'

export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs = 3000,
  queryKey?: QueryKey
): {
  data: T | null
  loading: boolean
  error: Error | null
  refresh: () => Promise<void>
} {
  const query = useQuery({
    queryKey: queryKey ?? ['polling', intervalMs],
    queryFn: fetcher,
    refetchInterval: intervalMs > 0 ? intervalMs : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1
  })

  return {
    data: query.data ?? null,
    loading: query.isPending,
    error: query.error,
    refresh: async () => {
      await query.refetch()
    }
  }
}

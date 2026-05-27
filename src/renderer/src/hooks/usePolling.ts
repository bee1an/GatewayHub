import { useEffect, useRef, useState, useCallback } from 'react'

export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs = 3000
): {
  data: T | null
  loading: boolean
  error: Error | null
  refresh: () => void
} {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const fetcherRef = useRef(fetcher)

  useEffect(() => {
    fetcherRef.current = fetcher
  }, [fetcher])

  const refresh = useCallback(() => {
    fetcherRef
      .current()
      .then((result) => {
        setData(result)
        setError(null)
      })
      .catch((err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err))
        console.error('[usePolling] fetch failed:', e)
        setError(e)
      })
      .finally(() => {
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, refresh])

  return { data, loading, error, refresh }
}

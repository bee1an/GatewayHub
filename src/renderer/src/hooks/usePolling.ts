import { useEffect, useRef, useState, useCallback } from 'react'

export function usePolling<T>(fetcher: () => Promise<T>, intervalMs = 3000): {
  data: T | null
  loading: boolean
  refresh: () => void
} {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const refresh = useCallback(() => {
    fetcherRef.current().then((result) => {
      setData(result)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, refresh])

  return { data, loading, refresh }
}

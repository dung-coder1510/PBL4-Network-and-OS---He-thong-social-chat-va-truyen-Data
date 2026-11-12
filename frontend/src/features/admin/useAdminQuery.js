import { useEffect, useState } from 'react'
import { request } from '../../services/apiClient.js'

// One request at a time. A hidden section retains its data and cancels its work.
export function useAdminQuery(path, { token, active = true, revision = 0, interval = 0, onFailure }) {
  const [result, setResult] = useState({ data: null, loading: true, error: '', status: null, receivedAt: null })
  useEffect(() => {
    if (!active || !path) return undefined
    const controller = new AbortController()
    let timer
    let failures = 0
    let stopped = false
    async function load() {
      if (controller.signal.aborted) return
      if (interval && document.visibilityState === 'hidden') {
        timer = setTimeout(load, interval)
        return
      }
      setResult(previous => ({ ...previous, loading: true }))
      let delay = interval
      try {
        const data = await request(path, { token, signal: controller.signal })
        if (controller.signal.aborted) return
        failures = 0
        setResult({ data, loading: false, error: '', status: null, receivedAt: performance.now() })
      } catch (failure) {
        if (controller.signal.aborted) return
        setResult(previous => ({ ...previous, loading: false, error: failure.message, status: failure.status }))
        onFailure?.(failure)
        stopped = failure.status === 401 || failure.status === 403
        delay = failure.status === 429 && failure.retryAfterMs
          ? Math.max(interval, failure.retryAfterMs) : Math.min(30000, interval * 2 ** ++failures)
      }
      if (interval && !stopped && !controller.signal.aborted) timer = setTimeout(load, delay)
    }
    queueMicrotask(load)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [path, token, active, revision, interval, onFailure])
  return result
}

export function useElapsed(receivedAt, active) {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setNow(performance.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return receivedAt == null ? null : Math.max(0, (now - receivedAt) / 1000)
}

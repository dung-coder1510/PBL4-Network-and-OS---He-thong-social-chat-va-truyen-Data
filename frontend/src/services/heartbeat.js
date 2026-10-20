export function createHeartbeatLoop(sendHeartbeat, onError = () => {}) {
  let active = false
  let inFlight = false
  let immediate = false
  let generation = 0
  let timer
  let intervalMs = 15000

  async function beat() {
    if (!active) return
    if (inFlight) {
      immediate = true
      return
    }
    const currentGeneration = generation
    inFlight = true
    try {
      const acknowledgement = await sendHeartbeat()
      if (currentGeneration === generation && acknowledgement?.intervalSeconds > 0)
        intervalMs = acknowledgement.intervalSeconds * 1000
    } catch (failure) {
      if (active && currentGeneration === generation) onError(failure)
    } finally {
      inFlight = false
      if (active) {
        if (immediate) {
          immediate = false
          void beat()
        } else timer = setTimeout(beat, intervalMs)
      }
    }
  }

  function stop() {
    active = false
    immediate = false
    generation++
    clearTimeout(timer)
  }

  return {
    start() {
      stop()
      active = true
      void beat()
    },
    stop,
  }
}

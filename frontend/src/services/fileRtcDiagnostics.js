import { classifyTextRoute } from './textProtocol.js'

// Chỉ giữ số đo tổng hợp. Không đưa IP, candidate, SDP hoặc TURN credential vào UI.
export function readFileRtcStats(report, sending, previous) {
  const entries = [...report.values()]
  const transport = entries.find(item => item.type === 'transport' && item.selectedCandidatePairId)
  const pair = transport ? report.get(transport.selectedCandidatePairId)
    : entries.find(item => item.type === 'candidate-pair' && item.selected && item.state === 'succeeded')
  const local = pair && report.get(pair.localCandidateId)
  const timestamp = pair?.timestamp
  const bytes = sending ? pair?.bytesSent : pair?.bytesReceived
  const sample = pair && Number.isFinite(bytes) && Number.isFinite(timestamp)
    ? { id: pair.id, bytes, timestamp } : null
  const seconds = sample && previous?.id === sample.id ? (sample.timestamp - previous.timestamp) / 1000 : 0
  const bytesPerSecond = seconds > 0 && sample.bytes >= previous.bytes ? (sample.bytes - previous.bytes) / seconds : null
  return {
    sample,
    stats: {
      route: classifyTextRoute(report),
      protocol: ['udp', 'tcp'].includes(local?.protocol) ? local.protocol : null,
      relayProtocol: local?.candidateType === 'relay' && ['udp', 'tcp', 'tls'].includes(local.relayProtocol)
        ? local.relayProtocol : null,
      roundTripMs: Number.isFinite(pair?.currentRoundTripTime) && pair.currentRoundTripTime >= 0
        ? pair.currentRoundTripTime * 1000 : null,
      bytesPerSecond,
    },
  }
}

// Mỗi phiên có một vòng đo tuần tự, tối đa một lượt getStats đang chờ trên mỗi
// PeerConnection. Dừng vòng đo trước khi đóng peer hoặc chuyển sang HTTPS.
export function monitorFileRtc({ connections, sending, signal, onUpdate }) {
  let timer
  let stopped = false
  const previous = new Array(connections.length)
  const stop = () => {
    stopped = true
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
  async function sample() {
    if (stopped || signal.aborted) return
    const results = await Promise.all(connections.map(async ({ pc }, index) => {
      try {
        const result = readFileRtcStats(await pc.getStats(), sending, previous[index])
        previous[index] = result.sample
        return result.stats
      } catch {
        previous[index] = null
        return { route: 'webrtc', protocol: null, relayProtocol: null, roundTripMs: null, bytesPerSecond: null }
      }
    }))
    if (stopped || signal.aborted) return
    onUpdate(results)
    timer = setTimeout(sample, 1000)
  }
  signal.addEventListener('abort', stop, { once: true })
  void sample()
  return stop
}

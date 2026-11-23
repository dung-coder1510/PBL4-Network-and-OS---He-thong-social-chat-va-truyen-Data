import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileRtcStats, monitorFileRtc } from '../frontend/src/services/fileRtcDiagnostics.js'

function report({ id = 'pair', timestamp = 1000, sent = 100, received = 200, type = 'host', protocol = 'udp' } = {}) {
  return new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: id }],
    [id, { id, type: 'candidate-pair', state: 'succeeded', timestamp, bytesSent: sent, bytesReceived: received,
      currentRoundTripTime: 0.123, localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['local', { candidateType: type, protocol, relayProtocol: 'tls', address: '192.0.2.1', port: 12345, url: 'turn:private.example' }],
    ['remote', { candidateType: 'host', address: '198.51.100.1' }],
  ])
}

test('selected ICE pair gives direct/TURN, RTT and directional rates without disclosing IPs', () => {
  const first = readFileRtcStats(report(), true)
  assert.equal(first.stats.route, 'direct')
  assert.equal(first.stats.roundTripMs, 123)
  assert.equal(first.stats.bytesPerSecond, null)
  const second = readFileRtcStats(report({ timestamp: 2000, sent: 1_000_100, type: 'relay' }), true, first.sample)
  assert.equal(second.stats.route, 'turn')
  assert.equal(second.stats.relayProtocol, 'tls')
  assert.equal(second.stats.bytesPerSecond, 1_000_000)
  assert.doesNotMatch(JSON.stringify(second), /192\.0|198\.51|12345|private\.example/)
  const received = readFileRtcStats(report({ timestamp: 2000, received: 2_000_200 }), false, { ...first.sample, bytes: 200 })
  assert.equal(received.stats.bytesPerSecond, 2_000_000)
})

test('missing stats, reselected candidates and reset counters are unknown instead of fabricated rates', () => {
  const empty = readFileRtcStats(new Map(), true)
  assert.equal(empty.stats.route, 'webrtc')
  assert.equal(empty.stats.roundTripMs, null)
  const first = readFileRtcStats(report(), true)
  assert.equal(readFileRtcStats(report({ id: 'new', timestamp: 2000 }), true, first.sample).stats.bytesPerSecond, null)
  assert.equal(readFileRtcStats(report({ sent: 0, timestamp: 2000 }), true, first.sample).stats.bytesPerSecond, null)
})

test('aborting a sample in flight suppresses late updates and cleans the polling loop', async () => {
  const abort = new AbortController()
  let resolve
  let updates = 0
  const stopped = monitorFileRtc({ connections: [{ pc: { getStats: () => new Promise(done => { resolve = done }) } }],
    sending: true, signal: abort.signal, onUpdate() { updates++ },
  })
  abort.abort()
  resolve(report())
  await new Promise(done => setImmediate(done))
  stopped()
  assert.equal(updates, 0)
})

test('unsupported getStats is non-fatal and the monitor can be stopped', async () => {
  const abort = new AbortController()
  let received
  const stop = monitorFileRtc({ connections: [{ pc: { async getStats() { throw new Error('Unavailable') } } }],
    sending: false, signal: abort.signal, onUpdate(stats) { received = stats },
  })
  await new Promise(done => setImmediate(done))
  stop()
  assert.equal(received[0].route, 'webrtc')
})

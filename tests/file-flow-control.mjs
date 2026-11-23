import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, createHash } from 'node:crypto'
import { setImmediate as tick } from 'node:timers/promises'
import { createFileFlowControl, INITIAL_FILE_WINDOW, MAX_FILE_WINDOW } from '../frontend/src/services/fileFlowControl.js'
import { createStreamSender, createStreamReceiver, streamControl, readStreamControl, encodeStreamChunk } from '../frontend/src/services/fileStreamProtocol.js'
import { CHUNK_BYTES, MULTICHANNEL_PROTOCOL } from '../frontend/src/services/fileProtocol.js'

test('old peers keep their original window, including old READY without capabilities', () => {
  let now = 0
  const flow = createFileFlowControl({ clock: () => now, roundTripMs: () => 100 })
  flow.negotiate(undefined)
  for (let index = 1; index <= 20; index++) {
    now += 500
    flow.waited('ack', 100)
    flow.acknowledge(index * 20_000_000, 1)
  }
  assert.equal(flow.windowBytes, INITIAL_FILE_WINDOW)
  assert.equal(flow.snapshot().adaptive, false)
})

test('negotiated window grows with ACK throughput and RTT, and stays within 8 MB', () => {
  let now = 0
  const flow = createFileFlowControl({ clock: () => now, roundTripMs: () => 150 })
  flow.negotiate(MAX_FILE_WINDOW)
  for (let index = 1; index <= 20; index++) {
    now += 500
    flow.acknowledge(index * 20_000_000, 1)
    assert.ok(flow.windowBytes <= MAX_FILE_WINDOW)
  }
  assert.ok(flow.windowBytes > INITIAL_FILE_WINDOW)
  assert.equal(flow.snapshot().maximumWindowBytes, 8_000_000)
})

test('slow destination and long ACK gaps reduce the window without dropping below its working baseline', () => {
  let now = 0
  const flow = createFileFlowControl({ clock: () => now, roundTripMs: () => 100 })
  flow.negotiate(MAX_FILE_WINDOW)
  now = 500
  flow.acknowledge(20_000_000, 1)
  const grown = flow.windowBytes
  for (let index = 2; index <= 30; index++) {
    now += 1600
    flow.acknowledge(index * 20_000_000, 250)
  }
  assert.ok(flow.windowBytes < grown)
  assert.equal(flow.windowBytes, INITIAL_FILE_WINDOW)
})

test('low ICE RTT and slow startup cannot reduce the window below the original 2.10 MB budget', () => {
  let now = 0
  const flow = createFileFlowControl({ clock: () => now, roundTripMs: () => 1 })
  flow.negotiate(MAX_FILE_WINDOW)
  for (let index = 1; index <= 20; index++) {
    now += 500
    flow.acknowledge(index * 100_000, 1)
    assert.ok(flow.windowBytes >= INITIAL_FILE_WINDOW)
  }
})

test('lower ACK throughput gradually releases an oversized window even without a disk stall', () => {
  let now = 0
  const flow = createFileFlowControl({ clock: () => now, roundTripMs: () => 100 })
  flow.negotiate(MAX_FILE_WINDOW)
  for (let index = 1; index <= 8; index++) {
    now += 500
    flow.acknowledge(index * 20_000_000, 1)
  }
  const grown = flow.windowBytes
  for (let index = 1; index <= 8; index++) {
    now += 500
    flow.acknowledge(160_000_000 + index * 32_768, 1)
  }
  assert.ok(flow.windowBytes < grown)
})

test('malformed advertised bounds and write timings are rejected, duplicate ACKs cannot inflate the window', () => {
  let now = 0
  const flow = createFileFlowControl({ clock: () => now })
  for (const maximum of [0, -1, 2.5, NaN, Infinity, '8000000', MAX_FILE_WINDOW + 1])
    assert.throws(() => flow.negotiate(maximum), /không hợp lệ/)
  flow.negotiate(MAX_FILE_WINDOW)
  for (const duration of [-1, NaN, Infinity, '1', 60_001])
    assert.throws(() => flow.acknowledge(1, duration), /không hợp lệ/)
  now = 500
  flow.acknowledge(CHUNK_BYTES, 1)
  const window = flow.windowBytes
  now += 500
  flow.acknowledge(CHUNK_BYTES, 1)
  assert.equal(flow.windowBytes, window)
})

test('real sender/receiver exchange grows only after negotiated READY, validates bytes and respects slow-writer bounds', async () => {
  const bytes = randomBytes(28_000_007)
  const output = Buffer.alloc(bytes.length)
  const abort = new AbortController()
  const errors = []
  let now = 0
  let written = 0
  let sent = 0
  let peak = 0
  let end
  let grew = false
  let sender
  const receiver = createStreamReceiver({ size: bytes.length, protocolVersion: MULTICHANNEL_PROTOCOL,
    maxWindowBytes: MAX_FILE_WINDOW, signal: abort.signal, onProgress() {},
    async write(offset, data) {
      await tick()
      assert.equal(offset, written)
      output.set(data, offset)
      written += data.byteLength
      now += 10
    },
    acknowledge(count, details) {
      assert.equal(count, written)
      sender.handle(streamControl('ACK', '1', count, 0, details))
      grew ||= sender.diagnostics().windowBytes > INITIAL_FILE_WINDOW
    },
  })
  const channel = { readyState: 'open', bufferedAmount: 0, send(frame) {
    if (typeof frame === 'string') {
      receiver.end(0)
      end = receiver.finish()
      return
    }
    sent += frame.byteLength - 8
    peak = Math.max(peak, sent - written)
    assert.ok(sent - written <= MAX_FILE_WINDOW)
    receiver.push(frame).catch(error => errors.push(error))
  } }
  sender = createStreamSender({ channels: [channel], transferId: '1', protocolVersion: MULTICHANNEL_PROTOCOL,
    signal: abort.signal, clock: () => now, roundTripMs: () => 100,
    onProgress(count) { assert.ok(count <= written) },
  })
  sender.handle(streamControl('READY', '1', undefined, 0, receiver.capabilities))
  await sender.send(new Blob([bytes]), async () => {})
  assert.equal(await end, bytes.length)
  assert.equal(sender.diagnostics().inFlightBytes, 0)
  assert.ok(grew)
  assert.ok(peak > INITIAL_FILE_WINDOW)
  assert.equal(createHash('sha256').update(output).digest('hex'), createHash('sha256').update(bytes).digest('hex'))
  assert.deepEqual(errors, [])
})

test('receiver rejects payload beyond its advertised cap before a slow disk writes or ACKs', async () => {
  const abort = new AbortController()
  const errors = []
  const receiver = createStreamReceiver({ size: MAX_FILE_WINDOW + CHUNK_BYTES, maxWindowBytes: MAX_FILE_WINDOW,
    protocolVersion: MULTICHANNEL_PROTOCOL, signal: abort.signal, onProgress() {},
    write: () => new Promise(() => {}), acknowledge() { throw new Error('No write completed') },
  })
  const chunk = new Uint8Array(CHUNK_BYTES)
  let offset = 0
  for (; offset + CHUNK_BYTES <= MAX_FILE_WINDOW; offset += CHUNK_BYTES)
    receiver.push(encodeStreamChunk(offset, chunk, MULTICHANNEL_PROTOCOL)).catch(error => errors.push(error))
  assert.ok(receiver.diagnostics().queuedBytes <= MAX_FILE_WINDOW)
  assert.throws(() => receiver.push(encodeStreamChunk(offset, chunk, MULTICHANNEL_PROTOCOL)), /cửa sổ ACK/)
  assert.equal(readStreamControl(streamControl('READY', '1', undefined, 0, receiver.capabilities), '1').maxWindowBytes, 8_000_000)
  assert.deepEqual(errors, [])
})

test('aborting while waiting for written ACK releases the sender', async () => {
  const abort = new AbortController()
  let sent = 0
  let now = 0
  const sender = createStreamSender({ transferId: '1', protocolVersion: MULTICHANNEL_PROTOCOL,
    signal: abort.signal, clock: () => now, onProgress() {}, channels: [{ readyState: 'open', bufferedAmount: 0,
      send(frame) { if (frame instanceof ArrayBuffer) sent += frame.byteLength - 8 },
    }],
  })
  sender.handle(streamControl('READY', '1', undefined, 0, { maxWindowBytes: MAX_FILE_WINDOW }))
  const sending = sender.send(new Blob([new Uint8Array(4_000_000)]), async () => {})
  for (let index = 0; index < 100 && sent < INITIAL_FILE_WINDOW; index++) await tick()
  assert.equal(sent, INITIAL_FILE_WINDOW)
  now = 1000
  assert.equal(sender.diagnostics().ackWaitMs, 1000)
  abort.abort()
  await assert.rejects(sending, { name: 'AbortError' })
})

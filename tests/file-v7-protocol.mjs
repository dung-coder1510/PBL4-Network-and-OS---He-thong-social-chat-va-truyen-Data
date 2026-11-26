import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import {
  HIGH_SPEED_PROTOCOL, V7_INITIAL_FILE_WINDOW, V7_MAX_FILE_WINDOW, V7_MAX_OUT_OF_ORDER_BLOCKS,
  V7_SEND_BUFFER_PER_CONNECTION, filterIceServers, v7BlockBytes,
} from '../frontend/src/services/fileProtocol.js'
import { createFileFlowControl } from '../frontend/src/services/fileFlowControl.js'
import { createStreamReceiver, createStreamSender, streamControl } from '../frontend/src/services/fileStreamProtocol.js'
import { createPartFileStorage } from '../frontend/src/services/fileStorage.js'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function createMemoryTarget(name) {
  let bytes = Buffer.alloc(0)
  let closed = false
  return {
    name,
    get bytes() { return bytes },
    get closed() { return closed },
    async createWritable() {
      const staged = new Map()
      return {
        async write({ position, data }) {
          staged.set(position, Buffer.from(data))
        },
        async close() {
          const total = [...staged.entries()].reduce((max, [pos, buf]) => Math.max(max, pos + buf.length), 0)
          const out = Buffer.alloc(total)
          for (const [pos, buf] of staged) buf.copy(out, pos)
          bytes = out
          closed = true
        },
        async abort() {
          staged.clear()
        },
      }
    },
  }
}

function installTransferMockWorker(t) {
  const hadWorker = Object.hasOwn(globalThis, 'Worker')
  const originalWorker = globalThis.Worker
  globalThis.Worker = class TransferMockWorker {
    #hash = null
    #pending = new Map()
    #nextIndex = 0
    #totalParts = 0

    postMessage(message, transfer = []) {
      if (message?.digestOnly) {
        Promise.resolve(message.file.arrayBuffer()).then(buf => {
          queueMicrotask(() => this.onmessage?.({ data: { sha256Hex: digest(Buffer.from(buf)) } }))
        })
        return
      }
      const cloned = structuredClone(message, { transfer })
      if (cloned.type === 'init') {
        this.#hash = createHash('sha256')
        this.#pending.clear()
        this.#nextIndex = 0
        this.#totalParts = cloned.totalParts
      } else if (cloned.type === 'part') {
        this.#pending.set(cloned.partIndex, Buffer.from(cloned.buffer))
        while (this.#pending.has(this.#nextIndex)) {
          this.#hash.update(this.#pending.get(this.#nextIndex))
          this.#pending.delete(this.#nextIndex)
          this.#nextIndex++
        }
      } else if (cloned.type === 'digest') {
        assert.equal(this.#nextIndex, this.#totalParts)
        const sha256Hex = this.#hash.digest('hex')
        queueMicrotask(() => this.onmessage?.({ data: { type: 'digest', sha256Hex } }))
      }
    }

    terminate() {}
  }
  t.after(() => {
    if (hadWorker) globalThis.Worker = originalWorker
    else delete globalThis.Worker
  })
}

function createMockChannel(index, onSend) {
  const listeners = new Map()
  return {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    sentFrames: 0,
    sentBytes: 0,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    send(data) {
      this.sentFrames++
      this.sentBytes += typeof data === 'string' ? data.length : data.byteLength
      onSend(index, data)
    },
  }
}

test('filterIceServers strips TURN when allowTurn=false and preserves all servers when allowTurn=true', () => {
  const iceServers = [
    { urls: 'stun:stun.example.test:3478' },
    { urls: ['stun:stun2.example.test:3478', 'turn:turn.example.test:3478?transport=udp', 'turns:turn.example.test:5349'], username: 'u', credential: 'p' },
    { urls: 'turn:only-turn.example.test:3478', username: 'u', credential: 'p' },
  ]
  assert.deepEqual(filterIceServers(iceServers, false), [
    { urls: 'stun:stun.example.test:3478' },
    { urls: ['stun:stun2.example.test:3478'], username: 'u', credential: 'p' },
  ])
  assert.deepEqual(filterIceServers(iceServers, true), iceServers)
})

test('filterIceServers keeps a credential-free STUN derived from turn: UDP when only TURN is configured', () => {
  const onlyTurn = [{
    urls: [
      'turn:rt.wiremess.io.vn:3478?transport=udp',
      'turn:rt.wiremess.io.vn:3478?transport=tcp',
      'turns:rt.wiremess.io.vn:5349?transport=tcp',
    ],
    username: 'u',
    credential: 'p',
  }]
  assert.deepEqual(filterIceServers(onlyTurn, false), [{ urls: ['stun:rt.wiremess.io.vn:3478'] }])
  assert.deepEqual(filterIceServers(onlyTurn, true), onlyTurn)
  assert.deepEqual(filterIceServers([{ urls: ['turn:t.example.test:3478?transport=tcp', 'turns:t.example.test:5349'], username: 'u', credential: 'p' }], false), [])
})

test('file-v7 streams 0 B, 1 B, 300 KiB and 6 MiB+17 B across 2 connections with work-stealing and Worker SHA-256', async t => {
  installTransferMockWorker(t)
  for (const size of [0, 1, 300 * 1024, 6 * 1024 * 1024 + 17]) {
    const payload = randomBytes(size)
    const expectedHash = digest(payload)
    const transferId = `v7-${size}`
    const abort = new AbortController()
    const target = createMemoryTarget(`v7-${size}.bin`)
    const disk = await createPartFileStorage(target, abort.signal, size, v7BlockBytes(size))

    let finalizedHash = null
    let finishPromise = null
    let sender
    const channels = [0, 1].map(idx => createMockChannel(idx, (chIndex, data) => {
      if (typeof data === 'string') {
        const frame = JSON.parse(data)
        if (frame.type === 'END' && receiver.end(chIndex)) finishPromise = receiver.finish()
      } else {
        void receiver.push(data, chIndex)
      }
    }))

    const receiver = createStreamReceiver({
      size,
      signal: abort.signal,
      protocolVersion: HIGH_SPEED_PROTOCOL,
      channelCount: 2,
      maxWindowBytes: V7_MAX_FILE_WINDOW,
      writePart: (blockIdx, offset, data) => disk.writePart(blockIdx, offset, data),
      acknowledge: (bytes, details) => sender.handle(streamControl('ACK', transferId, bytes, 0, details), 0),
      onProgress() {},
    })

    sender = createStreamSender({
      channels,
      transferId,
      signal: abort.signal,
      protocolVersion: HIGH_SPEED_PROTOCOL,
      onProgress() {},
      roundTripMs: () => 25,
    })

    const caps = receiver.negotiateConnection(65536 + 8)
    assert.equal(caps.maxChunkBytes, 65536)
    assert.equal(caps.maxWindowBytes, V7_MAX_FILE_WINDOW)
    sender.handle(streamControl('READY', transferId, undefined, 0, caps), 0)
    sender.handle(streamControl('READY', transferId, undefined, 1, caps), 1)

    await sender.send(new Blob([payload]), async () => {}, async sha => { finalizedHash = sha })
    assert.equal(await finishPromise, size)
    assert.equal(finalizedHash, expectedHash)
    assert.equal(await disk.verify(finalizedHash), expectedHash)
    await disk.commit()
    assert.equal(target.closed, true)
    assert.deepEqual(target.bytes, payload)
  }
})

test('file-v7 work-stealing routes extra 1 MiB blocks to faster connection when peer connection stalls', async () => {
  const size = 6 * 1024 * 1024
  const payload = randomBytes(size)
  const transferId = 'v7-steal'
  const abort = new AbortController()
  const staged = new Map()
  let finishPromise = null
  let sender

  const receiver = createStreamReceiver({
    size,
    signal: abort.signal,
    protocolVersion: HIGH_SPEED_PROTOCOL,
    channelCount: 2,
    writePart(blockIdx, offset, data) {
      staged.set(offset, Buffer.from(data))
    },
    acknowledge: (bytes, details) => sender.handle(streamControl('ACK', transferId, bytes, 0, details), 0),
    onProgress() {},
  })

  const channels = [0, 1].map(idx => {
    const channel = createMockChannel(idx, (chIndex, data) => {
      if (typeof data === 'string') {
        if (JSON.parse(data).type === 'END' && receiver.end(chIndex)) finishPromise = receiver.finish()
      } else {
        if (chIndex === 1) {
          channel.bufferedAmount = 3 * 1024 * 1024
        }
        void receiver.push(data, chIndex)
      }
    })
    return channel
  })

  const origAdd = channels[1].addEventListener.bind(channels[1])
  const lowListeners = []
  channels[1].addEventListener = (type, fn) => {
    if (type === 'bufferedamountlow') lowListeners.push(fn)
    origAdd(type, fn)
  }
  const origSend = channels[1].send.bind(channels[1])
  channels[1].send = data => {
    origSend(data)
    if (typeof data !== 'string') {
      setTimeout(() => {
        channels[1].bufferedAmount = 0
        for (const fn of [...lowListeners]) fn()
      }, 25)
    }
  }

  sender = createStreamSender({
    channels,
    transferId,
    signal: abort.signal,
    protocolVersion: HIGH_SPEED_PROTOCOL,
    onProgress() {},
  })
  const caps = receiver.negotiateConnection(32768 + 8)
  assert.equal(caps.maxChunkBytes, 32768)
  sender.handle(streamControl('READY', transferId, undefined, 0, caps), 0)
  sender.handle(streamControl('READY', transferId, undefined, 1, caps), 1)
  assert.equal(sender.diagnostics().chunkBytes, 32768)

  await sender.send(new Blob([payload]), async () => {})
  assert.equal(await finishPromise, size)
  assert.ok(channels[0].sentBytes > channels[1].sentBytes * 2,
    `Expected channel 0 (${channels[0].sentBytes}) to steal blocks from throttled channel 1 (${channels[1].sentBytes})`)
})

test('file-v7 receiver rejects frames exceeding negotiated window', () => {
  const abort = new AbortController()
  const receiver = createStreamReceiver({
    size: 10 * 1024 * 1024,
    signal: abort.signal,
    protocolVersion: HIGH_SPEED_PROTOCOL,
    channelCount: 2,
    maxWindowBytes: V7_INITIAL_FILE_WINDOW,
    writePart() {},
    acknowledge() {},
    onProgress() {},
  })
  const chunk = new Uint8Array(64 * 1024)
  const blocksToSend = Math.floor(V7_INITIAL_FILE_WINDOW / (64 * 1024))
  for (let i = 0; i < blocksToSend; i++) {
    const frame = new Uint8Array(8 + chunk.length)
    new DataView(frame.buffer).setBigUint64(0, BigInt(i * 64 * 1024))
    frame.set(chunk, 8)
    // Channel 0 takes block 0..3 (4 * 1 MiB) = V7_INITIAL_FILE_WINDOW
    receiver.push(frame.buffer, 0)
  }
  const overflow = new Uint8Array(8 + 1024)
  new DataView(overflow.buffer).setBigUint64(0, BigInt(V7_INITIAL_FILE_WINDOW))
  assert.throws(() => receiver.push(overflow.buffer, 1), /vượt cửa sổ ACK/)
})

test('file-v7 holds ACK until contiguous block 0 finishes and enforces out-of-order block bound', async () => {
  const acks = []
  const abort = new AbortController()
  const blockBytes = 1024 * 1024
  const size = 20 * blockBytes
  const receiver = createStreamReceiver({
    size,
    signal: abort.signal,
    protocolVersion: HIGH_SPEED_PROTOCOL,
    channelCount: 2,
    maxWindowBytes: V7_MAX_FILE_WINDOW,
    writePart() {},
    acknowledge: bytes => acks.push(bytes),
    onProgress() {},
  })

  const makeBlockFrames = blockIndex => {
    const frames = []
    for (let pos = 0; pos < blockBytes; pos += 64 * 1024) {
      const f = new Uint8Array(8 + 64 * 1024)
      new DataView(f.buffer).setBigUint64(0, BigInt(blockIndex * blockBytes + pos))
      frames.push(f.buffer)
    }
    return frames
  }

  // Send block 1 completely on channel 1 before block 0 starts: ACK must NOT advance
  for (const frame of makeBlockFrames(1)) await receiver.push(frame, 1)
  assert.deepEqual(acks, [])

  // Block index >= contiguousBlocks (0) + V7_MAX_OUT_OF_ORDER_BLOCKS (16) is rejected immediately
  const tooFar = new Uint8Array(8 + 64 * 1024)
  new DataView(tooFar.buffer).setBigUint64(0, BigInt(V7_MAX_OUT_OF_ORDER_BLOCKS * blockBytes))
  assert.throws(() => receiver.push(tooFar.buffer, 0), /giới hạn lệch thứ tự/)

  // Now complete block 0 on channel 0: ACK immediately jumps across both block 0 and block 1 (2 MiB)
  for (const frame of makeBlockFrames(0)) await receiver.push(frame, 0)
  assert.deepEqual(acks, [2 * blockBytes])
})

test('file-v7 proceeds on channel 0 alone when secondary connection never sends READY', async t => {
  installTransferMockWorker(t)
  const size = 2 * 1024 * 1024 + 55
  const payload = randomBytes(size)
  const expectedHash = digest(payload)
  const transferId = 'v7-single-ready'
  const abort = new AbortController()
  const target = createMemoryTarget('v7-single-ready.bin')
  const disk = await createPartFileStorage(target, abort.signal, size, v7BlockBytes(size))

  let finalizedHash = null
  let finishPromise = null
  let sender
  const channels = [0, 1].map(idx => createMockChannel(idx, (chIndex, data) => {
    if (typeof data === 'string') {
      const frame = JSON.parse(data)
      if (frame.type === 'END' && receiver.end(chIndex, frame.activeChannels)) finishPromise = receiver.finish()
    } else {
      void receiver.push(data, chIndex)
    }
  }))

  const receiver = createStreamReceiver({
    size,
    signal: abort.signal,
    protocolVersion: HIGH_SPEED_PROTOCOL,
    channelCount: 2,
    maxWindowBytes: V7_MAX_FILE_WINDOW,
    writePart: (blockIdx, offset, data) => disk.writePart(blockIdx, offset, data),
    acknowledge: (bytes, details) => sender.handle(streamControl('ACK', transferId, bytes, 0, details), 0),
    onProgress() {},
  })

  sender = createStreamSender({
    channels,
    transferId,
    signal: abort.signal,
    protocolVersion: HIGH_SPEED_PROTOCOL,
    onProgress() {},
    readyGraceMs: 20,
  })

  const caps = receiver.negotiateConnection(65536 + 8)
  sender.handle(streamControl('READY', transferId, undefined, 0, caps), 0)
  // Channel 1 intentionally never sends READY (simulating NAT failure on second PC)

  await sender.send(new Blob([payload]), async () => {}, async sha => { finalizedHash = sha })
  assert.equal(await finishPromise, size)
  assert.equal(finalizedHash, expectedHash)
  assert.equal(await disk.verify(finalizedHash), expectedHash)
  await disk.commit()
  assert.deepEqual(target.bytes, payload)
  assert.equal(channels[1].sentFrames, 0)
})

test('file-v7 uses 256 KiB low threshold across 2 connections and unlocks 16 MiB window at ~4.5 MB/s with 11 ms write time', () => {
  const channels = [0, 1].map(idx => createMockChannel(idx, () => {}))
  createStreamSender({
    channels,
    transferId: 'v7-threshold',
    signal: new AbortController().signal,
    protocolVersion: HIGH_SPEED_PROTOCOL,
    onProgress() {},
  })
  assert.equal(V7_SEND_BUFFER_PER_CONNECTION, 512 * 1024)
  for (const channel of channels)
    assert.equal(channel.bufferedAmountLowThreshold, 256 * 1024)

  for (const rtt of [10, null]) {
    let now = 0
    const flow = createFileFlowControl({
      initialWindow: V7_INITIAL_FILE_WINDOW,
      maxWindowCap: V7_MAX_FILE_WINDOW,
      slowWriteMs: 300,
      clock: () => now,
      roundTripMs: () => rtt,
    })
    flow.negotiate(V7_MAX_FILE_WINDOW)
    for (let epoch = 1; epoch <= 10; epoch++) {
      now += 500
      flow.waited('buffer', 450)
      flow.acknowledge(epoch * 2_250_000, 11)
    }
    assert.ok(flow.windowBytes > 8 * 1024 * 1024, `Expected windowBytes (${flow.windowBytes}) > 8 MiB`)
    assert.equal(flow.windowBytes, V7_MAX_FILE_WINDOW)
  }
})

test('file-v7 streams 6 MiB+17 B across 4 parallel connections with exact Worker SHA-256', async t => {
  installTransferMockWorker(t)
  const size = 6 * 1024 * 1024 + 17
  const payload = randomBytes(size)
  const expectedHash = digest(payload)
  const transferId = 'v7-4conns'
  const abort = new AbortController()
  const target = createMemoryTarget('v7-4conns.bin')
  const disk = await createPartFileStorage(target, abort.signal, size, v7BlockBytes(size))

  let finalizedHash = null
  let finishPromise = null
  let sender
  const channels = [0, 1, 2, 3].map(idx => createMockChannel(idx, (chIndex, data) => {
    if (typeof data === 'string') {
      const frame = JSON.parse(data)
      if (frame.type === 'END' && receiver.end(chIndex, frame.activeChannels)) finishPromise = receiver.finish()
    } else {
      void receiver.push(data, chIndex)
    }
  }))

  const receiver = createStreamReceiver({
    size,
    signal: abort.signal,
    protocolVersion: HIGH_SPEED_PROTOCOL,
    channelCount: 4,
    maxWindowBytes: V7_MAX_FILE_WINDOW,
    writePart: (blockIdx, offset, data) => disk.writePart(blockIdx, offset, data),
    acknowledge: (bytes, details) => sender.handle(streamControl('ACK', transferId, bytes, 0, details), 0),
    onProgress() {},
  })

  sender = createStreamSender({
    channels,
    transferId,
    signal: abort.signal,
    protocolVersion: HIGH_SPEED_PROTOCOL,
    onProgress() {},
    roundTripMs: () => 25,
  })

  const caps = receiver.negotiateConnection(65536 + 8)
  for (let idx = 0; idx < 4; idx++)
    sender.handle(streamControl('READY', transferId, undefined, idx, caps), idx)

  await sender.send(new Blob([payload]), async () => {}, async sha => { finalizedHash = sha })
  assert.equal(await finishPromise, size)
  assert.equal(finalizedHash, expectedHash)
  assert.equal(await disk.verify(finalizedHash), expectedHash)
  await disk.commit()
  assert.deepEqual(target.bytes, payload)
  for (const ch of channels) assert.ok(ch.sentBytes > 0, 'Expected all 4 connections to send blocks')
})

test('file-v7 secondary connection lowering maxMessageSize does not reject in-flight 64 KiB chunks on connection 0', () => {
  const writes = []
  const receiver = createStreamReceiver({
    size: 2 * 1024 * 1024,
    signal: new AbortController().signal,
    protocolVersion: HIGH_SPEED_PROTOCOL,
    channelCount: 2,
    maxWindowBytes: V7_MAX_FILE_WINDOW,
    writePart(blockIdx, offset, data) { writes.push({ blockIdx, offset, bytes: data.byteLength }) },
    acknowledge() {},
    onProgress() {},
  })

  const caps0 = receiver.negotiateConnection(65536 + 8, 0)
  assert.equal(caps0.maxChunkBytes, 65536)
  const caps1 = receiver.negotiateConnection(32768 + 8, 1)
  assert.equal(caps1.maxChunkBytes, 32768)

  const frame64k = new Uint8Array(8 + 65536)
  new DataView(frame64k.buffer).setBigUint64(0, 0n)
  assert.doesNotThrow(() => receiver.push(frame64k.buffer, 0))

  const oversizedForConn1 = new Uint8Array(8 + 65536)
  new DataView(oversizedForConn1.buffer).setBigUint64(0, BigInt(1024 * 1024))
  assert.throws(() => receiver.push(oversizedForConn1.buffer, 1), /kích thước/)
})

test('file-v7 flow control shrinks window when RTT spikes >= 500 ms (bufferbloat protection)', () => {
  let now = 0
  let rtt = 25
  const flow = createFileFlowControl({
    initialWindow: V7_INITIAL_FILE_WINDOW,
    maxWindowCap: V7_MAX_FILE_WINDOW,
    slowWriteMs: 300,
    clock: () => now,
    roundTripMs: () => rtt,
  })
  flow.negotiate(V7_MAX_FILE_WINDOW)
  for (let epoch = 1; epoch <= 4; epoch++) {
    now += 500
    flow.waited('buffer', 400)
    flow.acknowledge(epoch * 3_000_000, 10)
  }
  const grown = flow.windowBytes
  assert.ok(grown > V7_INITIAL_FILE_WINDOW)

  rtt = 900
  now += 500
  flow.acknowledge(15_000_000, 10)
  assert.ok(flow.windowBytes < grown, `Expected window (${flow.windowBytes}) < grown (${grown}) at RTT ${rtt}ms`)
})

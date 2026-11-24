import { sha256 } from '@noble/hashes/sha2.js'
import { createFileFlowControl, INITIAL_FILE_WINDOW, MAX_FILE_WINDOW } from './fileFlowControl.js'
import {
  BUFFER_HIGH, BUFFER_LOW, CHUNK_BYTES, DEFERRED_HASH_PROTOCOL, HIGH_SPEED_PROTOCOL,
  LEGACY_MAX_FILE_BYTES, MAX_FILE_BYTES, MAX_FILE_CHANNELS, MULTICHANNEL_PROTOCOL,
  PARALLEL_CONNECTION_COUNT, PARALLEL_CONNECTIONS_PROTOCOL,
  V7_INITIAL_FILE_WINDOW, V7_MAX_CHUNK_BYTES, V7_MAX_FILE_WINDOW, V7_MAX_OUT_OF_ORDER_BLOCKS,
  V7_SEND_BUFFER_PER_CONNECTION, encodeChunk, v7BlockBytes, waitForBuffer,
} from './fileProtocol.js'
import { createOrderedFileHasher } from './fileStorage.js'

export const ACK_WINDOW = 512 * 1024
export const ACK_INTERVAL = 64 * 1024
const DIRECT_WRITE_BYTES = 256 * 1024
const DIRECT_ACK_WINDOW = INITIAL_FILE_WINDOW
const DIRECT_SEND_BUFFER = 1024 ** 2
const FILE_BATCH_BYTES = 512 * 1024
const BATCHED_PROTOCOLS = [DEFERRED_HASH_PROTOCOL, MULTICHANNEL_PROTOCOL, PARALLEL_CONNECTIONS_PROTOCOL, HIGH_SPEED_PROTOCOL]

export function defaultMaxChunkBytes(protocolVersion = 'file-v2') {
  return protocolVersion === HIGH_SPEED_PROTOCOL ? V7_MAX_CHUNK_BYTES : CHUNK_BYTES
}

export function streamHeaderBytes(protocolVersion = 'file-v2') {
  if (protocolVersion === 'file-v2') return 4
  if (protocolVersion === 'file-v3' || BATCHED_PROTOCOLS.includes(protocolVersion)) return 8
  throw new Error('Giao thức truyền file không hợp lệ.')
}

// v2 dùng offset uint32. Từ v3 dùng uint64 để đi qua mốc 4 GiB.
export function encodeStreamChunk(offset, payload, protocolVersion = 'file-v2',
  maxChunkBytes = defaultMaxChunkBytes(protocolVersion)) {
  const header = streamHeaderBytes(protocolVersion)
  if (header === 4) return encodeChunk(offset, payload)
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      !(payload instanceof ArrayBuffer || payload instanceof Uint8Array) ||
      payload.byteLength < 1 || payload.byteLength > maxChunkBytes || offset + payload.byteLength > MAX_FILE_BYTES)
    throw new Error('Chunk không hợp lệ.')
  const frame = new Uint8Array(header + payload.byteLength)
  new DataView(frame.buffer).setBigUint64(0, BigInt(offset))
  frame.set(payload instanceof Uint8Array ? payload : new Uint8Array(payload), header)
  return frame.buffer
}

export function readStreamChunk(frame, protocolVersion = 'file-v2',
  maxChunkBytes = defaultMaxChunkBytes(protocolVersion)) {
  const header = streamHeaderBytes(protocolVersion)
  if (!(frame instanceof ArrayBuffer) || frame.byteLength <= header || frame.byteLength > header + maxChunkBytes)
    throw new Error('Chunk có kích thước không hợp lệ.')
  const view = new DataView(frame)
  const offset = header === 8 ? Number(view.getBigUint64(0)) : view.getUint32(0)
  if (!Number.isSafeInteger(offset) || offset + frame.byteLength - header > MAX_FILE_BYTES)
    throw new Error('Chunk vượt kích thước tối đa.')
  return { offset, payload: new Uint8Array(frame, header) }
}

function validateSize(size, protocolVersion) {
  const maximum = streamHeaderBytes(protocolVersion) === 8 ? MAX_FILE_BYTES : LEGACY_MAX_FILE_BYTES
  if (!Number.isSafeInteger(size) || size < 0 || size > maximum)
    throw new Error('Kích thước tệp không hợp lệ cho giao thức đã chọn.')
}

function validateChannelCount(count, protocolVersion) {
  let valid = count === 1
  if (protocolVersion === MULTICHANNEL_PROTOCOL)
    valid = Number.isInteger(count) && count >= 1 && count <= MAX_FILE_CHANNELS
  if (protocolVersion === PARALLEL_CONNECTIONS_PROTOCOL) valid = count === PARALLEL_CONNECTION_COUNT
  if (protocolVersion === HIGH_SPEED_PROTOCOL) valid = Number.isInteger(count) && (count === 1 || count === 2 || count === 4)
  if (!valid) throw new Error('Số kênh không hợp lệ cho giao thức đã chọn.')
}

// Dùng cho giao thức cũ còn yêu cầu SHA-256 ngay lúc mời.
export async function hashFile(file, signal, onProgress = () => {}) {
  const hash = sha256.create()
  try {
    for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
      signal.throwIfAborted()
      const chunk = await file.slice(offset, offset + 1024 * 1024).arrayBuffer()
      signal.throwIfAborted()
      hash.update(new Uint8Array(chunk))
      onProgress(offset + chunk.byteLength)
    }
    signal.throwIfAborted()
    return [...hash.digest()].map(byte => byte.toString(16).padStart(2, '0')).join('')
  } finally { hash.destroy() }
}

async function* readHashedBatches(file, signal) {
  const worker = new Worker(new URL('./fileHashWorker.js', import.meta.url), { type: 'module' })
  let pending
  const rejectRead = error => pending?.reject(error)
  const abort = () => rejectRead(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  worker.onmessage = ({ data }) => {
    if (data.error) rejectRead(new Error(data.error))
    else pending?.resolve(data)
    pending = null
  }
  const workerFailed = () => rejectRead(new Error('Không đọc được dữ liệu từ luồng tính SHA-256.'))
  worker.onerror = workerFailed
  worker.onmessageerror = workerFailed
  const pull = source => new Promise((resolve, reject) => {
    signal.throwIfAborted()
    pending = { resolve, reject }
    worker.postMessage(source)
  })
  try {
    let next = pull(file)
    while (next) {
      const batch = await next
      // Tối đa một lô gửi và một lô đọc trước. Nếu mạng chậm, Worker sẽ dừng ở đây.
      next = batch.sha256Hex ? null : pull(null)
      void next?.catch(() => {}) // Lỗi được ném khi vòng gửi lấy lô kế tiếp.
      yield batch
    }
  } finally {
    signal.removeEventListener('abort', abort)
    worker.terminate()
  }
}

export function streamControl(type, transferId, bytes, channel = 0, details = {}) {
  return JSON.stringify({ type, transferId, channel, ...(bytes === undefined ? {} : { bytes }), ...details })
}

export function readStreamControl(text, transferId, channel = 0) {
  if (typeof text !== 'string' || text.length > 256) throw new Error('Khung điều khiển không hợp lệ.')
  const frame = JSON.parse(text)
  if (!frame || frame.transferId !== transferId || frame.channel !== channel ||
      !['READY', 'ACK', 'END'].includes(frame.type))
    throw new Error('Khung điều khiển sai phiên hoặc sai kênh.')
  return frame
}

// Kênh 0 nhận ACK cho số byte liên tiếp đã ghi xong. Cửa sổ áp dụng chung cho cả file.
export function createStreamSender({ channels, transferId, signal, onProgress, protocolVersion = 'file-v2',
  roundTripMs, clock = () => performance.now(), readyGraceMs = 2000 }) {
  const header = streamHeaderBytes(protocolVersion)
  validateChannelCount(channels.length, protocolVersion)
  const highSpeed = protocolVersion === HIGH_SPEED_PROTOCOL
  const batched = BATCHED_PROTOCOLS.includes(protocolVersion)
  const flow = createFileFlowControl({
    initialWindow: highSpeed ? V7_INITIAL_FILE_WINDOW : (batched ? DIRECT_ACK_WINDOW : ACK_WINDOW),
    maxWindowCap: highSpeed ? V7_MAX_FILE_WINDOW : MAX_FILE_WINDOW,
    slowWriteMs: highSpeed ? 300 : 100,
    clock,
    roundTripMs,
  })
  // v7 cấp đệm gửi 512 KiB riêng cho mỗi kết nối độc lập với ngưỡng low 50% (256 KiB).
  const sendBuffer = highSpeed ? V7_SEND_BUFFER_PER_CONNECTION
    : (batched ? Math.floor(DIRECT_SEND_BUFFER / channels.length) : BUFFER_HIGH)
  const lowThreshold = Math.max(BUFFER_LOW, Math.floor(sendBuffer / 2))
  for (const channel of channels)
    channel.bufferedAmountLowThreshold = lowThreshold
  const changes = new EventTarget()
  const readyChannels = new Set()
  let negotiatedChunkBytes = defaultMaxChunkBytes(protocolVersion)
  let sent = 0
  let acknowledged = 0
  const activeWaits = { ack: null, buffer: null }
  function startWait(kind) {
    let state = activeWaits[kind]
    if (!state) {
      state = { count: 0, started: clock() }
      activeWaits[kind] = state
    }
    state.count++
  }
  function stopWait(kind) {
    const state = activeWaits[kind]
    if (!state) return
    state.count--
    if (state.count === 0) {
      flow.waited(kind, clock() - state.started)
      activeWaits[kind] = null
    }
  }
  async function trackWait(kind, operation) {
    startWait(kind)
    try { await operation() }
    finally { stopWait(kind) }
  }
  function waitUntil(predicate) {
    return new Promise((resolve, reject) => {
      function check() {
        if (!signal.aborted && !predicate()) return
        changes.removeEventListener('change', check)
        signal.removeEventListener('abort', check)
        if (signal.aborted) reject(signal.reason)
        else resolve()
      }
      changes.addEventListener('change', check)
      signal.addEventListener('abort', check, { once: true })
      check()
    })
  }
  function waitReadyGrace(ms) {
    if (readyChannels.size === channels.length || ms <= 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const done = error => {
        clearTimeout(timer)
        changes.removeEventListener('change', onChange)
        signal.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }
      const onChange = () => {
        if (readyChannels.size === channels.length) done()
      }
      const onAbort = () => done(signal.reason)
      const timer = setTimeout(() => done(), ms)
      changes.addEventListener('change', onChange)
      signal.addEventListener('abort', onAbort, { once: true })
      onChange()
    })
  }

  async function sendBatch(offset, data, chunkBytes = CHUNK_BYTES,
    selectChannel = position => channels[Math.floor(position / CHUNK_BYTES) % channels.length],
    enforceSendWindow = true) {
    const bytes = new Uint8Array(data)
    for (let start = 0; start < bytes.length; start += chunkBytes) {
      const position = offset + start
      const channel = selectChannel(position)
      const payload = bytes.subarray(start, start + chunkBytes)
      const length = payload.byteLength
      if (enforceSendWindow) {
        while (sent - acknowledged + length > flow.windowBytes) {
          await trackWait('ack', () => waitUntil(() => sent - acknowledged + length <= flow.windowBytes))
        }
      }
      if (channel.bufferedAmount + length + header > sendBuffer) {
        await trackWait('buffer', () => waitForBuffer(channel, signal, length + header, sendBuffer))
      }
      signal.throwIfAborted()
      sent += length
      channel.send(encodeStreamChunk(position, payload, protocolVersion, chunkBytes))
    }
  }

  return {
    handle(text, index = 0) {
      const frame = readStreamControl(text, transferId, index)
      if (frame.type === 'READY' && channels[index] && !readyChannels.has(index)) {
        if (batched && index === 0) flow.negotiate(frame.maxWindowBytes)
        if (highSpeed && frame.maxChunkBytes !== undefined) {
          if (!Number.isSafeInteger(frame.maxChunkBytes) ||
              frame.maxChunkBytes < CHUNK_BYTES || frame.maxChunkBytes > V7_MAX_CHUNK_BYTES)
            throw new Error('Kích thước khung READY không hợp lệ.')
          negotiatedChunkBytes = Math.min(negotiatedChunkBytes, frame.maxChunkBytes)
        }
        readyChannels.add(index)
      }
      else if (frame.type === 'ACK' && index === 0 && (highSpeed ? readyChannels.has(0) : readyChannels.size === channels.length) &&
          Number.isSafeInteger(frame.bytes) && frame.bytes >= acknowledged && frame.bytes <= sent) {
        if (frame.bytes > acknowledged) {
          flow.acknowledge(frame.bytes, frame.writeMs)
          acknowledged = frame.bytes
          onProgress(acknowledged)
        }
      } else throw new Error('ACK hoặc READY không hợp lệ.')
      changes.dispatchEvent(new Event('change'))
    },
    diagnostics() {
      const snapshot = flow.snapshot()
      return { ...snapshot,
        ackWaitMs: snapshot.ackWaitMs + (activeWaits.ack ? clock() - activeWaits.ack.started : 0),
        bufferWaitMs: snapshot.bufferWaitMs + (activeWaits.buffer ? clock() - activeWaits.buffer.started : 0),
        inFlightBytes: sent - acknowledged,
        bufferedBytes: channels.reduce((total, channel) => total + (channel?.bufferedAmount || 0), 0),
        ...(highSpeed ? { chunkBytes: negotiatedChunkBytes } : {}) }
    },
    async send(file, begin, finalizeHash) {
      validateSize(file.size, protocolVersion)
      if (highSpeed) {
        await waitUntil(() => readyChannels.has(0))
        if (readyChannels.size < channels.length) await waitReadyGrace(readyGraceMs)
        signal.throwIfAborted()
        await begin()
        const blockBytes = v7BlockBytes(file.size)
        const totalBlocks = file.size === 0 ? 0 : Math.ceil(file.size / blockBytes)
        let nextBlock = 0
        async function claimNextBlock() {
          if (activeWaits.ack) await Promise.resolve()
          for (;;) {
            signal.throwIfAborted()
            if (nextBlock >= totalBlocks) return null
            const blockIndex = nextBlock
            const blockOffset = blockIndex * blockBytes
            const length = Math.min(blockBytes, file.size - blockOffset)
            if (blockOffset + length - acknowledged <= flow.windowBytes) {
              nextBlock = blockIndex + 1
              return { blockIndex, blockOffset, length }
            }
            startWait('ack')
            try {
              await waitUntil(() =>
                nextBlock >= totalBlocks ||
                nextBlock * blockBytes + Math.min(blockBytes, file.size - nextBlock * blockBytes) - acknowledged <= flow.windowBytes)
            } finally {
              stopWait('ack')
            }
          }
        }
        const hasher = finalizeHash ? createOrderedFileHasher(totalBlocks) : null
        const prefetched = new Map()
        const prefetchNext = () => {
          const idx = nextBlock
          if (idx >= totalBlocks || prefetched.size >= 2 || prefetched.has(idx)) return
          const offset = idx * blockBytes
          const len = Math.min(blockBytes, file.size - offset)
          const pendingRead = file.slice(offset, offset + len).arrayBuffer()
          void pendingRead.catch(() => {})
          prefetched.set(idx, pendingRead)
        }
        const readBlockData = block => {
          const hit = prefetched.get(block.blockIndex)
          if (hit) {
            prefetched.delete(block.blockIndex)
            return hit
          }
          return file.slice(block.blockOffset, block.blockOffset + block.length).arrayBuffer()
        }
        try {
          await Promise.all(channels.map(async (channel, index) => {
            if (!readyChannels.has(index)) {
              await waitUntil(() => readyChannels.has(index) || nextBlock >= totalBlocks)
              if (!readyChannels.has(index)) return
            }
            for (;;) {
              if (nextBlock >= totalBlocks) {
                changes.dispatchEvent(new Event('change'))
                break
              }
              if (channel.bufferedAmount + negotiatedChunkBytes + header > sendBuffer) {
                await trackWait('buffer', () => waitForBuffer(channel, signal, negotiatedChunkBytes + header, sendBuffer))
              }
              const block = await claimNextBlock()
              if (!block) {
                changes.dispatchEvent(new Event('change'))
                break
              }
              prefetchNext()
              const data = await readBlockData(block)
              if (data.byteLength !== block.length) throw new Error('Đọc thiếu byte từ tệp gốc.')
              prefetchNext()
              await sendBatch(block.blockOffset, data, negotiatedChunkBytes, () => channel, false)
              hasher?.push(block.blockIndex, data)
            }
          }))
          if (hasher) await finalizeHash(await hasher.digest())
        } finally {
          prefetched.clear()
          hasher?.dispose()
        }
      } else {
        await waitUntil(() => readyChannels.size === channels.length)
        signal.throwIfAborted()
        await begin()
        if (finalizeHash) {
          for await (const { offset, data, sha256Hex } of readHashedBatches(file, signal)) {
            if (offset !== sent || data.byteLength > file.size - sent)
              throw new Error('Đọc sai vị trí tệp gốc.')
            if (sha256Hex) {
              // Server kiểm tra phiên và chốt hash trong khi khối cuối vẫn có thể đang truyền.
              await Promise.all([finalizeHash(sha256Hex), sendBatch(offset, data)])
            } else await sendBatch(offset, data)
          }
        } else if (batched) {
          for (let offset = 0; offset < file.size; offset += FILE_BATCH_BYTES) {
            signal.throwIfAborted()
            const length = Math.min(FILE_BATCH_BYTES, file.size - offset)
            const data = await file.slice(offset, offset + length).arrayBuffer()
            if (data.byteLength !== length) throw new Error('Đọc thiếu byte từ tệp gốc.')
            await sendBatch(offset, data)
          }
        } else {
          const [channel] = channels
          for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
            const length = Math.min(CHUNK_BYTES, file.size - offset)
            if (sent - acknowledged + length > flow.windowBytes)
              await trackWait('ack', () => waitUntil(() => sent - acknowledged + length <= flow.windowBytes))
            if (channel.bufferedAmount + length + header > BUFFER_HIGH)
              await trackWait('buffer', () => waitForBuffer(channel, signal, length + header))
            const payload = await file.slice(offset, offset + length).arrayBuffer()
            signal.throwIfAborted()
            sent += payload.byteLength
            channel.send(encodeStreamChunk(offset, payload, protocolVersion))
          }
        }
      }
      if (sent !== file.size) throw new Error('Đọc thiếu byte từ tệp gốc.')
      const activeChannels = highSpeed
        ? channels.map((channel, index) => ({ channel, index })).filter(({ index }) => readyChannels.has(index))
        : channels.map((channel, index) => ({ channel, index }))
      const endDetails = highSpeed && activeChannels.length < channels.length
        ? { activeChannels: activeChannels.length } : undefined
      await Promise.all(activeChannels.map(async ({ channel, index }) => {
        await waitForBuffer(channel, signal, 256, sendBuffer)
        signal.throwIfAborted()
        channel.send(streamControl('END', transferId, undefined, index, endDetails))
      }))
      await waitUntil(() => acknowledged === file.size)
    },
  }
}

// Kiểm tra ngay khi nhận để chặn peer gửi vượt cửa sổ trong lúc writer còn chậm.
export function createStreamReceiver({ size, signal, write, writePart, acknowledge, onProgress, protocolVersion = 'file-v2',
  channelCount = 1,
  maxWindowBytes = protocolVersion === HIGH_SPEED_PROTOCOL ? V7_MAX_FILE_WINDOW : DIRECT_ACK_WINDOW,
  maxChunkBytes = defaultMaxChunkBytes(protocolVersion) }) {
  validateSize(size, protocolVersion)
  validateChannelCount(channelCount, protocolVersion)
  const header = streamHeaderBytes(protocolVersion)
  const highSpeed = protocolVersion === HIGH_SPEED_PROTOCOL
  const batched = BATCHED_PROTOCOLS.includes(protocolVersion)
  const requiresChannelEnds = protocolVersion === MULTICHANNEL_PROTOCOL ||
    protocolVersion === PARALLEL_CONNECTIONS_PROTOCOL || highSpeed
  const minWindow = highSpeed ? V7_INITIAL_FILE_WINDOW : DIRECT_ACK_WINDOW
  const maxWindow = highSpeed ? V7_MAX_FILE_WINDOW : MAX_FILE_WINDOW
  if (batched && (!Number.isSafeInteger(maxWindowBytes) || maxWindowBytes < minWindow || maxWindowBytes > maxWindow))
    throw new Error('Hạn mức cửa sổ nhận không hợp lệ.')
  if (highSpeed && (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < CHUNK_BYTES || maxChunkBytes > V7_MAX_CHUNK_BYTES))
    throw new Error('Kích thước khung nhận không hợp lệ.')
  let effectiveChunkBytes = maxChunkBytes
  const windowBytes = batched ? maxWindowBytes : ACK_WINDOW
  const ackBytes = batched ? DIRECT_WRITE_BYTES : ACK_INTERVAL
  const nextOffsets = Array.from({ length: channelCount }, (_, index) => index * CHUNK_BYTES)
  const endedChannels = new Set()
  const pending = new Map()
  const MAX_QUEUED_V7_WRITES = 8
  const blockBytes = highSpeed ? v7BlockBytes(size) : 0
  const totalBlocks = highSpeed && size > 0 ? Math.ceil(size / blockBytes) : 0
  const activeBlocks = highSpeed ? new Array(channelCount).fill(null) : null
  const claimedBlocks = highSpeed ? new Set() : null
  const writtenBlocks = highSpeed ? new Set() : null
  const readyForAckBlocks = highSpeed ? new Set() : null
  let requiredEndChannels = channelCount
  let completedBlocks = 0
  let contiguousBlocks = 0
  let contiguousBytes = 0
  let contiguousAckBlocks = 0
  let contiguousAckBytes = 0
  let pendingWrites = 0
  let received = 0
  let written = 0
  let acknowledged = 0
  let ended = false
  let queue = Promise.resolve()
  let batch
  let buffered = 0
  let writeMs = null
  let writeChain = Promise.resolve()
  function advanceContiguousAck() {
    while (readyForAckBlocks.has(contiguousAckBlocks) &&
           contiguousAckBlocks - contiguousBlocks < MAX_QUEUED_V7_WRITES) {
      readyForAckBlocks.delete(contiguousAckBlocks)
      const blkOffset = contiguousAckBlocks * blockBytes
      contiguousAckBytes += Math.min(blockBytes, size - blkOffset)
      contiguousAckBlocks++
    }
    if (contiguousAckBytes > acknowledged) {
      acknowledged = contiguousAckBytes
      acknowledge(contiguousAckBytes, writeMs === null ? {} : { writeMs })
    }
  }
  function queueWrite(payload) {
    let data = payload
    if (batched) {
      batch ??= new Uint8Array(Math.min(DIRECT_WRITE_BYTES, size - received))
      batch.set(payload, buffered)
      buffered += payload.byteLength
    }
    received += payload.byteLength
    if (batched) {
      if (buffered < batch.byteLength) return
      data = batch
      batch = null
      buffered = 0
    }
    const position = received - data.byteLength
    queue = queue.then(async () => {
      signal.throwIfAborted()
      const started = performance.now()
      await write(position, data)
      writeMs = Math.min(60_000, performance.now() - started)
      signal.throwIfAborted()
      written += data.byteLength
      onProgress(written)
      if (written - acknowledged >= ackBytes || written === size) {
        acknowledge(written, batched ? { writeMs } : {})
        acknowledged = written
      }
    })
  }

  function queueHighSpeedWrite(block) {
    pendingWrites++
    readyForAckBlocks.add(block.blockIndex)
    if (contiguousAckBlocks - contiguousBlocks < MAX_QUEUED_V7_WRITES) {
      queueMicrotask(() => {
        if (!signal.aborted && !ended) advanceContiguousAck()
      })
    }
    const started = performance.now()
    const runWrite = writePart
      ? Promise.resolve().then(() => {
          signal.throwIfAborted()
          return writePart(block.blockIndex, block.startOffset, block.data)
        })
      : (() => {
          const next = writeChain.then(() => {
            signal.throwIfAborted()
            return write(block.startOffset, block.data)
          })
          writeChain = next.catch(() => {})
          return next
        })()
    const op = runWrite.then(() => {
      writeMs = Math.min(60_000, (performance.now() - started) / Math.max(1, pendingWrites))
      signal.throwIfAborted()
      written += block.blockLength
      writtenBlocks.add(block.blockIndex)
      while (writtenBlocks.has(contiguousBlocks)) {
        writtenBlocks.delete(contiguousBlocks)
        const blkOffset = contiguousBlocks * blockBytes
        contiguousBytes += Math.min(blockBytes, size - blkOffset)
        contiguousBlocks++
      }
    }).finally(() => {
      pendingWrites--
    }).then(() => {
      if (!signal.aborted && !ended) advanceContiguousAck()
    })
    queue = Promise.all([queue, op]).then(() => {})
  }

  return {
    get capabilities() {
      if (highSpeed) return { maxWindowBytes: windowBytes, maxChunkBytes: effectiveChunkBytes }
      return batched ? { maxWindowBytes: windowBytes } : {}
    },
    negotiateConnection(sctpMaxMessageSize) {
      if (highSpeed && Number.isFinite(sctpMaxMessageSize)) {
        const clamped = Math.min(maxChunkBytes, Math.floor((sctpMaxMessageSize - header) / 1024) * 1024)
        if (clamped < CHUNK_BYTES) throw new Error('WebRTC không hỗ trợ kích thước khung truyền.')
        effectiveChunkBytes = Math.min(effectiveChunkBytes, clamped)
      }
      return this.capabilities
    },
    diagnostics() {
      return {
        maximumWindowBytes: windowBytes,
        queuedBytes: [...pending.values()].reduce((total, data) => total + data.byteLength, 0) + received - written,
        receiverWriteMs: writeMs,
        ...(highSpeed ? { chunkBytes: effectiveChunkBytes } : {}),
      }
    },
    push(frame, index = 0) {
      signal.throwIfAborted()
      if (highSpeed) {
        const { offset, payload } = readStreamChunk(frame, protocolVersion, effectiveChunkBytes)
        if (ended || endedChannels.has(index) || index < 0 || index >= channelCount ||
            received + payload.byteLength - acknowledged > windowBytes)
          throw new Error('Chunk sai kênh, vị trí, kích thước hoặc vượt cửa sổ ACK.')
        let active = activeBlocks[index]
        if (!active) {
          if (offset % blockBytes !== 0 || offset >= size)
            throw new Error('Khối dữ liệu sai vị trí hoặc vượt kích thước tệp.')
          const blockIndex = offset / blockBytes
          if (claimedBlocks.has(blockIndex))
            throw new Error('Khối dữ liệu bị trùng lặp.')
          if (blockIndex >= contiguousAckBlocks + V7_MAX_OUT_OF_ORDER_BLOCKS)
            throw new Error('Khối dữ liệu vượt giới hạn lệch thứ tự.')
          const blockLength = Math.min(blockBytes, size - offset)
          claimedBlocks.add(blockIndex)
          active = { blockIndex, startOffset: offset, blockLength, receivedBytes: 0, data: new Uint8Array(blockLength) }
          activeBlocks[index] = active
        }
        if (offset !== active.startOffset + active.receivedBytes ||
            active.receivedBytes + payload.byteLength > active.blockLength)
          throw new Error('Chunk sai thứ tự trong khối hoặc vượt kích thước khối.')
        active.data.set(payload, active.receivedBytes)
        active.receivedBytes += payload.byteLength
        received += payload.byteLength
        onProgress(received)
        if (active.receivedBytes === active.blockLength) {
          activeBlocks[index] = null
          completedBlocks++
          queueHighSpeedWrite(active)
        }
        return queue
      }
      const { offset, payload } = readStreamChunk(frame, protocolVersion)
      if (ended || endedChannels.has(index) || offset !== nextOffsets[index] ||
          payload.byteLength !== Math.min(CHUNK_BYTES, size - offset) ||
          offset + payload.byteLength - acknowledged > windowBytes)
        throw new Error('Chunk sai kênh, vị trí, kích thước hoặc vượt cửa sổ ACK.')
      nextOffsets[index] += CHUNK_BYTES * channelCount
      if (offset === received) {
        queueWrite(payload)
        // Chỉ chuyển dải byte liên tiếp cho cùng một writer để giữ đúng thứ tự SHA-256.
        while (pending.has(received)) {
          const next = pending.get(received)
          pending.delete(received)
          queueWrite(next)
        }
      } else pending.set(offset, payload)
      return queue
    },
    end(index, activeChannelCount) {
      signal.throwIfAborted()
      if (highSpeed) {
        if (activeChannelCount !== undefined) {
          if (!Number.isInteger(activeChannelCount) || activeChannelCount < 1 || activeChannelCount > channelCount)
            throw new Error('Số kênh kết thúc không hợp lệ.')
          requiredEndChannels = activeChannelCount
        }
        if (ended || endedChannels.has(index) || index < 0 || index >= channelCount || activeBlocks[index] !== null)
          throw new Error('Kênh chưa gửi đủ dữ liệu hoặc END lặp.')
        endedChannels.add(index)
        return endedChannels.size >= requiredEndChannels
      }
      if (ended || endedChannels.has(index) || nextOffsets[index] === undefined || nextOffsets[index] < size)
        throw new Error('Kênh chưa gửi đủ dữ liệu hoặc END lặp.')
      endedChannels.add(index)
      return endedChannels.size === channelCount
    },
    async finish() {
      const expectedEnds = highSpeed ? requiredEndChannels : channelCount
      if (ended || received !== size || (requiresChannelEnds && endedChannels.size !== expectedEnds) ||
          (highSpeed && completedBlocks !== totalBlocks))
        throw new Error('Tệp chưa nhận đủ byte hoặc END lặp.')
      ended = true
      await queue
      signal.throwIfAborted()
      return written
    },
  }
}

import { sha256 } from '@noble/hashes/sha2.js'
import { createFileFlowControl, INITIAL_FILE_WINDOW, MAX_FILE_WINDOW } from './fileFlowControl.js'
import {
  BUFFER_HIGH, BUFFER_LOW, CHUNK_BYTES, DEFERRED_HASH_PROTOCOL, LEGACY_MAX_FILE_BYTES, MAX_FILE_BYTES, MAX_FILE_CHANNELS,
  MULTICHANNEL_PROTOCOL, PARALLEL_CONNECTION_COUNT, PARALLEL_CONNECTIONS_PROTOCOL, encodeChunk, waitForBuffer,
} from './fileProtocol.js'

export const ACK_WINDOW = 512 * 1024
export const ACK_INTERVAL = 64 * 1024
const DIRECT_WRITE_BYTES = 256 * 1024
const DIRECT_ACK_WINDOW = INITIAL_FILE_WINDOW
const DIRECT_SEND_BUFFER = 1024 ** 2
const FILE_BATCH_BYTES = 512 * 1024
const BATCHED_PROTOCOLS = [DEFERRED_HASH_PROTOCOL, MULTICHANNEL_PROTOCOL, PARALLEL_CONNECTIONS_PROTOCOL]

export function streamHeaderBytes(protocolVersion = 'file-v2') {
  if (protocolVersion === 'file-v2') return 4
  if (protocolVersion === 'file-v3' || BATCHED_PROTOCOLS.includes(protocolVersion)) return 8
  throw new Error('Giao thức truyền file không hợp lệ.')
}

// v2 dùng offset uint32. Từ v3 dùng uint64 để đi qua mốc 4 GiB.
export function encodeStreamChunk(offset, payload, protocolVersion = 'file-v2') {
  const header = streamHeaderBytes(protocolVersion)
  if (header === 4) return encodeChunk(offset, payload)
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      !(payload instanceof ArrayBuffer || payload instanceof Uint8Array) ||
      payload.byteLength < 1 || payload.byteLength > CHUNK_BYTES || offset + payload.byteLength > MAX_FILE_BYTES)
    throw new Error('Chunk không hợp lệ.')
  const frame = new Uint8Array(header + payload.byteLength)
  new DataView(frame.buffer).setBigUint64(0, BigInt(offset))
  frame.set(payload instanceof Uint8Array ? payload : new Uint8Array(payload), header)
  return frame.buffer
}

export function readStreamChunk(frame, protocolVersion = 'file-v2') {
  const header = streamHeaderBytes(protocolVersion)
  if (!(frame instanceof ArrayBuffer) || frame.byteLength <= header || frame.byteLength > header + CHUNK_BYTES)
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
  roundTripMs, clock = () => performance.now() }) {
  const header = streamHeaderBytes(protocolVersion)
  validateChannelCount(channels.length, protocolVersion)
  const batched = BATCHED_PROTOCOLS.includes(protocolVersion)
  const flow = createFileFlowControl({ initialWindow: batched ? DIRECT_ACK_WINDOW : ACK_WINDOW, clock, roundTripMs })
  // Giữ ngân sách gửi đã chạy ổn cho cả file, chia đều giữa các kênh.
  // Không giới hạn bốn khung suốt phiên vì làm giảm tốc độ duy trì.
  const sendBuffer = batched ? Math.floor(DIRECT_SEND_BUFFER / channels.length) : BUFFER_HIGH
  for (const channel of channels)
    channel.bufferedAmountLowThreshold = BUFFER_LOW
  const changes = new EventTarget()
  const readyChannels = new Set()
  let sent = 0
  let acknowledged = 0
  let waiting = null
  async function trackWait(kind, operation) {
    const started = clock()
    waiting = { kind, started }
    try { await operation() }
    finally {
      flow.waited(kind, clock() - started)
      waiting = null
    }
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

  async function sendBatch(offset, data) {
    const bytes = new Uint8Array(data)
    for (let start = 0; start < bytes.length; start += CHUNK_BYTES) {
      const position = offset + start
      const channel = channels[Math.floor(position / CHUNK_BYTES) % channels.length]
      const payload = bytes.subarray(start, start + CHUNK_BYTES)
      const length = payload.byteLength
      if (sent - acknowledged + length > flow.windowBytes) {
        await trackWait('ack', () => waitUntil(() => sent - acknowledged + length <= flow.windowBytes))
      }
      if (channel.bufferedAmount + length + header > sendBuffer) {
        await trackWait('buffer', () => waitForBuffer(channel, signal, length + header, sendBuffer))
      }
      signal.throwIfAborted()
      sent += length
      channel.send(encodeStreamChunk(position, payload, protocolVersion))
    }
  }

  return {
    handle(text, index = 0) {
      const frame = readStreamControl(text, transferId, index)
      if (frame.type === 'READY' && channels[index] && !readyChannels.has(index)) {
        if (batched && index === 0) flow.negotiate(frame.maxWindowBytes)
        readyChannels.add(index)
      }
      else if (frame.type === 'ACK' && index === 0 && readyChannels.size === channels.length && Number.isSafeInteger(frame.bytes) &&
          frame.bytes >= acknowledged && frame.bytes <= sent) {
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
        ackWaitMs: snapshot.ackWaitMs + (waiting?.kind === 'ack' ? clock() - waiting.started : 0),
        bufferWaitMs: snapshot.bufferWaitMs + (waiting?.kind === 'buffer' ? clock() - waiting.started : 0),
        inFlightBytes: sent - acknowledged,
        bufferedBytes: channels.reduce((total, channel) => total + (channel?.bufferedAmount || 0), 0) }
    },
    async send(file, begin, finalizeHash) {
      validateSize(file.size, protocolVersion)
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
      if (sent !== file.size) throw new Error('Đọc thiếu byte từ tệp gốc.')
      await Promise.all(channels.map(async (channel, index) => {
        await waitForBuffer(channel, signal, 256, sendBuffer)
        signal.throwIfAborted()
        channel.send(streamControl('END', transferId, undefined, index))
      }))
      await waitUntil(() => acknowledged === file.size)
    },
  }
}

// Kiểm tra ngay khi nhận để chặn peer gửi vượt cửa sổ trong lúc writer còn chậm.
export function createStreamReceiver({ size, signal, write, acknowledge, onProgress, protocolVersion = 'file-v2',
  channelCount = 1, maxWindowBytes = DIRECT_ACK_WINDOW }) {
  validateSize(size, protocolVersion)
  validateChannelCount(channelCount, protocolVersion)
  const batched = BATCHED_PROTOCOLS.includes(protocolVersion)
  const requiresChannelEnds = protocolVersion === MULTICHANNEL_PROTOCOL || protocolVersion === PARALLEL_CONNECTIONS_PROTOCOL
  if (batched && (!Number.isSafeInteger(maxWindowBytes) || maxWindowBytes < DIRECT_ACK_WINDOW || maxWindowBytes > MAX_FILE_WINDOW))
    throw new Error('Hạn mức cửa sổ nhận không hợp lệ.')
  const windowBytes = batched ? maxWindowBytes : ACK_WINDOW
  const ackBytes = batched ? DIRECT_WRITE_BYTES : ACK_INTERVAL
  const nextOffsets = Array.from({ length: channelCount }, (_, index) => index * CHUNK_BYTES)
  const endedChannels = new Set()
  const pending = new Map()
  let received = 0
  let written = 0
  let acknowledged = 0
  let ended = false
  let queue = Promise.resolve()
  let batch
  let buffered = 0
  let writeMs = null
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

  return {
    capabilities: batched ? { maxWindowBytes: windowBytes } : {},
    diagnostics() {
      return { maximumWindowBytes: windowBytes, queuedBytes: [...pending.values()].reduce((total, data) => total + data.byteLength, 0) + received - written,
        receiverWriteMs: writeMs }
    },
    push(frame, index = 0) {
      signal.throwIfAborted()
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
    end(index) {
      signal.throwIfAborted()
      if (ended || endedChannels.has(index) || nextOffsets[index] === undefined || nextOffsets[index] < size)
        throw new Error('Kênh chưa gửi đủ dữ liệu hoặc END lặp.')
      endedChannels.add(index)
      return endedChannels.size === channelCount
    },
    async finish() {
      if (ended || received !== size || (requiresChannelEnds && endedChannels.size !== channelCount))
        throw new Error('Tệp chưa nhận đủ byte hoặc END lặp.')
      ended = true
      await queue
      signal.throwIfAborted()
      return written
    },
  }
}

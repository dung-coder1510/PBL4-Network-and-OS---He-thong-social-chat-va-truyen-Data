import { sha256 } from '@noble/hashes/sha2.js'
import { CHUNK_BYTES, LEGACY_MAX_FILE_BYTES, MAX_FILE_BYTES, encodeChunk, waitForBuffer } from './fileProtocol.js'

export const ACK_WINDOW = 512 * 1024
export const ACK_INTERVAL = 64 * 1024

export function streamHeaderBytes(protocolVersion = 'file-v2') {
  if (protocolVersion === 'file-v2') return 4
  if (protocolVersion === 'file-v3') return 8
  throw new Error('Giao thức truyền file không hợp lệ.')
}

// v2 giữ nguyên offset uint32. v3 dùng uint64 để đi qua mốc 4 GiB.
export function encodeStreamChunk(offset, payload, protocolVersion = 'file-v2') {
  const header = streamHeaderBytes(protocolVersion)
  if (header === 4) return encodeChunk(offset, payload)
  if (!Number.isSafeInteger(offset) || offset < 0 || !(payload instanceof ArrayBuffer) ||
      payload.byteLength < 1 || payload.byteLength > CHUNK_BYTES || offset + payload.byteLength > MAX_FILE_BYTES)
    throw new Error('Chunk không hợp lệ.')
  const frame = new Uint8Array(header + payload.byteLength)
  new DataView(frame.buffer).setBigUint64(0, BigInt(offset))
  frame.set(new Uint8Array(payload), header)
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
  streamHeaderBytes(protocolVersion)
  const maximum = protocolVersion === 'file-v3' ? MAX_FILE_BYTES : LEGACY_MAX_FILE_BYTES
  if (!Number.isSafeInteger(size) || size < 0 || size > maximum)
    throw new Error('Kích thước tệp không hợp lệ cho giao thức đã chọn.')
}

// Đọc từng phần để băm file gốc và file tạm mà không nạp cả file vào RAM.
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

export function streamControl(type, transferId, bytes) {
  return JSON.stringify({ type, transferId, channel: 0, ...(bytes === undefined ? {} : { bytes }) })
}

export function readStreamControl(text, transferId) {
  if (typeof text !== 'string' || text.length > 256) throw new Error('Khung điều khiển không hợp lệ.')
  const frame = JSON.parse(text)
  if (!frame || frame.transferId !== transferId || frame.channel !== 0 ||
      !['READY', 'ACK', 'END'].includes(frame.type))
    throw new Error('Khung điều khiển sai phiên hoặc sai kênh.')
  return frame
}

// ACK chỉ mở thêm cửa sổ khi phía nhận đã ghi xong. Abort giải phóng mọi waiter.
export function createStreamSender({ channel, transferId, signal, onProgress, protocolVersion = 'file-v2' }) {
  const header = streamHeaderBytes(protocolVersion)
  const changes = new EventTarget()
  let ready = false
  let sent = 0
  let acknowledged = 0
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
  return {
    handle(text) {
      const frame = readStreamControl(text, transferId)
      if (frame.type === 'READY' && !ready) ready = true
      else if (frame.type === 'ACK' && ready && Number.isSafeInteger(frame.bytes) &&
          frame.bytes >= acknowledged && frame.bytes <= sent) {
        if (frame.bytes > acknowledged) {
          acknowledged = frame.bytes
          onProgress(acknowledged)
        }
      } else throw new Error('ACK hoặc READY không hợp lệ.')
      changes.dispatchEvent(new Event('change'))
    },
    async send(file, begin) {
      validateSize(file.size, protocolVersion)
      await waitUntil(() => ready)
      signal.throwIfAborted()
      await begin()
      for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
        const length = Math.min(CHUNK_BYTES, file.size - offset)
        await waitUntil(() => sent - acknowledged + length <= ACK_WINDOW)
        await waitForBuffer(channel, signal, length + header)
        // Một vòng gửi tuần tự giữ tối đa một khối đang đọc.
        const payload = await file.slice(offset, offset + length).arrayBuffer()
        signal.throwIfAborted()
        sent += payload.byteLength
        channel.send(encodeStreamChunk(offset, payload, protocolVersion))
      }
      await waitForBuffer(channel, signal, 256)
      signal.throwIfAborted()
      channel.send(streamControl('END', transferId))
      await waitUntil(() => acknowledged === file.size)
    },
  }
}

// Kiểm tra ngay khi nhận để chặn peer gửi vượt cửa sổ trong lúc writer còn chậm.
export function createStreamReceiver({ size, signal, write, acknowledge, onProgress, protocolVersion = 'file-v2' }) {
  validateSize(size, protocolVersion)
  let received = 0
  let written = 0
  let acknowledged = 0
  let ended = false
  let queue = Promise.resolve()
  return {
    push(frame) {
      signal.throwIfAborted()
      const { offset, payload } = readStreamChunk(frame, protocolVersion)
      if (ended || payload.byteLength !== Math.min(CHUNK_BYTES, size - received) ||
          offset !== received || received + payload.byteLength - acknowledged > ACK_WINDOW)
        throw new Error('Chunk sai vị trí, kích thước hoặc vượt cửa sổ ACK.')
      received += payload.byteLength
      queue = queue.then(async () => {
        signal.throwIfAborted()
        await write(offset, payload)
        signal.throwIfAborted()
        written += payload.byteLength
        onProgress(written)
        if (written - acknowledged >= ACK_INTERVAL || written === size) {
          acknowledge(written)
          acknowledged = written
        }
      })
      return queue
    },
    async finish() {
      if (ended || received !== size) throw new Error('Tệp chưa nhận đủ byte hoặc END lặp.')
      ended = true
      await queue
      signal.throwIfAborted()
      return written
    },
  }
}

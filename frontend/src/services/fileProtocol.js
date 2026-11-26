export const MAX_FILE_BYTES = 10 * 1024 ** 3
export const LEGACY_MAX_FILE_BYTES = 100 * 1024 ** 2
export const LARGE_FILE_WARNING_BYTES = 1024 ** 3
export const CHUNK_BYTES = 16 * 1024
export const BUFFER_HIGH = 256 * 1024
export const BUFFER_LOW = 64 * 1024
export const MAX_FILE_CHANNELS = 8
export const PARALLEL_CONNECTION_COUNT = 2
export const V7_CONNECTION_COUNTS = [1, 2, 4]
export const DEFERRED_HASH_PROTOCOL = 'file-v4'
export const MULTICHANNEL_PROTOCOL = 'file-v5'
export const PARALLEL_CONNECTIONS_PROTOCOL = 'file-v6'
export const HIGH_SPEED_PROTOCOL = 'file-v7'
export const V7_MAX_CHUNK_BYTES = 64 * 1024
export const V7_BLOCK_BYTES = 1024 * 1024
export const V7_SMALL_BLOCK_BYTES = 256 * 1024
export const V7_SEND_BUFFER_PER_CONNECTION = 512 * 1024
export const V7_INITIAL_FILE_WINDOW = 4 * 1024 * 1024
export const V7_MAX_FILE_WINDOW = 16 * 1024 * 1024
export const V7_MAX_OUT_OF_ORDER_BLOCKS = 16
export const v7BlockBytes = size => size > 2 * 1024 * 1024 ? V7_BLOCK_BYTES : V7_SMALL_BLOCK_BYTES
export const STREAM_PROTOCOLS = [
  'file-v2', 'file-v3', DEFERRED_HASH_PROTOCOL, MULTICHANNEL_PROTOCOL, PARALLEL_CONNECTIONS_PROTOCOL, HIGH_SPEED_PROTOCOL,
]

// coturn dùng chung cổng 3478 cho STUN. Khi cấu hình chỉ có turn: (UDP), suy ra stun:host:port
// để vẫn lấy được ứng viên srflx đục lỗ P2P mà không dùng relay hay credential.
function deriveStunUrlFromTurn(url) {
  if (typeof url !== 'string') return null
  const trimmed = url.trim()
  if (!/^turn:/i.test(trimmed)) return null
  const [hostPort, query = ''] = trimmed.slice(5).split('?')
  if (!hostPort || /(^|&)transport=tcp(&|$)/i.test(query)) return null
  return `stun:${hostPort}`
}

export function filterIceServers(iceServers, allowTurn = false) {
  if (allowTurn) return Array.isArray(iceServers) ? iceServers : []
  if (!Array.isArray(iceServers)) return []
  const filtered = []
  const derivedStun = new Set()
  for (const server of iceServers) {
    if (!server) continue
    const raw = server.urls ?? server.url
    const urls = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : [])
    for (const url of urls) {
      const stun = deriveStunUrlFromTurn(url)
      if (stun) derivedStun.add(stun)
    }
    const directUrls = urls.filter(url => typeof url === 'string' && !/^turns?:/i.test(url.trim()))
    if (directUrls.length === 0) continue
    filtered.push({ ...server, urls: Array.isArray(raw) ? directUrls : directUrls[0] })
  }
  if (filtered.length === 0 && derivedStun.size > 0) return [{ urls: [...derivedStun] }]
  return filtered
}

export async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}

export function encodeChunk(index, payload) {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff ||
      !(payload instanceof ArrayBuffer) || payload.byteLength < 1 || payload.byteLength > CHUNK_BYTES)
    throw new Error('Chunk không hợp lệ.')
  const frame = new Uint8Array(4 + payload.byteLength)
  new DataView(frame.buffer).setUint32(0, index)
  frame.set(new Uint8Array(payload), 4)
  return frame.buffer
}

export function createFileReceiver(expectedBytes) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > LEGACY_MAX_FILE_BYTES)
    throw new Error('Kích thước tệp không hợp lệ.')
  let parts = []
  let receivedBytes = 0
  let nextIndex = 0
  let ended = false
  return {
    push(frame) {
      if (ended || !(frame instanceof ArrayBuffer) || frame.byteLength <= 4 ||
          frame.byteLength > CHUNK_BYTES + 4 || new DataView(frame).getUint32(0) !== nextIndex ||
          receivedBytes + frame.byteLength - 4 > expectedBytes)
        throw new Error('Chunk sai thứ tự hoặc vượt kích thước đã khai báo.')
      parts.push(frame.slice(4))
      nextIndex++
      receivedBytes += frame.byteLength - 4
      return receivedBytes
    },
    finish() {
      if (ended || receivedBytes !== expectedBytes) throw new Error('Tệp chưa nhận đủ byte.')
      ended = true
      const blob = new Blob(parts, { type: 'application/octet-stream' })
      parts = []
      return blob
    },
    clear() { ended = true; parts = [] },
  }
}

export function waitForBuffer(channel, signal, nextBytes = 0, highWaterMark = BUFFER_HIGH) {
  if (signal.aborted) return Promise.reject(new DOMException('Đã hủy', 'AbortError'))
  if (channel.readyState !== 'open') return Promise.reject(new Error('Kênh truyền đã đóng.'))
  if (nextBytes > highWaterMark) return Promise.reject(new Error('Khung dữ liệu vượt giới hạn đệm gửi.'))
  if (channel.bufferedAmount + nextBytes <= highWaterMark) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Kênh truyền bị nghẽn quá 30 giây.')), 30000)
    const poll = setInterval(pollDrained, 50)
    function finish(error) {
      clearTimeout(timer)
      clearInterval(poll)
      channel.removeEventListener('bufferedamountlow', drained)
      channel.removeEventListener('close', closed)
      channel.removeEventListener('error', closed)
      signal.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve()
    }
    function drained() {
      if (channel.bufferedAmount + nextBytes <= highWaterMark) finish()
    }
    function pollDrained() {
      const lowLimit = Number.isFinite(channel.bufferedAmountLowThreshold) && channel.bufferedAmountLowThreshold > 0
        ? Math.min(highWaterMark - nextBytes, channel.bufferedAmountLowThreshold)
        : highWaterMark - nextBytes
      if (channel.bufferedAmount + nextBytes <= highWaterMark || channel.bufferedAmount <= lowLimit) finish()
    }
    const closed = () => finish(new Error('Kênh truyền đã đóng.'))
    const aborted = () => finish(new DOMException('Đã hủy', 'AbortError'))
    channel.addEventListener('bufferedamountlow', drained)
    channel.addEventListener('close', closed)
    channel.addEventListener('error', closed)
    signal.addEventListener('abort', aborted, { once: true })
    drained()
  })
}

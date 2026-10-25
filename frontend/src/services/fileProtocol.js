export const MAX_FILE_BYTES = 100 * 1024 * 1024
export const CHUNK_BYTES = 16 * 1024
export const BUFFER_HIGH = 256 * 1024
export const BUFFER_LOW = 64 * 1024

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
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > MAX_FILE_BYTES)
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

export function waitForBuffer(channel, signal) {
  if (signal.aborted) return Promise.reject(new DOMException('Đã hủy', 'AbortError'))
  if (channel.readyState !== 'open') return Promise.reject(new Error('Kênh truyền đã đóng.'))
  if (channel.bufferedAmount <= BUFFER_HIGH) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Kênh truyền bị nghẽn quá 30 giây.')), 30000)
    function finish(error) {
      clearTimeout(timer)
      channel.removeEventListener('bufferedamountlow', drained)
      channel.removeEventListener('close', closed)
      channel.removeEventListener('error', closed)
      signal.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve()
    }
    const drained = () => finish()
    const closed = () => finish(new Error('Kênh truyền đã đóng.'))
    const aborted = () => finish(new DOMException('Đã hủy', 'AbortError'))
    channel.addEventListener('bufferedamountlow', drained)
    channel.addEventListener('close', closed)
    channel.addEventListener('error', closed)
    signal.addEventListener('abort', aborted, { once: true })
    if (channel.bufferedAmount <= BUFFER_LOW) drained()
  })
}

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const READ_BYTES = 512 * 1024
const DIGEST_READ_BYTES = 1024 * 1024
let file
let hash
let offset = 0

// Mỗi yêu cầu đọc đúng một lô (WebRTC v4+), hoặc nhận { digestOnly: true, file } cho HTTPS Multi-Part.
self.onmessage = async ({ data: source }) => {
  try {
    if (source?.digestOnly) {
      const digest = sha256.create()
      try {
        const target = source.file
        for (let pos = 0; pos < target.size; pos += DIGEST_READ_BYTES) {
          const end = Math.min(pos + DIGEST_READ_BYTES, target.size)
          const chunk = await target.slice(pos, end).arrayBuffer()
          if (chunk.byteLength !== end - pos) throw new Error('Source file changed')
          digest.update(new Uint8Array(chunk))
        }
        self.postMessage({ sha256Hex: bytesToHex(digest.digest()) })
      } finally { digest.destroy() }
      return
    }
    if (source) {
      file = source
      hash = sha256.create()
      offset = 0
    }
    const end = Math.min(offset + READ_BYTES, file.size)
    const data = await file.slice(offset, end).arrayBuffer()
    if (data.byteLength !== end - offset) throw new Error('Source file changed')
    hash.update(new Uint8Array(data))
    const sha256Hex = end === file.size ? bytesToHex(hash.digest()) : null
    self.postMessage({ offset, data, sha256Hex }, [data])
    offset = end
  } catch {
    self.postMessage({ error: 'Không đọc được tệp gốc. Hãy chọn lại tệp.' })
  }
}

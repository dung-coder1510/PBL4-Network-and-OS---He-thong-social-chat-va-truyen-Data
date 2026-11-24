import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

let totalParts = 0
let nextIndex = 0
let hash = null
const pending = new Map()

function flush() {
  while (pending.has(nextIndex)) {
    const buffer = pending.get(nextIndex)
    pending.delete(nextIndex)
    hash.update(new Uint8Array(buffer))
    nextIndex++
  }
}

// Nhan cac manh theo thu tu ngau nhien qua Transferable va bam SHA-256 tuan tu tu manh 0..N-1.
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      hash?.destroy()
      hash = sha256.create()
      totalParts = data.totalParts
      nextIndex = 0
      pending.clear()
      return
    }
    if (data.type === 'part') {
      pending.set(data.partIndex, data.buffer)
      flush()
      return
    }
    if (data.type === 'digest') {
      flush()
      if (nextIndex !== totalParts || pending.size > 0)
        throw new Error('Chưa nhận đủ các mảnh để tính SHA-256.')
      const sha256Hex = bytesToHex(hash.digest())
      hash.destroy()
      hash = null
      self.postMessage({ type: 'digest', sha256Hex })
    }
  } catch (error) {
    self.postMessage({ type: 'error', error: error.message || 'Lỗi tính SHA-256.' })
  }
}

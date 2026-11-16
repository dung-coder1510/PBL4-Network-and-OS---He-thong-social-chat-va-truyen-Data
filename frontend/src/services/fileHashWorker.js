import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const READ_BYTES = 512 * 1024
let file
let hash
let offset = 0

// Mỗi yêu cầu đọc đúng một lô. Đọc và cập nhật hash trước khi chuyển quyền sở hữu buffer.
self.onmessage = async ({ data: source }) => {
  if (source) {
    file = source
    hash = sha256.create()
  }
  try {
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

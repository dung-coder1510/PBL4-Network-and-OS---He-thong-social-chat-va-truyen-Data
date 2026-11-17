import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { STREAM_PROTOCOLS } from './fileProtocol.js'

export const canSaveFile = transfer => (transfer?.transport === 'https' ||
  transfer?.supportedProtocols?.some(version => STREAM_PROTOCOLS.includes(version))) &&
  globalThis.isSecureContext && typeof globalThis.showSaveFilePicker === 'function' &&
  typeof globalThis.FileSystemFileHandle?.prototype.createWritable === 'function'

// Tên từ peer chỉ được dùng như tên file đơn, có thể lưu trên Windows.
function safeName(name) {
  // eslint-disable-next-line no-control-regex -- Tên file từ peer cần loại ký tự điều khiển.
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '')
  const dot = cleaned.lastIndexOf('.')
  const extension = dot > 0 ? cleaned.slice(dot) : ''
  const stem = cleaned.slice(0, cleaned.length - extension.length)
  const safeStem = stem && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(stem) ? stem : 'tep'
  return safeStem.slice(0, Math.max(1, 180 - extension.length)) + extension
}

function fileExtension(name) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

export async function pickFileDestination(fileName) {
  // Chỉ xin quyền cho file đích; không cần quyền truy cập cả thư mục.
  const extension = fileExtension(fileName)
  // API chỉ nhận một số dạng hậu tố. Đuôi khác vẫn được kiểm tra sau picker.
  const filteredType = /^\.[a-z0-9]{1,15}$/.test(extension) ? {
    types: [{ description: `Tệp ${extension}`, accept: { 'application/octet-stream': [extension] } }],
    excludeAcceptAllOption: true,
  } : {}
  const target = await globalThis.showSaveFilePicker({
    id: 'pbl4-receive', startIn: 'downloads', suggestedName: safeName(fileName), ...filteredType,
  })
  // suggestedName/types là gợi ý cho hộp lưu; handle đích vẫn phải đúng đuôi gốc.
  if (fileExtension(target.name) !== extension) {
    throw new Error(extension
      ? `Tên lưu phải giữ đuôi ${extension} của tệp gốc. Bấm nhận file để chọn lại.`
      : 'Tệp gốc không có đuôi mở rộng. Bấm nhận file và chọn lại tên không có đuôi.')
  }
  return target
}

// Chrome dùng vùng ghi tạm cạnh file đích và công bố dữ liệu khi close() thành công.
export async function createFileStorage(target, signal, expectedBytes) {
  signal.throwIfAborted()
  const writer = await target.createWritable({ mode: 'exclusive' })
  if (signal.aborted) {
    await writer.abort().catch(() => {})
    signal.throwIfAborted()
  }
  const hash = sha256.create()
  let written = 0
  let verified = false
  let closed = false
  let cleaning
  return {
    async write(position, data) {
      signal.throwIfAborted()
      if (verified || position !== written || written + data.byteLength > expectedBytes)
        throw new Error('Chunk sai vị trí hoặc vượt kích thước tệp.')
      await writer.write({ type: 'write', position, data })
      signal.throwIfAborted()
      hash.update(data)
      written += data.byteLength
    },
    verify(expectedHash) {
      signal.throwIfAborted()
      if (written !== expectedBytes) throw new Error('Chưa ghi đủ tệp.')
      const digest = bytesToHex(hash.digest())
      if (digest !== expectedHash) throw new Error('SHA-256 không khớp; tệp đã bị loại bỏ.')
      verified = true
      return digest
    },
    async commit() {
      signal.throwIfAborted()
      if (!verified) throw new Error('Tệp chưa xác minh SHA-256.')
      await writer.close()
      closed = true
      return target.name
    },
    dispose() {
      // Chỉ hủy stream do phiên mở. Handle đích có thể trỏ đến file của người dùng.
      hash.destroy()
      return closed ? Promise.resolve() : (cleaning ??= writer.abort().catch(() => {}))
    },
  }
}

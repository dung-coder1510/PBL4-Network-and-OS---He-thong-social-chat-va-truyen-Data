import { CHUNK_BYTES } from './fileProtocol.js'

export const canSaveFile = transfer => transfer?.supportedProtocols?.some(version => ['file-v2', 'file-v3'].includes(version)) &&
  globalThis.isSecureContext && typeof globalThis.showSaveFilePicker === 'function' &&
  typeof globalThis.navigator?.storage?.getDirectory === 'function' &&
  typeof globalThis.FileSystemFileHandle?.prototype.createWritable === 'function' &&
  !!globalThis.navigator?.locks

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

// Mỗi phiên có file tạm riêng và một writer. dispose chỉ dọn file do phiên tạo.
export async function createFileStorage(target, signal, expectedBytes = 0) {
  if (typeof navigator.storage.estimate === 'function') {
    const { quota, usage } = await navigator.storage.estimate()
    signal.throwIfAborted()
    if (Number.isFinite(quota) && Number.isFinite(usage) && expectedBytes > quota - usage)
      throw new Error('Trình duyệt không đủ chỗ lưu tạm tệp này. Hãy giải phóng dung lượng rồi thử lại.')
  }
  const root = await navigator.storage.getDirectory()
  const name = 'pbl4-' + crypto.randomUUID() + '.part'
  let writer
  let cleaning
  const temporary = await root.getFileHandle(name, { create: true })
  const dispose = () => cleaning ??= (async () => {
    if (writer) await writer.abort().catch(() => {})
    await root.removeEntry(name).catch(() => {})
  })()
  try {
    writer = await temporary.createWritable()
    signal.throwIfAborted()
  } catch (error) { await dispose(); throw error }
  return {
    write(position, data) {
      signal.throwIfAborted()
      return writer.write({ type: 'write', position, data })
    },
    async finish() {
      signal.throwIfAborted()
      await writer.close()
      writer = null
      signal.throwIfAborted()
      return temporary.getFile()
    },
    async save(file, onProgress, onSaved) {
      // Tuần tự hóa xuất file giữa các tab. Tên và quyền ghi do Save As quyết định.
      return navigator.locks.request('pbl4-file-export', { signal }, async () => {
        signal.throwIfAborted()
        const savedName = target.name
        let output
        try {
          output = await target.createWritable()
          for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
            signal.throwIfAborted()
            const chunk = await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer()
            signal.throwIfAborted()
            await output.write(chunk)
            onProgress(offset + chunk.byteLength)
          }
          signal.throwIfAborted()
          await output.close()
        } catch (error) {
          // abort giữ nguyên nội dung cũ. Không xóa target: đó có thể là file của người dùng.
          await output?.abort().catch(() => {})
          throw error
        }
        // close đã thành công thì giữ kết quả, kể cả khi SignalR vừa bị ngắt.
        onSaved(savedName)
        return savedName
      })
    },
    dispose,
  }
}

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

function createInlineOrderedHasher(totalParts) {
  const hash = sha256.create()
  const pending = new Map()
  let nextIndex = 0
  function flush() {
    while (pending.has(nextIndex)) {
      const data = pending.get(nextIndex)
      pending.delete(nextIndex)
      hash.update(data)
      nextIndex++
    }
  }
  return {
    push(partIndex, buffer) {
      pending.set(partIndex, new Uint8Array(buffer))
      flush()
    },
    async digest() {
      flush()
      if (nextIndex !== totalParts || pending.size > 0)
        throw new Error('Chưa nhận đủ các mảnh để tính SHA-256.')
      return bytesToHex(hash.digest())
    },
    dispose() {
      pending.clear()
      hash.destroy()
    },
  }
}

function createWorkerOrderedHasher(totalParts) {
  if (typeof globalThis.Worker !== 'function') return createInlineOrderedHasher(totalParts)
  const worker = new Worker(new URL('./fileReceiveHashWorker.js', import.meta.url), { type: 'module' })
  let pendingDigest = null
  let workerError = null
  worker.onmessage = ({ data }) => {
    if (data.type === 'digest') {
      pendingDigest?.resolve(data.sha256Hex)
      pendingDigest = null
    } else if (data.type === 'error') {
      const error = new Error(data.error || 'Lỗi tính SHA-256.')
      workerError ??= error
      pendingDigest?.reject(error)
      pendingDigest = null
    }
  }
  const failed = () => {
    const error = new Error('Luồng tính SHA-256 phía nhận bị gián đoạn.')
    workerError ??= error
    pendingDigest?.reject(error)
    pendingDigest = null
  }
  worker.onerror = failed
  worker.onmessageerror = failed
  worker.postMessage({ type: 'init', totalParts })
  return {
    push(partIndex, buffer) {
      if (workerError) throw workerError
      worker.postMessage({ type: 'part', partIndex, buffer }, [buffer])
    },
    digest() {
      if (workerError) return Promise.reject(workerError)
      return new Promise((resolve, reject) => {
        pendingDigest = { resolve, reject }
        worker.postMessage({ type: 'digest' })
      })
    },
    dispose() {
      pendingDigest = null
      worker.terminate()
    },
  }
}

export function createOrderedFileHasher(totalParts) {
  return createWorkerOrderedHasher(totalParts)
}

// Ghi cac manh theo vi tri random-offset va day buffer sang Worker bam SHA-256 tuan tu.
export async function createPartFileStorage(target, signal, expectedBytes, partBytes) {
  signal.throwIfAborted()
  const totalParts = expectedBytes === 0 ? 0 : Math.ceil(expectedBytes / partBytes)
  const writer = await target.createWritable({ mode: 'exclusive' })
  if (signal.aborted) {
    await writer.abort().catch(() => {})
    signal.throwIfAborted()
  }
  const MAX_COALESCED_WRITE_BYTES = 4 * 1024 * 1024
  const hasher = createWorkerOrderedHasher(totalParts)
  const receivedParts = new Set()
  const pendingWrites = []
  let written = 0
  let verified = false
  let closed = false
  let cleaning
  let flushing = false
  let flushPromise = Promise.resolve()
  let writeError = null

  async function runFlush() {
    while (pendingWrites.length > 0 && !writeError) {
      pendingWrites.sort((left, right) => left.position - right.position)
      const run = [pendingWrites.shift()]
      let runEnd = run[0].position + run[0].expectedLength
      let runLength = run[0].expectedLength
      while (pendingWrites.length > 0 &&
             pendingWrites[0].position === runEnd &&
             runLength + pendingWrites[0].expectedLength <= MAX_COALESCED_WRITE_BYTES) {
        const next = pendingWrites.shift()
        run.push(next)
        runEnd += next.expectedLength
        runLength += next.expectedLength
      }
      try {
        signal.throwIfAborted()
        let payload
        if (run.length === 1) {
          payload = run[0].view
        } else {
          payload = new Uint8Array(runLength)
          let offset = 0
          for (const item of run) {
            payload.set(item.view, offset)
            offset += item.expectedLength
          }
        }
        await writer.write({ type: 'write', position: run[0].position, data: payload })
        signal.throwIfAborted()
        for (const item of run) {
          hasher.push(item.partIndex, item.transferBuffer)
          written += item.expectedLength
          item.resolve(written)
        }
      } catch (error) {
        writeError ??= error
        for (const item of run) item.reject(error)
        while (pendingWrites.length > 0) pendingWrites.shift().reject(error)
      }
    }
  }

  function scheduleFlush() {
    if (flushing) return flushPromise
    flushing = true
    flushPromise = runFlush().finally(() => {
      flushing = false
      if (pendingWrites.length > 0 && !writeError) void scheduleFlush()
    })
    return flushPromise
  }

  return {
    writePart(partIndex, position, data) {
      signal.throwIfAborted()
      if (writeError) return Promise.reject(writeError)
      if (verified || !Number.isInteger(partIndex) || partIndex < 0 || partIndex >= totalParts)
        throw new Error('Chỉ số mảnh tệp không hợp lệ.')
      const expectedPosition = partIndex * partBytes
      const expectedLength = Math.min(partBytes, expectedBytes - expectedPosition)
      if (position !== expectedPosition || !data || data.byteLength !== expectedLength || receivedParts.has(partIndex))
        throw new Error('Mảnh tệp sai vị trí, trùng lặp hoặc sai kích thước.')
      receivedParts.add(partIndex)
      const view = data instanceof Uint8Array ? data : new Uint8Array(data)
      const transferBuffer = view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
        ? view.buffer : view.slice().buffer
      return new Promise((resolve, reject) => {
        pendingWrites.push({ partIndex, position, view, transferBuffer, expectedLength, resolve, reject })
        void scheduleFlush()
      })
    },
    async verify(expectedHash) {
      while (flushing || pendingWrites.length > 0) await flushPromise
      if (writeError) throw writeError
      signal.throwIfAborted()
      if (receivedParts.size !== totalParts || written !== expectedBytes)
        throw new Error('Chưa ghi đủ tệp.')
      const digest = await hasher.digest()
      signal.throwIfAborted()
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
      hasher.dispose()
      while (pendingWrites.length > 0) {
        pendingWrites.shift().reject(signal.reason instanceof Error ? signal.reason : new DOMException('Đã hủy', 'AbortError'))
      }
      return closed ? Promise.resolve() : (cleaning ??= writer.abort().catch(() => {}))
    },
  }
}

import { hashFile } from './fileStreamProtocol.js'
import { createOrderedFileHasher } from './fileStorage.js'

export const RELAY_PART_BYTES = 4 * 1024 * 1024
export const DEFAULT_MULTIPART_CONNECTIONS = 4
export const RELAY_RETRY_LIMIT = 5

export async function sha256ArrayBuffer(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function hashFileInBackground(file, signal) {
  signal?.throwIfAborted()
  if (typeof globalThis.Worker !== 'function') return hashFile(file, signal)
  const worker = new Worker(new URL('./fileHashWorker.js', import.meta.url), { type: 'module' })
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
    }
    const onAbort = () => {
      cleanup()
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Đã hủy', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = ({ data }) => {
      cleanup()
      if (data.error) reject(new Error(data.error))
      else resolve(data.sha256Hex)
    }
    const fail = () => {
      cleanup()
      reject(new Error('Không đọc được tệp gốc trong luồng tính SHA-256.'))
    }
    worker.onerror = fail
    worker.onmessageerror = fail
    worker.postMessage({ digestOnly: true, file })
  })
}

function isRetryableRelayError(error) {
  if (!error || error.name === 'AbortError') return false
  if (error.partHashMismatch) return true
  if (Number.isInteger(error.status))
    return error.status === 408 || error.status === 429 || error.status >= 500
  return true
}

function waitAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Đã hủy', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Đã hủy', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function withRelayRetry(operation, signal, maxAttempts = RELAY_RETRY_LIMIT, baseDelayMs = 250) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    signal?.throwIfAborted()
    try {
      return await operation(attempt)
    } catch (error) {
      if (signal?.aborted || !isRetryableRelayError(error) || attempt === maxAttempts - 1) throw error
      await waitAbortable(Math.min(4000, baseDelayMs * 2 ** attempt), signal)
    }
  }
}

export async function uploadMultipartRelay({ file, partBytes = RELAY_PART_BYTES,
  connectionCount = DEFAULT_MULTIPART_CONNECTIONS, precomputedSha256Hex = null,
  signal, putPart, finalizeHash, onProgress = () => {} }) {
  signal?.throwIfAborted()
  const totalParts = file.size === 0 ? 0 : Math.ceil(file.size / partBytes)
  const hasher = precomputedSha256Hex === null ? createOrderedFileHasher(totalParts) : null
  try {
    let nextPart = 0
    let uploadedBytes = 0
    const workerCount = totalParts === 0 ? 0 : Math.min(connectionCount, totalParts)
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        signal?.throwIfAborted()
        const partIndex = nextPart++
        if (partIndex >= totalParts) break
        const offset = partIndex * partBytes
        const end = Math.min(file.size, offset + partBytes)
        const uploadedBuffer = await withRelayRetry(async () => {
          const buffer = await file.slice(offset, end).arrayBuffer()
          signal?.throwIfAborted()
          const partSha256 = await sha256ArrayBuffer(buffer)
          await putPart(partIndex, buffer, partSha256)
          return buffer
        }, signal)
        hasher?.push(partIndex, uploadedBuffer)
        uploadedBytes += end - offset
        onProgress(uploadedBytes)
      }
    })

    await Promise.all(workers)
    const fullSha256 = precomputedSha256Hex !== null ? precomputedSha256Hex : await hasher.digest()
    if (precomputedSha256Hex === null && finalizeHash)
      await withRelayRetry(() => finalizeHash(fullSha256), signal)
    return fullSha256
  } finally {
    hasher?.dispose()
  }
}

export async function downloadMultipartRelay({ fileSizeBytes, partBytes = RELAY_PART_BYTES,
  connectionCount = DEFAULT_MULTIPART_CONNECTIONS, disk, signal, getPart, ackParts,
  fetchHash, onProgress = () => {} }) {
  signal?.throwIfAborted()
  const totalParts = fileSizeBytes === 0 ? 0 : Math.ceil(fileSizeBytes / partBytes)
  let nextPart = 0
  let downloadedBytes = 0
  const partialBytes = new Map()
  const totalDownloaded = () => {
    let extra = 0
    for (const bytes of partialBytes.values()) extra += bytes
    return Math.min(fileSizeBytes, downloadedBytes + extra)
  }
  const finalAcks = []
  const workerCount = totalParts === 0 ? 0 : Math.min(connectionCount, totalParts)

  const workers = Array.from({ length: workerCount }, async (_, workerId) => {
    let pendingAck = null
    let previousWrite = Promise.resolve()
    try {
      for (;;) {
        signal?.throwIfAborted()
        const partIndex = nextPart++
        if (partIndex >= totalParts) break
        const position = partIndex * partBytes
        const expectedLength = Math.min(partBytes, fileSizeBytes - position)
        const ackForRequest = pendingAck
        const buffer = await withRelayRetry(async () => {
          partialBytes.set(workerId, 0)
          onProgress(totalDownloaded())
          const { buffer: payload, sha256Hex } = await getPart(partIndex, ackForRequest, delta => {
            partialBytes.set(workerId, (partialBytes.get(workerId) || 0) + delta)
            onProgress(totalDownloaded())
          })
          signal?.throwIfAborted()
          if (!payload || payload.byteLength !== expectedLength) {
            throw Object.assign(new Error('Mảnh tệp tải về thiếu dữ liệu.'), { partHashMismatch: true })
          }
          if (!sha256Hex || await sha256ArrayBuffer(payload) !== sha256Hex.toLowerCase()) {
            throw Object.assign(new Error('SHA-256 của mảnh tệp không khớp.'), { partHashMismatch: true })
          }
          return payload
        }, signal)
        partialBytes.set(workerId, 0)
        downloadedBytes += expectedLength
        onProgress(totalDownloaded())
        await previousWrite
        previousWrite = disk.writePart(partIndex, position, buffer)
        void previousWrite.catch(() => {})
        pendingAck = partIndex
      }
      await previousWrite
      if (pendingAck !== null) finalAcks.push(pendingAck)
    } finally {
      partialBytes.delete(workerId)
    }
  })

  await Promise.all(workers)
  let expectedSha256Hex = null
  if (finalAcks.length > 0) {
    const ackResult = await withRelayRetry(() => ackParts(finalAcks), signal)
    expectedSha256Hex = ackResult?.sha256Hex || null
  }
  if (!expectedSha256Hex) {
    const hashResult = await withRelayRetry(() => fetchHash(), signal)
    expectedSha256Hex = hashResult?.sha256Hex || null
  }
  return { receivedBytes: fileSizeBytes, expectedSha256Hex }
}

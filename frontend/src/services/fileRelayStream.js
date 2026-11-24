export const RELAY_WRITE_BATCH_BYTES = 1024 * 1024
export const MAX_QUEUED_RELAY_WRITES = 2

// Gom cac chunk HTTP thanh lo 1 MiB va giu hang doi toi da 2 lo de doc mang song song ghi dia.
export async function streamResponseToDisk(response, disk, signal, onProgress = () => {}) {
  signal?.throwIfAborted()
  const reader = response.body.getReader()
  let writePosition = 0
  let writtenBytes = 0
  let pendingCount = 0
  let writeError = null
  let queue = Promise.resolve()
  let spaceAvailable = null
  let batch = null
  let buffered = 0

  const abortError = () => (signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Phiên truyền đã dừng.', 'AbortError'))

  function wakeWaiter() {
    const wake = spaceAvailable
    spaceAvailable = null
    wake?.()
  }

  function onAbort() {
    wakeWaiter()
    void reader.cancel(abortError()).catch(() => {})
  }

  signal?.addEventListener('abort', onAbort, { once: true })

  async function enqueueWrite(data) {
    if (pendingCount >= MAX_QUEUED_RELAY_WRITES && !writeError && !signal?.aborted) {
      await new Promise(resolve => { spaceAvailable = resolve })
    }
    if (writeError) throw writeError
    signal?.throwIfAborted()
    const position = writePosition
    writePosition += data.byteLength
    pendingCount++
    queue = queue.then(async () => {
      signal?.throwIfAborted()
      await disk.write(position, data)
      signal?.throwIfAborted()
      writtenBytes += data.byteLength
      onProgress(writtenBytes)
    }).catch(error => {
      writeError ??= error
      wakeWaiter()
      void reader.cancel(error).catch(() => {})
    }).finally(() => {
      pendingCount--
      wakeWaiter()
    })
  }

  try {
    for (;;) {
      if (writeError) throw writeError
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (writeError) throw writeError
      signal?.throwIfAborted()
      if (done) break
      if (!value?.byteLength) continue

      let offset = 0
      while (offset < value.byteLength) {
        if (buffered === 0 && value.byteLength - offset >= RELAY_WRITE_BATCH_BYTES) {
          const end = offset + RELAY_WRITE_BATCH_BYTES
          const slice = offset === 0 && value.byteLength === RELAY_WRITE_BATCH_BYTES
            ? value : value.subarray(offset, end)
          await enqueueWrite(slice)
          offset = end
          continue
        }
        batch ??= new Uint8Array(RELAY_WRITE_BATCH_BYTES)
        const take = Math.min(RELAY_WRITE_BATCH_BYTES - buffered, value.byteLength - offset)
        batch.set(value.subarray(offset, offset + take), buffered)
        buffered += take
        offset += take
        if (buffered === RELAY_WRITE_BATCH_BYTES) {
          const ready = batch
          batch = null
          buffered = 0
          await enqueueWrite(ready)
        }
      }
    }

    if (buffered > 0) {
      const remainder = batch.slice(0, buffered)
      batch = null
      buffered = 0
      await enqueueWrite(remainder)
    }

    await queue
    if (writeError) throw writeError
    signal?.throwIfAborted()
    return writtenBytes
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    await queue
    if (signal?.aborted) signal.throwIfAborted()
    throw writeError ?? error
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

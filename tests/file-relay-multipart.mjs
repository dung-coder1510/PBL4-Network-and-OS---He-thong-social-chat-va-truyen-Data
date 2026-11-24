import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import { createPartFileStorage } from '../frontend/src/services/fileStorage.js'
import { downloadMultipartRelay, uploadMultipartRelay } from '../frontend/src/services/fileRelayMultipart.js'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function createMemoryTarget(name) {
  let chunks = []
  let aborted = false
  let closed = false
  return {
    name,
    get bytes() { return Buffer.concat(chunks) },
    get aborted() { return aborted },
    get closed() { return closed },
    async createWritable() {
      const staged = new Map()
      return {
        async write({ position, data }) {
          staged.set(position, Buffer.from(data))
        },
        async close() {
          const total = [...staged.entries()].reduce((max, [pos, buf]) => Math.max(max, pos + buf.length), 0)
          const out = Buffer.alloc(total)
          for (const [pos, buf] of staged) buf.copy(out, pos)
          chunks = [out]
          closed = true
        },
        async abort() {
          aborted = true
          staged.clear()
        },
      }
    },
  }
}

test('uploadMultipartRelay + downloadMultipartRelay + createPartFileStorage support 0 B, 1 B and out-of-order multi-part with retries', async () => {
  const partBytes = 256 * 1024
  for (const size of [0, 1, 199_999, 1_310_737]) {
    const payload = randomBytes(size)
    const expectedHash = digest(payload)
    const storedParts = new Map()
    const ackedParts = new Set()
    let finalizedHash = null
    let failedPutOnce = false
    let failedGetOnce = false
    let corruptedPartHashOnce = false

    const target = createMemoryTarget(`part-${size}.bin`)
    const abort = new AbortController()
    const disk = await createPartFileStorage(target, abort.signal, size, partBytes)
    const file = new Blob([payload])

    const uploadPromise = uploadMultipartRelay({
      file,
      partBytes,
      connectionCount: 4,
      signal: abort.signal,
      async putPart(partIndex, buffer, partSha256) {
        if (size > partBytes && partIndex === 1 && !failedPutOnce) {
          failedPutOnce = true
          throw Object.assign(new Error('Transient 503'), { status: 503 })
        }
        storedParts.set(partIndex, { buffer: Buffer.from(buffer), sha256: partSha256 })
      },
      async finalizeHash(sha) {
        finalizedHash = sha
      },
    })

    const { receivedBytes, expectedSha256Hex } = await downloadMultipartRelay({
      fileSizeBytes: size,
      partBytes,
      connectionCount: 4,
      disk,
      signal: abort.signal,
      async getPart(partIndex, ack) {
        if (ack !== null) ackedParts.add(ack)
        // Wait briefly for uploader if out-of-order / retry
        while (!storedParts.has(partIndex)) await new Promise(r => setTimeout(r, 5))
        if (size > partBytes && partIndex === 0 && !failedGetOnce) {
          failedGetOnce = true
          throw new TypeError('Simulated network drop')
        }
        if (size > partBytes && partIndex === 2 && !corruptedPartHashOnce) {
          corruptedPartHashOnce = true
          return { buffer: Uint8Array.from(storedParts.get(partIndex).buffer).buffer, sha256Hex: '00'.repeat(32) }
        }
        const entry = storedParts.get(partIndex)
        return { buffer: Uint8Array.from(entry.buffer).buffer, sha256Hex: entry.sha256 }
      },
      async ackParts(indices) {
        for (const idx of indices) ackedParts.add(idx)
        await uploadPromise
        return { sha256Hex: finalizedHash }
      },
      async fetchHash() {
        await uploadPromise
        return { sha256Hex: finalizedHash }
      },
    })

    await uploadPromise
    assert.equal(receivedBytes, size)
    assert.equal(expectedSha256Hex, expectedHash)
    assert.equal(await disk.verify(expectedSha256Hex), expectedHash)
    await disk.commit()
    assert.equal(target.closed, true)
    assert.deepEqual(target.bytes, payload)
    const totalParts = size === 0 ? 0 : Math.ceil(size / partBytes)
    assert.equal(ackedParts.size, totalParts)
  }
})

test('uploadMultipartRelay fails immediately on 403 and cancels cleanly on abort', async () => {
  let attempts = 0
  await assert.rejects(
    uploadMultipartRelay({
      file: new Blob([randomBytes(1024)]),
      partBytes: 65_536,
      connectionCount: 4,
      signal: new AbortController().signal,
      async putPart() {
        attempts++
        throw Object.assign(new Error('Forbidden'), { status: 403 })
      },
      async finalizeHash() {},
    }),
    /Forbidden/,
  )
  assert.equal(attempts, 1)

  const abort = new AbortController()
  const running = uploadMultipartRelay({
    file: new Blob([randomBytes(128_000)]),
    partBytes: 65_536,
    connectionCount: 2,
    signal: abort.signal,
    async putPart() {
      await new Promise(resolve => setTimeout(resolve, 200))
    },
    async finalizeHash() {},
  })
  abort.abort()
  await assert.rejects(running, { name: 'AbortError' })
})

test('createPartFileStorage preserves written byte count when Transferable Worker detaches part buffers', async () => {
  const hadWorker = Object.hasOwn(globalThis, 'Worker')
  const originalWorker = globalThis.Worker
  globalThis.Worker = class TransferMockWorker {
    #hash = null
    #pending = new Map()
    #nextIndex = 0
    #totalParts = 0

    postMessage(message, transfer = []) {
      const cloned = structuredClone(message, { transfer })
      if (cloned.type === 'init') {
        this.#hash = createHash('sha256')
        this.#pending.clear()
        this.#nextIndex = 0
        this.#totalParts = cloned.totalParts
        return
      }
      if (cloned.type === 'part') {
        this.#pending.set(cloned.partIndex, Buffer.from(cloned.buffer))
        while (this.#pending.has(this.#nextIndex)) {
          this.#hash.update(this.#pending.get(this.#nextIndex))
          this.#pending.delete(this.#nextIndex)
          this.#nextIndex++
        }
        return
      }
      if (cloned.type === 'digest') {
        assert.equal(this.#nextIndex, this.#totalParts)
        const sha256Hex = this.#hash.digest('hex')
        queueMicrotask(() => this.onmessage?.({ data: { type: 'digest', sha256Hex } }))
      }
    }

    terminate() {}
  }

  try {
    const partBytes = 1024
    const payload = randomBytes(partBytes * 2 + 137)
    const expectedHash = digest(payload)
    const target = createMemoryTarget('worker-transfer.bin')
    const disk = await createPartFileStorage(target, new AbortController().signal, payload.length, partBytes)

    const slice0 = Uint8Array.from(payload.subarray(0, partBytes))
    const slice1 = Uint8Array.from(payload.subarray(partBytes, partBytes * 2))
    const slice2 = Uint8Array.from(payload.subarray(partBytes * 2))

    assert.equal(await disk.writePart(2, partBytes * 2, slice2), 137)
    assert.equal(slice2.byteLength, 0)
    assert.equal(await disk.writePart(0, 0, slice0), 137 + partBytes)
    assert.equal(slice0.byteLength, 0)
    assert.equal(await disk.writePart(1, partBytes, slice1), payload.length)
    assert.equal(slice1.byteLength, 0)

    assert.equal(await disk.verify(expectedHash), expectedHash)
    await disk.commit()
    assert.equal(target.closed, true)
    assert.deepEqual(target.bytes, payload)
  } finally {
    if (hadWorker) globalThis.Worker = originalWorker
    else delete globalThis.Worker
  }
})

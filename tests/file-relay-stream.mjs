import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import { setImmediate as tick } from 'node:timers/promises'
import {
  MAX_QUEUED_RELAY_WRITES, RELAY_WRITE_BATCH_BYTES, streamResponseToDisk,
} from '../frontend/src/services/fileRelayStream.js'

function responseFromChunks(chunks) {
  return new Response(new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        await tick()
        controller.enqueue(chunk)
      }
      controller.close()
    },
  }))
}

test('streamResponseToDisk handles empty, 1-byte, sub-batch, exact-1-MiB and multi-MB streams', async () => {
  for (const [label, chunks] of [
    ['empty', []],
    ['1 byte', [Uint8Array.of(99)]],
    ['sub-batch coalescing', [randomBytes(100_000), randomBytes(250_000), randomBytes(150_000)]],
    ['exact 1 MiB', [randomBytes(400_000), randomBytes(RELAY_WRITE_BATCH_BYTES - 400_000)]],
    ['oversized + uneven 3.5 MiB', [randomBytes(2_500_000), randomBytes(300_000), randomBytes(870_016)]],
  ]) {
    const expected = Buffer.concat(chunks)
    const output = Buffer.alloc(expected.length)
    const writes = []
    const progress = []
    const total = await streamResponseToDisk(
      responseFromChunks(chunks),
      {
        async write(position, data) {
          writes.push([position, data.byteLength])
          output.set(data, position)
        },
      },
      new AbortController().signal,
      bytes => progress.push(bytes),
    )
    assert.equal(total, expected.length, label)
    assert.equal(createHash('sha256').update(output).digest('hex'),
      createHash('sha256').update(expected).digest('hex'), label)
    if (expected.length > 0 && expected.length <= RELAY_WRITE_BATCH_BYTES)
      assert.equal(writes.length, 1, `${label} should coalesce into one write`)
    if (progress.length > 0) assert.equal(progress.at(-1), expected.length, label)
  }
})

test('streamResponseToDisk pipelines ahead up to MAX_QUEUED_RELAY_WRITES without draining unbounded stream', async () => {
  const totalChunks = 24
  const payload = randomBytes(totalChunks * 262_144)
  const output = Buffer.alloc(payload.length)
  let chunksPulled = 0
  let activeWrites = 0
  let maxActiveWrites = 0
  let releaseWrite = null
  const stream = new ReadableStream({
    pull(controller) {
      if (chunksPulled >= totalChunks) { controller.close(); return }
      const start = chunksPulled * 262_144
      chunksPulled++
      controller.enqueue(payload.subarray(start, start + 262_144))
    },
  }, { highWaterMark: 1 })
  const disk = {
    async write(position, data) {
      activeWrites++
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
      await new Promise(resolve => { releaseWrite = resolve })
      output.set(data, position)
      activeWrites--
    },
  }
  const done = streamResponseToDisk(new Response(stream), disk, new AbortController().signal)
  for (let i = 0; i < 40; i++) await tick()
  assert.equal(activeWrites, 1)
  assert.equal(maxActiveWrites, 1)
  // Batch 1 dang ghi (4 chunk), Batch 2 da xep hang doi (4 chunk) -> it nhat 8 chunk da duoc doc truoc.
  assert.ok(chunksPulled >= MAX_QUEUED_RELAY_WRITES * 4, `Expected pipelined reads, got ${chunksPulled}`)
  // Khi hang doi dat tran 2 lo, stream khong duoc hut het 24 chunk (6 MiB) vao RAM.
  const pulledWhileBlocked = chunksPulled
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(chunksPulled, pulledWhileBlocked)
  assert.ok(chunksPulled < totalChunks, `Expected bounded reads < ${totalChunks}, got ${chunksPulled}`)

  while (releaseWrite) {
    const release = releaseWrite
    releaseWrite = null
    release()
    for (let i = 0; i < 15; i++) await tick()
  }
  const written = await done
  assert.equal(written, payload.length)
  assert.deepEqual(output, payload)
})

test('streamResponseToDisk cancels reader cleanly on abort and propagates write errors without unhandled rejections', async () => {
  const abort = new AbortController()
  let cancelled = false
  const stalledStream = new ReadableStream({
    start(controller) { controller.enqueue(randomBytes(RELAY_WRITE_BATCH_BYTES)) },
    cancel() { cancelled = true },
  })
  let releaseDisk
  const pendingAbort = streamResponseToDisk(
    new Response(stalledStream),
    { write: () => new Promise(resolve => { releaseDisk = resolve }) },
    abort.signal,
  )
  for (let i = 0; i < 10; i++) await tick()
  abort.abort()
  releaseDisk()
  await assert.rejects(pendingAbort, { name: 'AbortError' })
  assert.equal(cancelled, true)

  let failedReaderCancelled = false
  const failingStream = new ReadableStream({
    pull(controller) { controller.enqueue(randomBytes(RELAY_WRITE_BATCH_BYTES)) },
    cancel() { failedReaderCancelled = true },
  })
  await assert.rejects(
    streamResponseToDisk(
      new Response(failingStream),
      { async write() { throw new Error('Disk full') } },
      new AbortController().signal,
    ),
    /Disk full/,
  )
  assert.equal(failedReaderCancelled, true)
})

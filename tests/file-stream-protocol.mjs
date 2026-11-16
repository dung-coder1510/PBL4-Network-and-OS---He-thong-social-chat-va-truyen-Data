import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import { setImmediate as tick } from 'node:timers/promises'
import { ACK_WINDOW, createStreamReceiver, createStreamSender, hashFile, streamControl } from '../frontend/src/services/fileStreamProtocol.js'
import { CHUNK_BYTES, encodeChunk } from '../frontend/src/services/fileProtocol.js'
import { localFileStatus } from '../frontend/src/services/fileTransferState.js'

test('incremental hash matches Node for empty, chunk boundaries and a multi-megabyte file', async () => {
  for (const size of [0, CHUNK_BYTES, CHUNK_BYTES + 1, 3 * 1024 * 1024 + 7]) {
    const bytes = randomBytes(size)
    const blob = new Blob([bytes])
    blob.arrayBuffer = () => { throw new Error('Whole file read is forbidden') }
    assert.equal(await hashFile(blob, new AbortController().signal),
      createHash('sha256').update(bytes).digest('hex'))
  }
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(hashFile(new Blob(), aborted.signal), { name: 'AbortError' })
})

test('single-channel transfer waits for READY and written ACKs, with bounded slow-writer queue', async () => {
  const abort = new AbortController()
  const bytes = randomBytes(ACK_WINDOW * 3 + 17)
  const output = Buffer.alloc(bytes.length)
  let writesAllowed
  const gate = new Promise(resolve => { writesAllowed = resolve })
  let queued = 0
  let written = 0
  let peak = 0
  let began = false
  let end
  const errors = []
  const sender = createStreamSender({
    transferId: '42', signal: abort.signal, onProgress: count => assert.ok(count <= written),
    channel: {
      readyState: 'open', bufferedAmount: 0,
      send(frame) {
        if (typeof frame === 'string') { end = receiver.finish(); return }
        queued += frame.byteLength - 4
        peak = Math.max(peak, queued)
        receiver.push(frame).catch(error => errors.push(error))
      },
    },
  })
  const receiver = createStreamReceiver({
    size: bytes.length, signal: abort.signal,
    async write(offset, payload) {
      await gate
      await tick()
      output.set(payload, offset)
      written += payload.byteLength
      queued -= payload.byteLength
    },
    acknowledge: count => sender.handle(streamControl('ACK', '42', count)),
    onProgress() {},
  })
  const sending = sender.send(new Blob([bytes]), async () => { began = true })
  await tick()
  assert.equal(began, false)
  sender.handle(streamControl('READY', '42'))
  // Chờ sender lấp đầy cửa sổ nhưng writer chưa được phép ghi.
  for (let index = 0; index < 100 && queued < ACK_WINDOW; index++) await tick()
  assert.equal(queued, ACK_WINDOW)
  assert.equal(written, 0)
  writesAllowed()
  await sending
  assert.equal(await end, bytes.length)
  assert.equal(peak, ACK_WINDOW)
  assert.deepEqual(output, bytes)
  assert.deepEqual(errors, [])
})

test('receiver rejects out-of-order, short, duplicated, overflowing frames and early END', async () => {
  const options = { size: CHUNK_BYTES * 40, signal: new AbortController().signal,
    write: () => new Promise(() => {}), acknowledge() {}, onProgress() {} }
  const receiver = createStreamReceiver(options)
  assert.throws(() => receiver.push(encodeChunk(1, new ArrayBuffer(CHUNK_BYTES))))
  assert.throws(() => receiver.push(encodeChunk(0, new ArrayBuffer(1))))
  receiver.push(encodeChunk(0, new ArrayBuffer(CHUNK_BYTES)))
  assert.throws(() => receiver.push(encodeChunk(0, new ArrayBuffer(CHUNK_BYTES))))
  for (let offset = CHUNK_BYTES; offset < ACK_WINDOW; offset += CHUNK_BYTES)
    receiver.push(encodeChunk(offset, new ArrayBuffer(CHUNK_BYTES)))
  assert.throws(() => receiver.push(encodeChunk(ACK_WINDOW, new ArrayBuffer(CHUNK_BYTES))))
  await assert.rejects(receiver.finish())
})

test('empty file completes with READY/END and ACK validation rejects wrong peer and inflated bytes', async () => {
  const sent = []
  const abort = new AbortController()
  const sender = createStreamSender({ transferId: '1', signal: abort.signal, onProgress() {},
    channel: { readyState: 'open', bufferedAmount: 0, send: frame => sent.push(frame) } })
  assert.throws(() => sender.handle(streamControl('READY', '2')))
  assert.throws(() => sender.handle(streamControl('ACK', '1', 0)))
  sender.handle(streamControl('READY', '1'))
  assert.throws(() => sender.handle(streamControl('READY', '1')))
  assert.throws(() => sender.handle(streamControl('ACK', '1', 1)))
  await sender.send(new Blob(), async () => {})
  assert.deepEqual(sent, [streamControl('END', '1')])
  const receiver = createStreamReceiver({ size: 0, signal: abort.signal,
    write() { throw new Error('No data expected') }, acknowledge() {}, onProgress() {} })
  assert.equal(await receiver.finish(), 0)
  await assert.rejects(receiver.finish())
})

test('cancel releases sender waiting for READY and receiver propagates disk errors', async () => {
  const abort = new AbortController()
  const sender = createStreamSender({ transferId: '1', signal: abort.signal, onProgress() {},
    channel: { readyState: 'open', bufferedAmount: 0 } })
  const sending = sender.send(new Blob([new Uint8Array(1)]), async () => {})
  abort.abort()
  await assert.rejects(sending, { name: 'AbortError' })
  const receiver = createStreamReceiver({ size: 1, signal: new AbortController().signal,
    async write() { throw new Error('Disk full') }, acknowledge() { assert.fail('ACK before write') }, onProgress() {} })
  await assert.rejects(receiver.push(encodeChunk(0, new ArrayBuffer(1))), /Disk full/)
  await assert.rejects(receiver.finish(), /Disk full/)
})

test('saved file stays saved when server confirmation is lost, and failure beats verifying state', () => {
  assert.match(localFileStatus({ savedLocally: true, localFailure: true, status: 'failed' }), /Đã lưu.*chưa xác nhận/)
  assert.equal(localFileStatus({ savedLocally: true, status: 'completed' }), 'Đã lưu trên máy')
  assert.equal(localFileStatus({ localFailure: true, error: 'Disk full', localPhase: 'verifying' }), 'Disk full')
})

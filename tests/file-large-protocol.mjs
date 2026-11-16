import assert from 'node:assert/strict'
import test from 'node:test'
import * as protocol from '../frontend/src/services/fileStreamProtocol.js'
import * as limits from '../frontend/src/services/fileProtocol.js'
import { setImmediate as tick } from 'node:timers/promises'
import { createFileTransfers } from '../frontend/src/services/fileTransfers.js'

test('large file limit is 10 GiB while buffered legacy receiving stays capped at 100 MiB', () => {
  assert.equal(limits.MAX_FILE_BYTES, 10 * 1024 ** 3)
  assert.equal(limits.LARGE_FILE_WARNING_BYTES, 1024 ** 3)
  assert.throws(() => limits.createFileReceiver(100 * 1024 ** 2 + 1))
})

test('v3 frames preserve offsets around 4 GiB and at the end of 10 GiB', () => {
  const payload = Uint8Array.of(7, 8, 9).buffer
  for (const offset of [0, 2 ** 32 - 1, 2 ** 32, 2 ** 32 + 1, 10 * 1024 ** 3 - 3]) {
    const frame = protocol.encodeStreamChunk(offset, payload, 'file-v3')
    assert.equal(frame.byteLength, 11)
    assert.equal(new DataView(frame).getBigUint64(0), BigInt(offset))
    const decoded = protocol.readStreamChunk(frame, 'file-v3')
    assert.equal(decoded.offset, offset)
    assert.deepEqual(decoded.payload, new Uint8Array(payload))
  }
})

test('v3 rejects malformed or out-of-range offsets and v2 retains its original wire format', () => {
  const payload = Uint8Array.of(1).buffer
  for (const offset of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER, 10 * 1024 ** 3])
    assert.throws(() => protocol.encodeStreamChunk(offset, payload, 'file-v3'))
  const bad = new ArrayBuffer(9)
  new DataView(bad).setBigUint64(0, 2n ** 63n)
  assert.throws(() => protocol.readStreamChunk(bad, 'file-v3'))
  assert.throws(() => protocol.readStreamChunk(new ArrayBuffer(8), 'file-v3'))
  assert.throws(() => protocol.readStreamChunk(new ArrayBuffer(16393), 'file-v3'))
  const legacy = protocol.encodeStreamChunk(16384, payload, 'file-v2')
  assert.deepEqual([...new Uint8Array(legacy)], [0, 0, 64, 0, 1])
})

test('v3 streams a virtual 10 GiB file through sender and receiver with bounded queued bytes', async () => {
  // Không tạo file 10 GiB trên ổ người dùng: sinh từng khối, sink kiểm tra rồi bỏ.
  // WebRTC, đĩa thật và SHA-256 được kiểm tra riêng trong browser E2E.
  const abort = new AbortController()
  let written = 0, queued = 0, peak = 0, acknowledged = 0, end
  const errors = []
  const sender = protocol.createStreamSender({ protocolVersion: 'file-v3', transferId: 'large',
    signal: abort.signal, onProgress: count => { acknowledged = count; assert.ok(count <= written) },
    channel: { readyState: 'open', bufferedAmount: 0, send(frame) {
      if (typeof frame === 'string') { end = receiver.finish(); return }
      queued += frame.byteLength - 8
      peak = Math.max(peak, queued)
      receiver.push(frame).catch(error => { errors.push(error); abort.abort(error) })
    } },
  })
  const receiver = protocol.createStreamReceiver({ protocolVersion: 'file-v3', size: limits.MAX_FILE_BYTES,
    signal: abort.signal, onProgress() {},
    async write(offset, payload) {
      // Mỗi cửa sổ chặn writer một nhịp, để sender phải thực sự chờ ACK.
      if (offset % protocol.ACK_WINDOW === 0) await tick()
      assert.equal(offset, written)
      assert.equal(payload.byteLength, limits.CHUNK_BYTES)
      assert.equal(new DataView(payload.buffer, payload.byteOffset).getBigUint64(0), BigInt(offset))
      assert.equal(payload.at(-1), 123)
      written += payload.byteLength
      queued -= payload.byteLength
    },
    acknowledge: count => sender.handle(protocol.streamControl('ACK', 'large', count)),
  })
  const virtual = { size: limits.MAX_FILE_BYTES, slice(start, stop) {
    assert.equal(stop - start, limits.CHUNK_BYTES)
    return { async arrayBuffer() {
      const bytes = new Uint8Array(stop - start)
      new DataView(bytes.buffer).setBigUint64(0, BigInt(start))
      bytes[bytes.length - 1] = 123
      return bytes.buffer
    } }
  } }
  sender.handle(protocol.streamControl('READY', 'large'))
  await sender.send(virtual, async () => {})
  assert.equal(await end, limits.MAX_FILE_BYTES)
  assert.equal(written, limits.MAX_FILE_BYTES)
  assert.equal(acknowledged, limits.MAX_FILE_BYTES)
  assert.equal(queued, 0)
  assert.equal(peak, protocol.ACK_WINDOW)
  assert.deepEqual(errors, [])
})

test('warning only above 1 GiB; cancellation and over-limit files never hash or offer', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ maximumFileBytes: limits.MAX_FILE_BYTES }))
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection')
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: class {} })
  t.after(() => previous ? Object.defineProperty(globalThis, 'RTCPeerConnection', previous) : delete globalThis.RTCPeerConnection)
  let warnings = 0, reads = 0, allow = false
  const manager = createFileTransfers({ connection: {
    state: 'Connected', on() {}, off() {}, invoke() { assert.fail('No offer expected') },
  }, token: 'test', userId: '1', onChange() {}, onNotice() {},
  confirmLargeFile: async () => { warnings++; return allow } })
  t.after(() => manager.dispose())
  const file = size => ({ name: 'large.bin', size, slice() { reads++; throw new Error('reached incremental hash') } })
  for (const size of [1024 ** 3 - 1, 1024 ** 3])
    await assert.rejects(manager.offer('1', file(size)), /reached incremental hash/)
  assert.equal(warnings, 0)
  assert.equal(reads, 2)
  assert.equal(await manager.offer('1', file(1024 ** 3 + 1)), null)
  assert.equal(warnings, 1)
  assert.equal(reads, 2)
  allow = true
  await assert.rejects(manager.offer('1', file(limits.MAX_FILE_BYTES)), /reached incremental hash/)
  assert.equal(warnings, 2)
  assert.equal(reads, 3)
  await assert.rejects(manager.offer('1', file(limits.MAX_FILE_BYTES + 1)), /10 GiB/)
  assert.equal(warnings, 2)
  assert.equal(reads, 3)
})

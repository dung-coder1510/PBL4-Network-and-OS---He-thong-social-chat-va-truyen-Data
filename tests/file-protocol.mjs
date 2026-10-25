import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CHUNK_BYTES, MAX_FILE_BYTES, BUFFER_HIGH, createFileReceiver, encodeChunk, sha256, waitForBuffer,
} from '../frontend/src/services/fileProtocol.js'

test('binary file spans multiple frames and preserves exact bytes/hash', async () => {
  const bytes = Uint8Array.from({ length: CHUNK_BYTES * 2 + 19 }, (_, index) => index % 251)
  const receiver = createFileReceiver(bytes.length)
  let offset = 0
  let index = 0
  while (offset < bytes.length) {
    const payload = bytes.slice(offset, offset + CHUNK_BYTES).buffer
    offset += payload.byteLength
    assert.equal(receiver.push(encodeChunk(index++, payload)), offset)
  }
  const result = await receiver.finish().arrayBuffer()
  assert.deepEqual(new Uint8Array(result), bytes)
  assert.equal(await sha256(result), await sha256(bytes.buffer))
  assert.throws(() => receiver.finish())
})

test('empty file is valid, oversized and negative sizes are rejected', async () => {
  assert.equal(createFileReceiver(0).finish().size, 0)
  assert.equal(await sha256(new ArrayBuffer(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  for (const invalid of [-1, MAX_FILE_BYTES + 1, NaN, 0.1]) assert.throws(() => createFileReceiver(invalid))
})

test('receiver rejects missing, repeated, reordered, oversized and truncated chunks', () => {
  const payload = new Uint8Array([1, 2]).buffer
  assert.throws(() => createFileReceiver(2).push(encodeChunk(1, payload)))
  const receiver = createFileReceiver(4)
  receiver.push(encodeChunk(0, payload))
  assert.throws(() => receiver.push(encodeChunk(0, payload)))
  assert.throws(() => receiver.finish())
  assert.throws(() => createFileReceiver(1).push(encodeChunk(0, payload)))
  assert.throws(() => createFileReceiver(10).push(new ArrayBuffer(4)))
  assert.throws(() => createFileReceiver(MAX_FILE_BYTES).push(new ArrayBuffer(CHUNK_BYTES + 5)))
  assert.throws(() => encodeChunk(0, new ArrayBuffer(CHUNK_BYTES + 1)))
  receiver.clear()
  assert.throws(() => receiver.push(encodeChunk(1, payload)))
})

test('changed bytes produce a different SHA-256', async () => {
  assert.notEqual(await sha256(new Uint8Array([1]).buffer), await sha256(new Uint8Array([2]).buffer))
})

class Channel extends EventTarget {
  readyState = 'open'
  bufferedAmount = BUFFER_HIGH + 1
}

test('backpressure waits until the buffer drains', async () => {
  const channel = new Channel()
  let resolved = false
  const pending = waitForBuffer(channel, new AbortController().signal).then(() => { resolved = true })
  await Promise.resolve()
  assert.equal(resolved, false)
  channel.bufferedAmount = 0
  channel.dispatchEvent(new Event('bufferedamountlow'))
  await pending
  assert.equal(resolved, true)
})

test('backpressure is interruptible on cancel and channel close', async () => {
  const controller = new AbortController()
  const pending = waitForBuffer(new Channel(), controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  const channel = new Channel()
  const closed = waitForBuffer(channel, new AbortController().signal)
  channel.dispatchEvent(new Event('close'))
  await assert.rejects(closed, /đóng/)
  channel.readyState = 'closed'
  await assert.rejects(waitForBuffer(channel, new AbortController().signal), /đóng/)
})

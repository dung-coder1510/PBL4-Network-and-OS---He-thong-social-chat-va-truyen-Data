import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { randomBytes } from 'node:crypto'
import { createStreamReceiver, createStreamSender, streamControl } from '../frontend/src/services/fileStreamProtocol.js'
import { CHUNK_BYTES, MULTICHANNEL_PROTOCOL, waitForBuffer } from '../frontend/src/services/fileProtocol.js'

for (const count of [1, 8]) test(`${count} channel(s) can use the original shared send budget without being capped at four frames`, async () => {
  const bytes = randomBytes(1_200_017)
  const output = Buffer.alloc(bytes.length)
  const abort = new AbortController()
  const frames = []
  const peaks = new Array(count).fill(0)
  const limit = Math.floor(1024 ** 2 / count)
  let sender, finished
  const receiver = createStreamReceiver({ size: bytes.length, channelCount: count,
    protocolVersion: MULTICHANNEL_PROTOCOL, maxWindowBytes: 8_000_000, signal: abort.signal,
    write(offset, data) { output.set(data, offset) }, onProgress() {},
    acknowledge(value, details) { sender.handle(streamControl('ACK', '1', value, 0, details)) },
  })
  const channels = Array.from({ length: count }, (_, index) => Object.assign(new EventTarget(), {
    readyState: 'open', bufferedAmount: 0, bufferedAmountLowThreshold: 64 * 1024, draining: false,
    send(frame) {
      if (typeof frame === 'string') {
        if (receiver.end(index)) finished = receiver.finish()
        return
      }
      this.bufferedAmount += frame.byteLength
      peaks[index] = Math.max(peaks[index], this.bufferedAmount)
      assert.ok(this.bufferedAmount <= limit, 'Shared send budget was exceeded')
      frames.push(receiver.push(frame, index))
      if (!this.draining) {
        this.draining = true
        setImmediate(() => {
          this.bufferedAmount = 0
          this.draining = false
          this.dispatchEvent(new Event('bufferedamountlow'))
        })
      }
    },
  }))
  sender = createStreamSender({ channels, transferId: '1', signal: abort.signal,
    protocolVersion: MULTICHANNEL_PROTOCOL, onProgress() {} })
  for (let index = 0; index < count; index++)
    sender.handle(streamControl('READY', '1', undefined, index, receiver.capabilities), index)
  const source = { size: bytes.length, slice(start, stop) {
    return { async arrayBuffer() { return Uint8Array.from(bytes.subarray(start, stop)).buffer } }
  } }
  await sender.send(source, async () => {})
  await Promise.all(frames)
  assert.equal(await finished, bytes.length)
  assert.deepEqual(output, bytes)
  assert.equal(sender.diagnostics().inFlightBytes, 0)
  assert.ok(peaks.every(peak => peak > 4 * (CHUNK_BYTES + 8)), 'Sender remains capped at four frames')
})

test('a low-buffer notification cannot authorize another frame while the byte limit is still full', async () => {
  const channel = Object.assign(new EventTarget(), { readyState: 'open', bufferedAmount: 200_000,
    bufferedAmountLowThreshold: 160_000 })
  let resolved = false
  const pending = waitForBuffer(channel, new AbortController().signal, 16_392, 65_568)
    .then(() => { resolved = true })
  channel.bufferedAmount = 100_000
  channel.dispatchEvent(new Event('bufferedamountlow'))
  await tick()
  assert.equal(resolved, false)
  channel.bufferedAmount = 16_392
  channel.dispatchEvent(new Event('bufferedamountlow'))
  await pending
  assert.equal(resolved, true)
})

test('batched protocols scale bufferedAmountLowThreshold to half of per-channel send budget', () => {
  for (const [count, expectedThreshold] of [[1, 512 * 1024], [2, 256 * 1024], [8, 64 * 1024]]) {
    const channels = Array.from({ length: count }, () => Object.assign(new EventTarget(), {
      readyState: 'open', bufferedAmount: 0, bufferedAmountLowThreshold: 0, send() {},
    }))
    createStreamSender({
      channels, transferId: '1', signal: new AbortController().signal,
      protocolVersion: MULTICHANNEL_PROTOCOL, onProgress() {},
    })
    for (const channel of channels)
      assert.equal(channel.bufferedAmountLowThreshold, expectedThreshold)
  }
})

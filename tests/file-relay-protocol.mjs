import assert from 'node:assert/strict'
import { createRelayUploadBodies, RELAY_BLOCK_BYTES } from '../frontend/src/services/fileRelayProtocol.js'

for (const size of [0, 1, 63_999, 64_000, 64_001, 128_001, 1_000_137]) {
  const original = Uint8Array.from({ length: size }, (_, index) => (index * 31 + Math.floor(index / 251)) % 256)
  const file = new Blob([original])
  for (const count of [1, 2, 4]) {
    const bodies = await Promise.all(createRelayUploadBodies(file, count).map(body => body.arrayBuffer()))
    assert.equal(bodies.reduce((sum, body) => sum + body.byteLength, 0), size)
    const recovered = new Uint8Array(size)
    for (let offset = 0; offset < size; offset += RELAY_BLOCK_BYTES) {
      const block = offset / RELAY_BLOCK_BYTES
      const channel = block % count
      const channelOffset = Math.floor(block / count) * RELAY_BLOCK_BYTES
      const length = Math.min(RELAY_BLOCK_BYTES, size - offset)
      recovered.set(new Uint8Array(bodies[channel], channelOffset, length), offset)
    }
    assert.deepEqual(recovered, original)
  }
}
assert.throws(() => createRelayUploadBodies(new Blob(), 3))
console.log('PASS 1/2/4 HTTPS upload bodies reconstruct the exact original, including empty and partial blocks.')

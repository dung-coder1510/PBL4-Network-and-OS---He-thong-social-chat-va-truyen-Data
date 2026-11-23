import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRelayUploadBodies } from '../frontend/src/services/fileRelayProtocol.js'
import { api, origin, testRun, waitFor } from './text-test-helpers.mjs'

const run = testRun()
const base = origin + '/api/v1'
const digest = data => createHash('sha256').update(data).digest('hex')
const timed = () => AbortSignal.timeout(25000)

async function parallelTransfer(conversationId, count, bytes) {
  const payload = randomBytes(bytes)
  const hash = digest(payload)
  const transfer = await api('/files/relay', { token: run.tokens[0], method: 'POST', body: {
    conversationId, clientTransferId: randomUUID(), fileName: 'parallel.bin', fileSizeBytes: bytes, sha256Hex: hash,
  } })
  assert.equal(transfer.status, 200)
  const path = '/files/' + transfer.data.id
  const accept = await api(path + '/relay/accept', { token: run.tokens[1], method: 'POST', body: {
    transferId: transfer.data.id, expectedVersion: transfer.data.version,
  } })
  const key = accept.data.receiverKey
  const get = fetch(base + path + '/relay/content', { headers: {
    Authorization: 'Bearer ' + run.tokens[1], 'X-File-Relay-Key': key,
  }, signal: timed() })
  await waitFor(() => api(path, { token: run.tokens[0] }), response => response.data?.relayReady)
  assert.equal((await api(path + '/relay/upload', { token: run.tokens[0], method: 'POST',
    body: { sha256Hex: hash, connectionCount: 3 } })).status, 400)
  const started = await api(path + '/relay/upload', { token: run.tokens[0], method: 'POST',
    body: { sha256Hex: hash, connectionCount: count } })
  assert.equal(started.status, 200)
  assert.equal(started.data.relayConnectionCount, count)
  const bodies = createRelayUploadBodies(new Blob([payload]), count)
  const put = (channel, body, token = run.tokens[0], sha = hash) => fetch(
    base + path + '/relay/content?channel=' + channel, { method: 'PUT', body, signal: timed(), headers: {
      Authorization: 'Bearer ' + token, 'X-File-SHA256': sha, 'Content-Type': 'application/octet-stream',
    } })
  assert.equal((await put(count, new Blob())).status, 409)
  assert.equal((await put(0, bodies[0], run.tokens[2])).status, 404)
  assert.equal((await put(0, new Blob([new Uint8Array(bodies[0].size + 1)]))).status, 400)
  assert.equal((await put(0, bodies[0], run.tokens[0], 'ff'.repeat(32))).status, 400)
  const uploads = bytes === 0 ? bodies.map((body, channel) => put(channel, body)) : [put(0, bodies[0])]
  const response = await get
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.equal(first.done, bytes === 0)
  assert.equal((await put(0, bodies[0])).status, 409)
  if (bytes > 0) uploads.push(...bodies.slice(1).map((body, index) => put(index + 1, body)))
  const received = createHash('sha256').update(first.value ?? new Uint8Array())
  let size = first.value?.byteLength ?? 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received.update(value)
    size += value.byteLength
  }
  assert.equal(size, bytes)
  assert.equal(received.digest('hex'), hash)
  const receipt = { transferId: transfer.data.id, expectedVersion: started.data.version,
    receivedBytes: size, verifiedSha256Hex: hash }
  const finish = await fetch(base + path + '/relay/complete', { method: 'POST', signal: timed(),
    headers: { 'X-File-Relay-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(receipt) })
  assert.equal(finish.status, 200)
  assert.equal((await finish.json()).status, 'completed')
  assert.deepEqual((await Promise.all(uploads)).map(upload => upload.status), Array(count).fill(200))
  console.log(`PASS ${count} HTTPS inputs, ${bytes} bytes, first block before all uploads, exact hash and rejected invalid claims.`)
}

try {
  assert.equal((await fetch(base + '/files/relay/diagnostics')).status, 401)
  await run.register()
  const conversation = await api('/conversations', { token: run.tokens[0], method: 'POST',
    body: { peerUserId: run.users[1].id } })
  for (const count of [2, 4])
    for (const bytes of [0, 64_001, 2_000_137]) await parallelTransfer(conversation.data.id, count, bytes)
  const headers = { Authorization: 'Bearer ' + run.tokens[0] }
  assert.equal((await fetch(base + '/files/relay/diagnostics?bytes=110000001', { headers })).status, 400)
  const response = await fetch(base + '/files/relay/diagnostics?bytes=64013', { headers })
  const body = Buffer.from(await response.arrayBuffer())
  assert.equal(body.length, 64013)
  assert.equal(digest(body), response.headers.get('X-File-SHA256'))
  const upload = await fetch(base + '/files/relay/diagnostics', { method: 'PUT', headers, body })
  assert.equal((await upload.json()).receivedBytes, body.length)
  console.log('PASS authenticated bounded upload/download diagnostics and SHA-256.')
} finally { await run.cleanup() }

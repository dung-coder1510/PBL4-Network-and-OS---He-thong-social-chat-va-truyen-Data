import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { api, origin, testRun } from './text-test-helpers.mjs'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const signalR = require('@microsoft/signalr')

const run = testRun()
const base = origin + '/api/v1'
const digest = data => createHash('sha256').update(data).digest('hex')
const timed = () => AbortSignal.timeout(25000)

async function runMultipartApiCase(conversationId, size, partBytes) {
  const payload = randomBytes(size)
  const fullHash = digest(payload)
  const offerRes = await fetch(base + '/files/relay', {
    method: 'POST',
    signal: timed(),
    headers: { Authorization: 'Bearer ' + run.tokens[0], 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      clientTransferId: randomUUID(),
      fileName: `multipart-${size}.bin`,
      fileSizeBytes: size,
      sha256Hex: null,
      relayMode: 'multipart',
      relayConnectionCount: 4,
    }),
  })
  assert.equal(offerRes.status, 200)
  const senderKey = offerRes.headers.get('X-File-Relay-Sender-Key')
  assert.ok(senderKey && senderKey.length >= 32)
  const transfer = await offerRes.json()
  assert.equal(transfer.relayMode, 'multipart')
  assert.equal(transfer.relayConnectionCount, 4)
  assert.equal(transfer.relayPartBytes, partBytes)
  assert.equal(transfer.sha256Hex, null)

  const path = '/files/' + transfer.id
  const accept = await api(path + '/relay/accept', {
    token: run.tokens[1],
    method: 'POST',
    body: { transferId: transfer.id, expectedVersion: transfer.version },
  })
  assert.equal(accept.status, 200)
  assert.equal(accept.data.transfer.relayReady, true)
  const receiverKey = accept.data.receiverKey

  const totalParts = size === 0 ? 0 : Math.ceil(size / partBytes)
  if (totalParts > 0) {
    // Reject wrong sender key and wrong part SHA-256
    const part0 = payload.subarray(0, Math.min(size, partBytes))
    assert.equal((await fetch(base + path + '/relay/parts/0', {
      method: 'PUT', body: part0, signal: timed(),
      headers: { 'X-File-Relay-Sender-Key': 'wrong', 'X-Part-SHA256': digest(part0), 'Content-Type': 'application/octet-stream' },
    })).status, 403)
    assert.equal((await fetch(base + path + '/relay/parts/0', {
      method: 'PUT', body: part0, signal: timed(),
      headers: { 'X-File-Relay-Sender-Key': senderKey, 'X-Part-SHA256': '00'.repeat(32), 'Content-Type': 'application/octet-stream' },
    })).status, 400)

    // Upload all parts in parallel without Authorization header (key-scoped resilience across JWT expiry)
    await Promise.all(Array.from({ length: totalParts }, async (_, idx) => {
      const start = idx * partBytes
      const slice = payload.subarray(start, Math.min(size, start + partBytes))
      const res = await fetch(base + path + `/relay/parts/${idx}`, {
        method: 'PUT', body: slice, signal: timed(),
        headers: { 'X-File-Relay-Sender-Key': senderKey, 'X-Part-SHA256': digest(slice), 'Content-Type': 'application/octet-stream' },
      })
      assert.equal(res.status, 200)
    }))

    // Wrong receiver key rejected
    assert.equal((await fetch(base + path + '/relay/parts/0', {
      signal: timed(), headers: { 'X-File-Relay-Key': 'wrong' },
    })).status, 403)

    // Download all parts out of order and verify part hashes
    const out = Buffer.alloc(size)
    await Promise.all(Array.from({ length: totalParts }, (_, idx) => totalParts - 1 - idx).map(async idx => {
      const res = await fetch(base + path + `/relay/parts/${idx}`, {
        signal: timed(), headers: { 'X-File-Relay-Key': receiverKey },
      })
      assert.equal(res.status, 200)
      const buf = Buffer.from(await res.arrayBuffer())
      assert.equal(digest(buf), res.headers.get('X-Part-SHA256'))
      buf.copy(out, idx * partBytes)
    }))
    assert.deepEqual(out, payload)

    // Ack all parts
    const ackRes = await fetch(base + path + '/relay/parts/ack', {
      method: 'POST', signal: timed(),
      headers: { 'X-File-Relay-Key': receiverKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ partIndices: Array.from({ length: totalParts }, (_, i) => i) }),
    })
    assert.equal(ackRes.status, 200)
    assert.equal((await ackRes.json()).relayedBytes, size)
  }

  // Finalize source SHA-256 (idempotent same hash, 409 conflicting hash)
  const hashRes = await fetch(base + path + '/relay/hash', {
    method: 'POST', signal: timed(),
    headers: { 'X-File-Relay-Sender-Key': senderKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha256Hex: fullHash }),
  })
  assert.equal(hashRes.status, 200)
  const conflictHash = await fetch(base + path + '/relay/hash', {
    method: 'POST', signal: timed(),
    headers: { 'X-File-Relay-Sender-Key': senderKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha256Hex: 'ff'.repeat(32) }),
  })
  assert.equal(conflictHash.status, 409)

  // Receiver fetches hash and completes without JWT
  const getHash = await fetch(base + path + '/relay/hash', {
    signal: timed(), headers: { 'X-File-Relay-Key': receiverKey },
  })
  assert.equal(getHash.status, 200)
  assert.equal((await getHash.json()).sha256Hex, fullHash)

  const complete = await fetch(base + path + '/relay/complete', {
    method: 'POST', signal: timed(),
    headers: { 'X-File-Relay-Key': receiverKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transferId: transfer.id,
      expectedVersion: accept.data.transfer.version,
      receivedBytes: size,
      verifiedSha256Hex: fullHash,
    }),
  })
  assert.equal(complete.status, 200)
  const completed = await complete.json()
  assert.equal(completed.status, 'completed')
  assert.equal(completed.verifiedSha256Hex, fullHash)
  console.log(`PASS multipart HTTP/SQL end-to-end: ${size} bytes (${totalParts} parts)`)
}

try {
  await run.register()
  const cfg = await api('/files/configuration', { token: run.tokens[0] })
  assert.equal(cfg.status, 200)
  assert.equal(cfg.data.supportsMultipartHttpRelay, true)
  assert.equal(cfg.data.defaultRelayConnections, 4)
  assert.ok(cfg.data.relayPartBytes >= 65536)

  const conversation = await api('/conversations', {
    token: run.tokens[0], method: 'POST', body: { peerUserId: run.users[1].id },
  })
  assert.equal(conversation.status, 201)

  for (const size of [0, 123_456, 10_000_017]) {
    await runMultipartApiCase(conversation.data.id, size, cfg.data.relayPartBytes)
  }

  // 0-byte WebRTC pre-hashed offer switched to HTTPS multipart must complete without /relay/hash
  const emptyHash = digest(Buffer.alloc(0))
  const hubs = await Promise.all([0, 1].map(async idx => {
    const hub = new signalR.HubConnectionBuilder()
      .withUrl(origin + '/hubs/chat', { accessTokenFactory: () => run.tokens[idx] })
      .configureLogging(signalR.LogLevel.Error)
      .build()
    hub.on('FileChanged', () => {})
    await hub.start()
    return hub
  }))
  try {
    const offer0 = await hubs[0].invoke('OfferFile', {
      conversationId: conversation.data.id,
      clientTransferId: randomUUID(),
      fileName: 'zero-switch.bin',
      fileSizeBytes: 0,
      sha256Hex: emptyHash,
      supportedProtocols: ['file-v7', 'file-v5', 'file-v1', 'file-v2'],
      requestedChannelCount: 1,
    })
    const switched = await api(`/files/${offer0.id}/relay?mode=multipart&connections=4`, {
      token: run.tokens[0], method: 'POST',
    })
    assert.equal(switched.status, 200)
    assert.equal(switched.data.relayMode, 'multipart')
    assert.equal(switched.data.sha256Hex, emptyHash)

    const accepted0 = await api(`/files/${offer0.id}/relay/accept`, {
      token: run.tokens[1], method: 'POST',
      body: { transferId: offer0.id, expectedVersion: switched.data.version },
    })
    assert.equal(accepted0.status, 200)
    assert.equal(accepted0.data.transfer.status, 'transferring')
    const complete0 = await fetch(`${base}/files/${offer0.id}/relay/complete`, {
      method: 'POST', signal: timed(),
      headers: { 'X-File-Relay-Key': accepted0.data.receiverKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transferId: offer0.id,
        expectedVersion: accepted0.data.transfer.version,
        receivedBytes: 0,
        verifiedSha256Hex: emptyHash,
      }),
    })
    assert.equal(complete0.status, 200)
    assert.equal((await complete0.json()).status, 'completed')
    console.log('PASS 0-byte pre-hashed WebRTC offer switched to multipart HTTPS completes cleanly')
  } finally {
    await Promise.all(hubs.map(h => h.stop()))
  }
} finally {
  await run.cleanup()
}

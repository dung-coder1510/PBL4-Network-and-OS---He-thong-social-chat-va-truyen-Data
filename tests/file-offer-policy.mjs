import assert from 'node:assert/strict'
import test from 'node:test'
import { createFileTransfers } from '../frontend/src/services/fileTransfers.js'
import { LEGACY_MAX_FILE_BYTES, MAX_FILE_BYTES } from '../frontend/src/services/fileProtocol.js'

async function offer(t, { capabilities = {}, count, parallel, small = false, transport = 'webrtc' } = {}) {
  const settings = { maximumFileBytes: MAX_FILE_BYTES, maximumFileChannels: 8,
    supportsDeferredHash: true, supportsParallelFileConnections: true, supportsHttpFileRelay: true,
    iceServers: [], ...capabilities }
  const calls = []
  for (const name of ['Worker', 'RTCPeerConnection']) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value: class {
      constructor() { throw new Error('An offer must not start a peer or read a large file') }
    } })
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name] })
  }
  const dto = body => ({ id: '1', version: 'AAAAAAAAAAE=', status: 'offered', senderId: 1, receiverId: 2,
    senderConnectionId: 'sender-1', createdAt: new Date().toISOString(), ...body })
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/files/configuration')) return Response.json(settings)
    if (url.endsWith('/files/relay') && options.method === 'POST') {
      const body = JSON.parse(options.body)
      calls.push({ method: 'HTTPS', body })
      return Response.json(dto({ ...body, transport: 'https' }))
    }
    throw new Error('Unexpected request: ' + url)
  })
  const connection = { state: 'Connected', connectionId: 'sender-1', on() {}, off() {},
    async invoke(method, body) {
      assert.equal(method, 'OfferFile')
      calls.push({ method, body })
      return dto(body)
    },
  }
  const manager = createFileTransfers({ connection, userId: 1, token: 'isolated-test',
    onChange() {}, onNotice() {}, confirmLargeFile: async () => true })
  t.after(() => manager.dispose())
  const file = small ? new File([new Uint8Array(32)], 'small.bin') : {
    name: 'large.bin', size: LEGACY_MAX_FILE_BYTES + 1,
    slice() { throw new Error('The deferred offer read the whole file before acceptance') },
  }
  await manager.offer('1', file, count, parallel, transport)
  assert.equal(calls.length, 1)
  return calls[0]
}

test('normal large-file offers automatically negotiate two separate connections without reading the source', async t => {
  const { body } = await offer(t)
  assert.equal(body.requestedChannelCount, 2)
  assert.equal(body.supportedProtocols[0], 'file-v6')
  assert.ok(body.supportedProtocols.includes('file-v5'))
  assert.ok(body.supportedProtocols.includes('file-v4'))
  assert.equal(body.sha256Hex, null)
})

test('developer choice of one channel overrides automatic selection', async t => {
  const { body } = await offer(t, { count: 1, parallel: false })
  assert.equal(body.requestedChannelCount, 1)
  assert.equal(body.supportedProtocols.includes('file-v6'), false)
})

test('developer choice of multiple channels stays on one connection', async t => {
  const { body } = await offer(t, { count: 4, parallel: false })
  assert.equal(body.requestedChannelCount, 4)
  assert.equal(body.supportedProtocols[0], 'file-v5')
  assert.equal(body.supportedProtocols.includes('file-v6'), false)
})

for (const capabilities of [{ supportsParallelFileConnections: false },
  { supportsParallelFileConnections: undefined }, { maximumFileChannels: 1 }])
  test('automatic mode retains one connection when the server cannot support two: ' + JSON.stringify(capabilities), async t => {
    const { body } = await offer(t, { capabilities })
    assert.equal(body.requestedChannelCount, 1)
    assert.equal(body.supportedProtocols.includes('file-v6'), false)
    assert.ok(body.supportedProtocols.includes('file-v4'))
  })

test('small normal file retains its existing protocols and one channel', async t => {
  const { body } = await offer(t, { small: true })
  assert.equal(body.requestedChannelCount, 1)
  assert.deepEqual(body.supportedProtocols, ['file-v1', 'file-v2'])
  assert.equal(typeof body.sha256Hex, 'string')
})

test('servers without modern channel capabilities retain the small-file legacy negotiation', async t => {
  const { body } = await offer(t, { small: true,
    capabilities: { maximumFileChannels: undefined, supportsParallelFileConnections: undefined } })
  assert.equal(body.requestedChannelCount, 1)
  assert.deepEqual(body.supportedProtocols, ['file-v1', 'file-v2'])
})

test('explicit HTTPS continues through its REST offer without a WebRTC negotiation', async t => {
  const call = await offer(t, { small: true, transport: 'https' })
  assert.equal(call.method, 'HTTPS')
  assert.equal(call.body.requestedChannelCount, undefined)
  assert.equal(typeof call.body.sha256Hex, 'string')
})

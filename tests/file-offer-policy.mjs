import assert from 'node:assert/strict'
import test from 'node:test'
import { createFileTransfers } from '../frontend/src/services/fileTransfers.js'
import { LEGACY_MAX_FILE_BYTES, MAX_FILE_BYTES } from '../frontend/src/services/fileProtocol.js'

async function offer(t, { capabilities = {}, count, parallel, small = false, transport = 'webrtc', relayCount = null, webrtcCount = null } = {}) {
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
  await manager.offer('1', file, count, parallel, transport, relayCount, webrtcCount)
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

test('normal offers prefer file-v7 when server advertises supportsWebRtcV7', async t => {
  const { body: largeBody } = await offer(t, { capabilities: { supportsWebRtcV7: true } })
  assert.equal(largeBody.requestedChannelCount, 2)
  assert.deepEqual(largeBody.supportedProtocols, ['file-v7', 'file-v6', 'file-v5', 'file-v4'])
  assert.equal(largeBody.sha256Hex, null)

  const { body: smallBody } = await offer(t, { small: true, capabilities: { supportsWebRtcV7: true } })
  assert.equal(smallBody.requestedChannelCount, 1)
  assert.deepEqual(smallBody.supportedProtocols, ['file-v7', 'file-v5', 'file-v1', 'file-v2'])
  assert.equal(typeof smallBody.sha256Hex, 'string')
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

test('small normal file prefers batched single-channel streaming when the server supports channels', async t => {
  const { body } = await offer(t, { small: true })
  assert.equal(body.requestedChannelCount, 1)
  assert.deepEqual(body.supportedProtocols, ['file-v5', 'file-v1', 'file-v2'])
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

test('normal HTTPS multipart offer defaults to 4 parallel connections without pre-hashing the source', async t => {
  const call = await offer(t, {
    transport: 'https',
    capabilities: { supportsMultipartHttpRelay: true, supportsDeferredRelayHash: true, defaultRelayConnections: 4 },
  })
  assert.equal(call.method, 'HTTPS')
  assert.equal(call.body.relayMode, 'multipart')
  assert.equal(call.body.relayConnectionCount, 4)
  assert.equal(call.body.sha256Hex, null)
})

test('developer HTTPS relay connection override is preserved on multipart offers', async t => {
  const call = await offer(t, {
    transport: 'https',
    relayCount: 2,
    capabilities: { supportsMultipartHttpRelay: true, supportsDeferredRelayHash: true, defaultRelayConnections: 4 },
  })
  assert.equal(call.body.relayMode, 'multipart')
  assert.equal(call.body.relayConnectionCount, 2)
})

test('developer WebRTC connection selector supports 1, 2 and 4 v7 connections and falls back safely on older servers', async t => {
  for (const webrtcCount of [1, 2, 4]) {
    const { body } = await offer(t, {
      parallel: true,
      webrtcCount,
      capabilities: { supportsWebRtcV7: true, maximumParallelFileConnections: 4 },
    })
    assert.equal(body.requestedChannelCount, webrtcCount)
    assert.equal(body.supportedProtocols[0], 'file-v7')
    assert.equal(body.supportedProtocols.includes('file-v6'), webrtcCount === 2)
  }

  const { body: legacy } = await offer(t, {
    parallel: true,
    webrtcCount: 4,
    capabilities: { supportsWebRtcV7: false, supportsParallelFileConnections: true },
  })
  assert.equal(legacy.requestedChannelCount, 2)
  assert.equal(legacy.supportedProtocols[0], 'file-v6')
})

test('allowTurnForFiles negotiates allowTurn on OfferFile and receiver honors transfer.allowTurn even when local TURN toggle is off', async t => {
  const turnServer = { urls: ['turn:rt.wiremess.io.vn:3478?transport=udp', 'turns:rt.wiremess.io.vn:5349'], username: 'u', credential: 'p' }
  const settings = { maximumFileBytes: MAX_FILE_BYTES, maximumFileChannels: 8,
    supportsDeferredHash: true, supportsParallelFileConnections: true, supportsWebRtcV7: true,
    supportsHttpFileRelay: true, iceServers: [turnServer] }
  const offerCalls = []
  const peerConfigs = []
  const signalOrder = []
  const pcs = []

  const prevRtc = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection')
  const prevWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: undefined })
  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    configurable: true,
    value: class MockPeer {
      constructor(cfg) {
        peerConfigs.push(cfg)
        this.localDescription = null
        this.remoteDescription = null
        this.candidates = []
        this.sctp = { maxChannels: 8, maxMessageSize: 65536 }
        pcs.push(this)
      }
      createDataChannel() { return { label: 'file-v1', ordered: true, maxRetransmits: null, maxPacketLifeTime: null, readyState: 'connecting', close() {} } }
      async createOffer() { return { type: 'offer', sdp: 'v=0-offer' } }
      async createAnswer() { return { type: 'answer', sdp: 'v=0-answer' } }
      async setLocalDescription(desc) {
        this.localDescription = desc
        this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'c-local' }) } })
      }
      async setRemoteDescription(desc) { this.remoteDescription = desc }
      async addIceCandidate(c) {
        if (c.candidate === 'bad') throw new Error('broken ice')
        this.candidates.push(c)
      }
      close() { this.closed = true }
    },
  })
  t.after(() => {
    Object.defineProperty(globalThis, 'RTCPeerConnection', prevRtc)
    if (prevWorker) Object.defineProperty(globalThis, 'Worker', prevWorker)
    else delete globalThis.Worker
  })

  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/files/configuration')) return Response.json(settings)
    throw new Error('Unexpected fetch: ' + url)
  })

  const handlers = new Map()
  const connection = {
    state: 'Connected',
    connectionId: 'sender-1',
    on: (name, fn) => handlers.set(name, fn),
    off: name => handlers.delete(name),
    async invoke(method, body) {
      if (method === 'OfferFile') {
        offerCalls.push(body)
        return { id: '99', version: 'AAAAAAAAAAE=', status: 'offered', senderId: 1, receiverId: 2,
          senderConnectionId: 'sender-1', createdAt: new Date().toISOString(), ...body }
      }
      if (method === 'SendFileSignal') signalOrder.push(body.kind)
    },
  }

  const senderManager = createFileTransfers({
    connection, userId: 1, token: 'tok', allowTurnForFiles: true,
    onChange() {}, onNotice() {}, confirmLargeFile: async () => true,
  })
  t.after(() => senderManager.dispose())
  await senderManager.offer('1', new File([new Uint8Array(32)], 'small.bin'))
  assert.equal(offerCalls[0].allowTurn, true)

  const receiverHandlers = new Map()
  const receiverConn = {
    state: 'Connected',
    connectionId: 'recv-1',
    on: (name, fn) => receiverHandlers.set(name, fn),
    off: name => receiverHandlers.delete(name),
    async invoke(method, body) {
      if (method === 'SendFileSignal') signalOrder.push(body.kind)
    },
  }
  const receiverManager = createFileTransfers({
    connection: receiverConn, userId: 2, token: 'tok', allowTurnForFiles: false,
    onChange() {}, onNotice() {}, confirmLargeFile: async () => true,
  })
  t.after(() => receiverManager.dispose())

  receiverHandlers.get('FileChanged')({
    id: '100', clientTransferId: crypto.randomUUID(), conversationId: '1',
    senderId: 1, receiverId: 2, senderConnectionId: 'sender-1', receiverConnectionId: 'recv-1',
    fileName: 'small.bin', fileSizeBytes: 32, status: 'accepted', version: 'AAAAAAAAAAI=',
    supportedProtocols: ['file-v1'], protocolVersion: 'file-v1', channelCount: 1, allowTurn: true,
    createdAt: new Date().toISOString(),
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(peerConfigs[0].iceServers, [turnServer])

  receiverHandlers.get('FileSignal')({ transferId: '100', connectionIndex: 0, kind: 'offer', payload: 'v=0' })
  receiverHandlers.get('FileSignal')({ transferId: '100', connectionIndex: 0, kind: 'ice', payload: '{"candidate":"bad"}' })
  receiverHandlers.get('FileSignal')({ transferId: '100', connectionIndex: 0, kind: 'ice', payload: '{"candidate":"good"}' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(signalOrder[0], 'answer')
  assert.ok(signalOrder.includes('ice'))
  assert.notEqual(pcs[0].closed, true)
  assert.deepEqual(pcs[0].candidates, [{ candidate: 'good' }])
})

test('setToken updates createFileTransfers Authorization header without disposing manager', async t => {
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    seen.push({ url, auth: options.headers?.Authorization })
    return Response.json(url.endsWith('/files/configuration') ? { iceServers: [] } : { items: [], nextCursor: null })
  })
  const manager = createFileTransfers({
    connection: null, userId: 1, token: 'tok-old',
    onChange() {}, onNotice() {}, confirmLargeFile: async () => true,
  })
  try {
    manager.setToken('tok-new')
    await manager.load()
    const filesCall = seen.find(item => item.url.endsWith('/files'))
    assert.equal(filesCall?.auth, 'Bearer tok-new')
  } finally { manager.dispose() }
})

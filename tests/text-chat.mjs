import assert from 'node:assert/strict'
import test from 'node:test'
import { createTextChatTransport } from '../frontend/src/services/textChatTransport.js'
import { classifyTextRoute, parseTextFrame } from '../frontend/src/services/textProtocol.js'
import { applyMessageStatus, mergeChatMessages, upsertConversationMessage } from '../frontend/src/utils/chatState.js'

const uuid = '11111111-1111-4111-8111-111111111111'
const session = { sessionId: 'session', conversationId: '10', userAId: 1, userBId: 2,
  connectionAId: 'A', connectionBId: 'B' }
const message = { id: '20', clientMessageId: uuid, conversationId: '10', senderId: 1,
  content: 'Xin chào', createdAt: '2026-10-21T00:00:00Z', deliveredAt: null, readAt: null }
const turn = () => new Promise(resolve => setImmediate(resolve))

async function fixture({ ready = true, commitError = false, sendError = false } = {}) {
  const handlers = new Map()
  const calls = []
  const incoming = []
  const states = []
  const channel = { label: 'chat-v1', ordered: true, maxRetransmits: null, maxPacketLifeTime: null,
    readyState: ready ? 'open' : 'connecting', frames: [],
    send(value) { if (sendError) throw new Error('closed'); this.frames.push(JSON.parse(value)) },
    close() { this.readyState = 'closed' } }
  const pc = { candidates: [], localDescription: null, remoteDescription: null,
    createDataChannel: () => channel,
    createOffer: async () => ({ type: 'offer', sdp: 'v=0' }),
    createAnswer: async () => ({ type: 'answer', sdp: 'v=0' }),
    async setLocalDescription(value) { this.localDescription = value },
    async setRemoteDescription(value) { this.remoteDescription = value },
    async addIceCandidate(value) { this.candidates.push(value) },
    getStats: async () => new Map(), close() { this.closed = true } }
  const connection = { connectionId: 'A', state: 'Connected',
    on: (name, handler) => handlers.set(name, handler), off: name => handlers.delete(name),
    async invoke(name, value) {
      calls.push({ name, value })
      if (name === 'StartTextSession') return session
      if (name === 'CommitPeerMessage' && commitError) throw new Error('response lost')
      if (['CommitPeerMessage', 'SendMessage', 'RelayCommittedMessage'].includes(name)) return { ...message }
    } }
  const manager = createTextChatTransport({ connection, token: 'unused', userId: 1,
    onMessage: value => incoming.push(value), onState: (id, value) => states.push({ id, ...value }),
    createPeer: () => pc, loadConfiguration: async () => ({ iceServers: [] }), ackTimeoutMs: 8 })
  if (ready) {
    await manager.ensure('10')
    await channel.onopen()
  }
  return { manager, handlers, calls, channel, pc, connection, incoming, states }
}

test('not ready uses legacy send immediately', async () => {
  const f = await fixture({ ready: false })
  try {
    assert.equal((await f.manager.send(message)).id, '20')
    assert.equal(f.calls.filter(call => call.name === 'SendMessage').length, 1)
    assert.equal(f.calls.filter(call => call.name === 'CommitPeerMessage').length, 0)
  } finally { f.manager.dispose() }
})

test('lost ACK falls back with original UUID', async () => {
  const f = await fixture()
  try {
    await f.manager.send(message)
    assert.deepEqual(f.calls.find(call => call.name === 'RelayCommittedMessage').value,
      { conversationId: '10', clientMessageId: uuid })
    assert.equal(f.channel.frames[0].message.id, '20')
    assert.equal(f.calls.filter(call => call.name === 'SendMessage').length, 0)
    assert.equal(f.pc.closed, true)
  } finally { f.manager.dispose() }
})

test('failed channel send relays the committed message', async () => {
  const f = await fixture({ sendError: true })
  try {
    await f.manager.send(message)
    assert.equal(f.calls.filter(call => call.name === 'RelayCommittedMessage').length, 1)
  } finally { f.manager.dispose() }
})

test('ACK prevents relay and remains separate from commit', async () => {
  const f = await fixture()
  try {
    const sending = f.manager.send(message)
    await turn()
    assert.equal(f.incoming[0].deliveredAt, null)
    f.channel.onmessage({ data: JSON.stringify({ v: 1, type: 'ack', sessionId: 'session',
      messageId: '20', clientMessageId: uuid }) })
    await sending
    assert.equal(f.calls.some(call => call.name === 'RelayCommittedMessage'), false)
  } finally { f.manager.dispose() }
})

test('concurrent retries share one commit and ACK waiter', async () => {
  const f = await fixture()
  try {
    const first = f.manager.send(message)
    const second = f.manager.send(message)
    assert.equal(first, second)
    await turn()
    assert.equal(f.calls.filter(call => call.name === 'CommitPeerMessage').length, 1)
    f.channel.onmessage({ data: JSON.stringify({ v: 1, type: 'ack', sessionId: 'session',
      messageId: '20', clientMessageId: uuid }) })
    await Promise.all([first, second])
  } finally { f.manager.dispose() }
})

test('ambiguous commit retries original UUID', async () => {
  const f = await fixture({ commitError: true })
  try {
    await f.manager.send(message)
    assert.equal(f.calls.find(call => call.name === 'SendMessage').value.clientMessageId, uuid)
  } finally { f.manager.dispose() }
})

test('queues ICE before SDP', async () => {
  const f = await fixture()
  try {
    f.handlers.get('TextSignal')({ sessionId: 'session', kind: 'ice', payload: '{"candidate":"early"}' })
    await turn()
    assert.equal(f.pc.candidates.length, 0)
    f.handlers.get('TextSignal')({ sessionId: 'session', kind: 'answer', payload: 'v=0' })
    await turn()
    assert.deepEqual(f.pc.candidates, [{ candidate: 'early' }])
    f.handlers.get('TextSignal')({ sessionId: 'old', kind: 'ice', payload: '{"candidate":"stale"}' })
    await turn()
    assert.equal(f.pc.candidates.length, 1)
  } finally { f.manager.dispose() }
})

test('disconnect cleans pending ACKs and peers', async () => {
  const f = await fixture()
  const sending = f.manager.send(message)
  await turn()
  f.manager.disconnected()
  await assert.rejects(sending, /Kết nối đã thay đổi/)
  assert.equal(f.pc.closed, true)
  assert.equal(f.channel.onmessage, null)
  assert.equal(f.calls.some(call => call.name === 'RelayCommittedMessage'), false)
  f.manager.dispose()
  assert.equal(f.handlers.size, 0)
})

test('dispose active peer cleans ACK timer channel and listeners', async () => {
  const f = await fixture()
  const sending = f.manager.send(message)
  await turn()
  f.manager.dispose()
  await assert.rejects(sending, /Kết nối đã thay đổi/)
  assert.equal(f.pc.closed, true)
  assert.equal(f.channel.readyState, 'closed')
  assert.equal(f.channel.onmessage, null)
  assert.equal(f.handlers.size, 0)
  assert.equal(f.calls.some(call => call.name === 'RelayCommittedMessage'), false)
})

test('configuration failure releases an uninitialized peer', async () => {
  const f = await fixture({ ready: false })
  f.manager.dispose()
  const manager = createTextChatTransport({ connection: f.connection, userId: 1,
    createPeer: () => { throw new Error('must not create before configuration') },
    loadConfiguration: async () => { throw new Error('unavailable') },
    onMessage: () => {}, onState: () => {} })
  await assert.doesNotReject(manager.ensure('10'))
  manager.dispose()
})

test('rejects invalid frames', () => {
  const valid = { v: 1, type: 'message', sessionId: 'session', message: { ...message, senderId: 2 } }
  assert.equal(parseTextFrame(JSON.stringify(valid), session, 2).message.content, 'Xin chào')
  for (const frame of [null, {}, { ...valid, sessionId: 'old' },
    { ...valid, message }, { ...valid, message: { ...valid.message, conversationId: '11' } },
    { ...valid, message: { ...valid.message, content: 'x'.repeat(4001) } },
    { ...valid, message: { ...valid.message, id: 'local:1' } },
    { ...valid, message: { ...valid.message, clientMessageId: 'not-uuid' } }])
    assert.throws(() => parseTextFrame(JSON.stringify(frame), session, 2))
  assert.throws(() => parseTextFrame(new ArrayBuffer(8), session, 2))
  assert.throws(() => parseTextFrame('x'.repeat(28001), session, 2))
})

test('duplicate delivery and receipts never regress', () => {
  const read = { ...message, deliveredAt: '2026-10-21T00:00:01Z', readAt: '2026-10-21T00:00:02Z' }
  const rows = mergeChatMessages([read], [message, { ...message, id: 'local:x' }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, '20')
  assert.equal(rows[0].readAt, read.readAt)
  let list = upsertConversationMessage([], message, { id: '10', unreadCount: 0 }, { currentUserId: 2 })
  list = upsertConversationMessage(list, message, null, { currentUserId: 2 })
  assert.equal(list[0].unreadCount, 1)
  const gap = { ...message, id: '21', clientMessageId: '22222222-2222-4222-8222-222222222222' }
  const status = { conversationId: '10', upToMessageId: '21', messageId: '21', recipientUserId: 2,
    deliveredAt: read.deliveredAt, readAt: read.readAt }
  const updated = applyMessageStatus([message, gap], status)
  assert.equal(updated[0].deliveredAt, null)
  assert.equal(updated[1].readAt, read.readAt)
  const late = { ...message, id: '19', clientMessageId: '33333333-3333-4333-8333-333333333333' }
  list = upsertConversationMessage(list, late, null, { currentUserId: 2 })
  assert.equal(list[0].unreadCount, 2)
  list = upsertConversationMessage(list, late, null, { currentUserId: 2 })
  assert.equal(list[0].unreadCount, 2)
})

test('route classification follows selected candidate pair', () => {
  assert.equal(classifyTextRoute(new Map()), 'webrtc')
  const stats = new Map([
    ['t', { type: 'transport', selectedCandidatePairId: 'p' }],
    ['p', { type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r' }],
    ['l', { candidateType: 'host' }], ['r', { candidateType: 'srflx' }],
    ['unused', { type: 'candidate-pair', nominated: true, localCandidateId: 'relay' }],
    ['relay', { candidateType: 'relay' }],
  ])
  assert.equal(classifyTextRoute(stats), 'direct')
  stats.set('r', { candidateType: 'relay' })
  assert.equal(classifyTextRoute(stats), 'turn')
})

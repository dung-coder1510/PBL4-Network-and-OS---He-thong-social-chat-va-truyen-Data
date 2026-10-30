import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { api, sql, testRun, waitFor } from './text-test-helpers.mjs'

const run = testRun()
const check = label => console.log('PASS ' + label)
const hash = content => createHash('sha256').update(content).digest('hex')
try {
  await run.register()
  const a = await run.connect(run.tokens[0])
  const b1 = await run.connect(run.tokens[1])
  const b2 = await run.connect(run.tokens[1])
  const outsider = await run.connect(run.tokens[2])
  const conversation = await api('/conversations', { token: run.tokens[0], method: 'POST',
    body: { peerUserId: run.users[1].id } })
  assert.equal(conversation.status, 201)
  const conversationId = conversation.data.id
  const b = [b1, b2].sort((left, right) => left.connectionId < right.connectionId ? -1 : 1)[0]
  const secondary = b === b1 ? b2 : b1
  const [s1, s2] = await Promise.all([
    a.invoke('StartTextSession', conversationId), b.invoke('StartTextSession', conversationId),
  ])
  assert.equal(s1.sessionId, s2.sessionId)
  check('concurrent starts converge')
  const endpoints = new Map([a, b].map(hub => [hub.connectionId, hub]))
  await endpoints.get(s1.connectionAId).invoke('SendTextSignal', { sessionId: s1.sessionId, kind: 'offer', payload: 'v=0\r\n' })
  await endpoints.get(s1.connectionBId).invoke('SendTextSignal', { sessionId: s1.sessionId, kind: 'answer', payload: 'v=0\r\n' })
  await a.invoke('TextSessionReady', s1.sessionId)
  await b.invoke('TextSessionReady', s1.sessionId)

  await assert.rejects(outsider.invoke('StartTextSession', conversationId))
  for (const hub of [outsider, secondary])
    await assert.rejects(hub.invoke('SendTextSignal', { sessionId: s1.sessionId, kind: 'ice', payload: '{"candidate":"x"}' }))
  await assert.rejects(a.invoke('SendTextSignal', { sessionId: s1.sessionId, kind: 'ice', payload: 'not-json' }))
  await assert.rejects(a.invoke('SendTextSignal', { sessionId: s1.sessionId, kind: 'ice', payload: 'x'.repeat(4097) }))
  check('session authorization and stale signals (authorization)')

  const targetMessages = []
  const secondaryMessages = []
  b.on('MessageReceived', value => { targetMessages.push(value) })
  secondary.on('MessageReceived', value => { secondaryMessages.push(value) })
  const request = { conversationId, clientMessageId: randomUUID(), content: '  Text P2P kiểm thử  ' }
  const saved = await a.invoke('CommitPeerMessage', { sessionId: s1.sessionId, message: request })
  assert.equal(saved.content, request.content.trim())
  assert.equal(saved.deliveredAt, null)
  assert.equal(saved.readAt, null)
  assert.equal(sql(`SELECT COUNT(*) FROM dbo.Messages WHERE Id=${saved.id}`), '1')
  await waitFor(() => secondaryMessages.length, count => count === 1)
  assert.equal(targetMessages.length, 0)
  check('commit persists without target fanout')
  check('commit excludes target and syncs secondary tab')
  for (const content of ['', 'x'.repeat(4001)])
    await assert.rejects(a.invoke('CommitPeerMessage', { sessionId: s1.sessionId,
      message: { ...request, clientMessageId: randomUUID(), content } }))

  const receipt = { sessionId: s1.sessionId, messageId: saved.id,
    clientMessageId: saved.clientMessageId, contentSha256Hex: hash(saved.content) }
  await assert.rejects(b.invoke('AcknowledgePeerMessage', { ...receipt, contentSha256Hex: 'ab'.repeat(32) }))
  await assert.rejects(outsider.invoke('AcknowledgePeerMessage', receipt))
  const verified = await b.invoke('AcknowledgePeerMessage', receipt)
  assert.equal(verified.status.messageId, saved.id)
  assert.ok(verified.status.deliveredAt)
  assert.equal(verified.status.readAt, null)
  assert.equal((await b.invoke('AcknowledgePeerMessage', receipt)).status.deliveredAt, verified.status.deliveredAt)
  check('peer receipt checks content and sender')

  assert.equal((await a.invoke('CommitPeerMessage', { sessionId: s1.sessionId, message: request })).id, saved.id)
  await assert.rejects(a.invoke('CommitPeerMessage', { sessionId: s1.sessionId,
    message: { ...request, content: 'changed' } }))
  for (let i = 0; i < 2; i++)
    assert.equal((await a.invoke('RelayCommittedMessage', { conversationId, clientMessageId: saved.clientMessageId })).id, saved.id)
  assert.equal(sql(`SELECT COUNT(*) FROM dbo.Messages WHERE SenderId=${run.users[0].id} AND ClientMessageId='${saved.clientMessageId}'`), '1')
  await assert.rejects(outsider.invoke('RelayCommittedMessage', { conversationId, clientMessageId: saved.clientMessageId }))
  check('idempotent commit and fallback')

  const gaps = []
  for (const content of ['gap earlier', 'gap later'])
    gaps.push(await a.invoke('CommitPeerMessage', { sessionId: s1.sessionId,
      message: { conversationId, clientMessageId: randomUUID(), content } }))
  const exact = { conversationId, messageId: gaps[1].id }
  await assert.rejects(outsider.invoke('ReadMessage', exact))
  await assert.rejects(a.invoke('AcknowledgeMessage', exact))
  const status = await b.invoke('ReadMessage', exact)
  assert.equal(status.messageId, gaps[1].id)
  assert.equal(status.unreadCount, 2) // First verified message + earlier gap remain unread.
  assert.equal(sql(`SELECT COUNT(*) FROM dbo.Messages WHERE Id=${gaps[0].id} AND DeliveredAt IS NULL AND ReadAt IS NULL`), '1')
  assert.equal((await b.invoke('ReadMessage', exact)).readAt, status.readAt)
  check('exact receipts preserve gaps')

  const disconnectedSessions = []
  b.on('TextSessionClosed', value => { disconnectedSessions.push(value) })
  await a.stop()
  await waitFor(() => disconnectedSessions, values => values.some(value => value.sessionId === s1.sessionId))
  await assert.rejects(b.invoke('SendTextSignal', { sessionId: s1.sessionId, kind: 'ice', payload: '{"candidate":"old"}' }))
  const anew = await run.connect(run.tokens[0])
  await assert.rejects(anew.invoke('TextSessionReady', s1.sessionId))
  check('session authorization and stale signals')

  await b1.stop()
  await b2.stop()
  const offline = await anew.invoke('SendMessage', { conversationId, clientMessageId: randomUUID(), content: 'offline text' })
  const pending = await api('/users/me/pending-messages', { token: run.tokens[1] })
  assert.equal(pending.status, 200)
  assert.ok(pending.data.items.some(m => m.id === offline.id && m.content === 'offline text'))
  check('offline catchup')

  const login = await api('/sessions', { method: 'POST', body: { username: run.names[1], password: run.password } })
  assert.equal(login.status, 201)
  const brevoke = await run.connect(login.data.accessToken)
  const revokedSession = await anew.invoke('StartTextSession', conversationId)
  assert.ok(revokedSession)
  const closed = []
  anew.on('TextSessionClosed', value => { closed.push(value) })
  assert.equal((await api('/sessions/current', { token: login.data.accessToken, method: 'DELETE' })).status, 204)
  await waitFor(() => closed, values => values.some(value => value.sessionId === revokedSession.sessionId))
  await assert.rejects(anew.invoke('TextSessionReady', revokedSession.sessionId))
  check('revocation closes sessions')

  const historyReader = await run.connect(run.tokens[1])
  sql(`UPDATE dbo.Users SET IsDisabled=1 WHERE Id=${run.users[0].id}`)
  const historical = await historyReader.invoke('ReadMessage', { conversationId, messageId: saved.id })
  assert.equal(historical.messageId, saved.id)
  assert.ok(historical.readAt)
  check('disabled peer history remains readable')
} finally {
  await run.cleanup()
  console.log('Removed only text integration test data.')
}

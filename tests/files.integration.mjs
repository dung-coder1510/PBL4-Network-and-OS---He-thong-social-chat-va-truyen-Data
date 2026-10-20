import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const signalR = require('@microsoft/signalr')
const origin = process.env.FILE_TEST_ORIGIN || 'http://127.0.0.1:5173'
const server = process.env.AUTH_TEST_SQL_SERVER
const database = process.env.AUTH_TEST_DATABASE
if (!server || !database || !['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
  throw new Error('Use a local server and set AUTH_TEST_SQL_SERVER / AUTH_TEST_DATABASE.')
const prefix = 'filetest_' + randomUUID().replaceAll('-', '').slice(0, 10)
const names = ['a', 'b', 'c'].map(suffix => prefix + suffix)
const password = randomUUID()
const users = []
const tokens = []
const hubs = []
const hash = 'ab'.repeat(32)
let passed = 0
let ownNames = false
const check = label => { console.log('PASS ' + label); passed++ }

function sql(query) {
  return execFileSync('sqlcmd', ['-S', server, '-d', database, '-E', '-C', '-b', '-h', '-1', '-W',
    '-Q', 'SET NOCOUNT ON; SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON; SET ANSI_PADDING ON; ' +
    'SET ANSI_WARNINGS ON; SET CONCAT_NULL_YIELDS_NULL ON; SET ARITHABORT ON; SET NUMERIC_ROUNDABORT OFF; ' + query],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function api(path, token, body) {
  const response = await fetch(origin + '/api/v1' + path, {
    method: body ? 'POST' : 'GET',
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  return { status: response.status, data: await response.json().catch(() => null) }
}

async function connect(token) {
  const hub = new signalR.HubConnectionBuilder().withUrl(origin + '/hubs/chat',
    { accessTokenFactory: () => token }).configureLogging(signalR.LogLevel.Error).build()
  for (const event of ['FileChanged', 'FileSignal', 'ConversationChanged', 'PresenceChanged'])
    hub.on(event, () => {})
  hubs.push(hub)
  await hub.start()
  return hub
}

async function waitFor(action, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await action()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('Condition timed out')
}

const action = transfer => ({ transferId: transfer.id, expectedVersion: transfer.version })

try {
  assert.equal(sql(`SELECT COUNT(*) FROM dbo.Users WHERE Username IN ('${names.join("','")}')`), '0')
  ownNames = true
  assert.equal((await api('/files')).status, 401)
  check('History requires authentication')
  for (const username of names) {
    const registration = await api('/users', null, { username, displayName: username, password })
    assert.equal(registration.status, 201)
    users.push(registration.data)
    const session = await api('/sessions', null, { username, password })
    assert.equal(session.status, 201)
    tokens.push(session.data.accessToken)
  }
  const conversation = await api('/conversations', tokens[0], { peerUserId: users[1].id })
  assert.equal(conversation.status, 201)
  const conversationId = conversation.data.id
  const sender = await connect(tokens[0])
  const receiver = await connect(tokens[1])
  const otherTab = await connect(tokens[1])
  const outsider = await connect(tokens[2])
  const offer = overrides => ({
    conversationId, clientTransferId: randomUUID(), fileName: 'test.bin',
    fileSizeBytes: 1024, sha256Hex: hash, ...overrides,
  })
  await assert.rejects(outsider.invoke('OfferFile', offer()))
  for (const invalid of [{ fileSizeBytes: -1 }, { fileSizeBytes: 104857601 },
    { fileName: '../bad' }, { sha256Hex: 'xyz' }, { fileName: '' }])
    await assert.rejects(sender.invoke('OfferFile', offer(invalid)))
  check('Membership, size, file name and SHA-256 are validated')

  const request = offer()
  const offered = await sender.invoke('OfferFile', request)
  const duplicate = await sender.invoke('OfferFile', request)
  assert.equal(offered.id, duplicate.id)
  await assert.rejects(sender.invoke('OfferFile', { ...request, fileName: 'different.bin' }))
  assert.equal((await api('/files', tokens[2])).data.items.length, 0)
  await assert.rejects(outsider.invoke('AcceptFile', action(offered)))
  await assert.rejects(sender.invoke('AcceptFile', action(offered)))
  check('Idempotent offer, private history, only recipient can accept')

  const results = await Promise.allSettled([
    receiver.invoke('AcceptFile', action(offered)), otherTab.invoke('AcceptFile', action(offered)),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const winningIndex = results.findIndex(result => result.status === 'fulfilled')
  const winner = [receiver, otherTab][winningIndex]
  const loser = [receiver, otherTab][1 - winningIndex]
  let transfer = results[winningIndex].value
  assert.equal(transfer.receiverConnectionId, winner.connectionId)
  await assert.rejects(loser.invoke('CancelFile', action(transfer)))
  await assert.rejects(winner.invoke('RejectFile', action(transfer)))
  check('Exactly one receiving tab wins; other tab cannot cancel or change it')

  const signal = (kind, payload = 'v=0\r\n') => ({ transferId: transfer.id, kind, payload })
  await assert.rejects(winner.invoke('SendFileSignal', signal('offer')))
  await assert.rejects(outsider.invoke('SendFileSignal', signal('ice', '{}')))
  await assert.rejects(sender.invoke('SendFileSignal', signal('offer', 'x'.repeat(24001))))
  await sender.invoke('SendFileSignal', signal('offer'))
  await assert.rejects(sender.invoke('SendFileSignal', signal('offer')))
  await winner.invoke('SendFileSignal', signal('answer'))
  let receivedByLoser = false
  loser.on('FileSignal', () => { receivedByLoser = true })
  const received = new Promise(resolve => winner.on('FileSignal', resolve))
  await sender.invoke('SendFileSignal', signal('ice', '{"candidate":"test"}'))
  assert.equal((await received).payload, '{"candidate":"test"}')
  assert.equal(receivedByLoser, false)
  check('Signaling direction, payload limit and exact receiving tab enforced')

  transfer = await sender.invoke('BeginFileTransfer', action(transfer))
  await assert.rejects(sender.invoke('CompleteFile', { ...action(transfer),
    receivedBytes: 1024, verifiedSha256Hex: hash }))
  await assert.rejects(winner.invoke('CompleteFile', { ...action(transfer),
    receivedBytes: 1023, verifiedSha256Hex: hash }))
  await assert.rejects(winner.invoke('CompleteFile', { ...action(transfer),
    receivedBytes: 1024, verifiedSha256Hex: 'cd'.repeat(32) }))
  transfer = await winner.invoke('CompleteFile', { ...action(transfer),
    receivedBytes: 1024, verifiedSha256Hex: hash })
  assert.equal(transfer.status, 'completed')
  assert.equal(transfer.verifiedSha256Hex, hash)
  await assert.rejects(sender.invoke('CancelFile', action(transfer)))
  check('Only receiver confirms exact bytes/hash; terminal state cannot be changed')

  const cancelled = await sender.invoke('OfferFile', offer())
  assert.equal((await sender.invoke('CancelFile', action(cancelled))).status, 'cancelled')
  const rejected = await sender.invoke('OfferFile', offer())
  assert.equal((await receiver.invoke('RejectFile', action(rejected))).status, 'rejected')
  check('Cancel and reject persist terminal metadata')

  const first = await sender.invoke('OfferFile', offer())
  const second = await sender.invoke('OfferFile', offer())
  await assert.rejects(sender.invoke('OfferFile', offer()))
  await sender.invoke('CancelFile', action(second))
  check('Concurrent transfer budget is enforced')
  const start = Date.now()
  await waitFor(() => api('/files', tokens[0]),
    result => result.data.items.some(item => item.id === first.id && item.status === 'expired'), 70000)
  assert.ok(Date.now() - start >= 59000)
  check('Unanswered offer expires after 60 seconds')

  const disconnected = await sender.invoke('OfferFile', offer())
  await receiver.invoke('AcceptFile', action(disconnected))
  await sender.stop()
  await waitFor(() => api('/files', tokens[1]),
    result => result.data.items.some(item => item.id === disconnected.id && item.status === 'failed'))
  check('Closing sender connection fails the bound transfer')
  console.log(`${passed} file integration checks passed.`)
} finally {
  await Promise.allSettled(hubs.map(hub => hub.stop()))
  if (ownNames) {
    const ids = `SELECT Id FROM dbo.Users WHERE Username IN ('${names.join("','")}')`
    const conversations = `SELECT Id FROM dbo.DirectConversations WHERE UserAID IN (${ids}) AND UserBID IN (${ids})`
    sql(`DELETE FROM dbo.FileTransfers WHERE ConversationId IN (${conversations});
      DELETE FROM dbo.DirectConversations WHERE Id IN (${conversations});
      DELETE FROM dbo.Users WHERE Username IN ('${names.join("','")}')`)
    console.log('Removed only this run’s accounts, conversations and file metadata.')
  }
}

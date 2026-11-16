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

  const streaming = await sender.invoke('OfferFile', offer({ supportedProtocols: ['file-v1', 'file-v2'] }))
  assert.ok(streaming.supportedProtocols.includes('file-v2'))
  await assert.rejects(receiver.invoke('AcceptFile', { ...action(streaming), protocolVersion: 'file-v2', channelCount: 2 }))
  const acceptedStream = await receiver.invoke('AcceptFile', { ...action(streaming), protocolVersion: 'file-v2', channelCount: 1 })
  assert.equal(acceptedStream.protocolVersion, 'file-v2')
  assert.equal(acceptedStream.channelCount, 1)
  await sender.invoke('CancelFile', action(acceptedStream))
  const compatible = await sender.invoke('OfferFile', offer({ supportedProtocols: ['file-v1', 'file-v2'] }))
  const legacy = await receiver.invoke('AcceptFile', action(compatible))
  assert.equal(legacy.protocolVersion, 'file-v1')
  await sender.invoke('CancelFile', action(legacy))
  const oldSender = await sender.invoke('OfferFile', offer())
  await assert.rejects(receiver.invoke('AcceptFile', { ...action(oldSender), protocolVersion: 'file-v2' }))
  await sender.invoke('CancelFile', action(oldSender))
  check('Single-channel v2 negotiation and old-client v1 fallback')

  const settings = await api('/files/configuration', tokens[0])
  assert.equal(settings.data.maximumFileBytes, 10 * 1024 ** 3)
  assert.equal(settings.data.legacyMaximumFileBytes, 100 * 1024 ** 2)
  assert.equal(settings.data.maximumFileChannels, 8)
  const parallelOffer = overrides => offer({ supportedProtocols: ['file-v5', 'file-v1', 'file-v2'], requestedChannelCount: 8, ...overrides })
  await assert.rejects(sender.invoke('OfferFile', parallelOffer({ requestedChannelCount: 9 })))
  await assert.rejects(sender.invoke('OfferFile', parallelOffer({ supportedProtocols: ['file-v2'] })))
  const parallel = await sender.invoke('OfferFile', parallelOffer())
  assert.equal(parallel.requestedChannelCount, 8)
  for (const channelCount of [0, 9])
    await assert.rejects(receiver.invoke('AcceptFile', { ...action(parallel), protocolVersion: 'file-v5', channelCount }))
  const eightChannels = await receiver.invoke('AcceptFile', { ...action(parallel), protocolVersion: 'file-v5', channelCount: 8 })
  assert.equal(eightChannels.channelCount, 8)
  assert.equal(eightChannels.protocolVersion, 'file-v5')
  await sender.invoke('CancelFile', action(eightChannels))
  const smallerOffer = await sender.invoke('OfferFile', parallelOffer({ requestedChannelCount: 4 }))
  await assert.rejects(receiver.invoke('AcceptFile', { ...action(smallerOffer), protocolVersion: 'file-v5', channelCount: 8 }))
  const oneChannel = await receiver.invoke('AcceptFile', { ...action(smallerOffer), protocolVersion: 'file-v2' })
  assert.equal(oneChannel.protocolVersion, 'file-v2')
  assert.equal(oneChannel.channelCount, 1)
  await sender.invoke('CancelFile', action(oneChannel))
  check('Multichannel offers are capped at eight, accept only what was offered, and support one-channel fallback')
  await assert.rejects(sender.invoke('OfferFile', offer({
    fileSizeBytes: 10 * 1024 ** 3 + 1, supportedProtocols: ['file-v3'],
  })))
  const large = await sender.invoke('OfferFile', offer({
    fileSizeBytes: 10 * 1024 ** 3, supportedProtocols: ['file-v3'],
  }))
  assert.equal(large.fileSizeBytes, 10 * 1024 ** 3)
  for (const protocolVersion of ['file-v1', 'file-v2', 'unknown'])
    await assert.rejects(receiver.invoke('AcceptFile', { ...action(large), protocolVersion }))
  const largeAccepted = await receiver.invoke('AcceptFile', { ...action(large), protocolVersion: 'file-v3' })
  assert.equal(largeAccepted.protocolVersion, 'file-v3')
  assert.equal((await api('/files', tokens[0])).data.items.find(item => item.id === large.id).fileSizeBytes, 10 * 1024 ** 3)
  await sender.invoke('CancelFile', action(largeAccepted))
  check('Exact 10 GiB persists in SQL, oversize and protocol downgrades are rejected')

  assert.equal(settings.data.supportsDeferredHash, true)
  const deferredRequest = offer({ fileSizeBytes: 10 * 1024 ** 3, sha256Hex: null, supportedProtocols: ['file-v4'] })
  await assert.rejects(sender.invoke('OfferFile', { ...deferredRequest, supportedProtocols: ['file-v3', 'file-v4'] }))
  let deferred = await sender.invoke('OfferFile', deferredRequest)
  assert.equal(deferred.sha256Hex, null)
  assert.equal((await sender.invoke('OfferFile', deferredRequest)).id, deferred.id)
  await assert.rejects(sender.invoke('FinalizeFileHash', { ...action(deferred), sha256Hex: hash }))
  await assert.rejects(receiver.invoke('AcceptFile', { ...action(deferred), protocolVersion: 'file-v3' }))
  deferred = await receiver.invoke('AcceptFile', { ...action(deferred), protocolVersion: 'file-v4' })
  for (const [hub, kind] of [[sender, 'offer'], [receiver, 'answer']])
    await hub.invoke('SendFileSignal', { transferId: deferred.id, kind, payload: 'v=0\r\n' })
  deferred = await sender.invoke('BeginFileTransfer', action(deferred))
  const receipt = transfer => ({ ...action(transfer), receivedBytes: deferred.fileSizeBytes, verifiedSha256Hex: hash })
  await assert.rejects(receiver.invoke('CompleteFile', receipt(deferred)))
  await assert.rejects(receiver.invoke('FinalizeFileHash', { ...action(deferred), sha256Hex: hash }))
  deferred = await sender.invoke('FinalizeFileHash', { ...action(deferred), sha256Hex: hash })
  assert.equal(deferred.sha256Hex, hash)
  assert.equal((await sender.invoke('OfferFile', deferredRequest)).id, deferred.id)
  await assert.rejects(sender.invoke('FinalizeFileHash', { ...action(deferred), sha256Hex: 'cd'.repeat(32) }))
  await assert.rejects(receiver.invoke('CompleteFile', { ...receipt(deferred), verifiedSha256Hex: 'cd'.repeat(32) }))
  const done = await receiver.invoke('CompleteFile', receipt(deferred))
  assert.equal(done.status, 'completed')
  assert.equal(done.verifiedSha256Hex, hash)
  check('v4 offers before hashing, binds the finalized hash to the sender, and requires it to complete')

  const parallelLarge = await sender.invoke('OfferFile', parallelOffer({
    fileSizeBytes: 10 * 1024 ** 3, sha256Hex: null, supportedProtocols: ['file-v5', 'file-v4'],
  }))
  const olderReceiver = await receiver.invoke('AcceptFile', { ...action(parallelLarge), protocolVersion: 'file-v4' })
  assert.equal(olderReceiver.protocolVersion, 'file-v4')
  assert.equal(olderReceiver.channelCount, 1)
  assert.equal(olderReceiver.sha256Hex, null)
  await sender.invoke('CancelFile', action(olderReceiver))
  check('A deferred multichannel offer can be accepted by a single-channel v4 receiver')

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

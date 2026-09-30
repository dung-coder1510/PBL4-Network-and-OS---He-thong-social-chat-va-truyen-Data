// Kiểm thử API + SignalR thật trên SQL Server local. Chỉ tạo/xóa dữ liệu có prefix riêng.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const requireFromFrontend = createRequire(new URL('../frontend/package.json', import.meta.url))
const signalR = requireFromFrontend('@microsoft/signalr')
const origin = process.env.MESSAGE_TEST_ORIGIN || 'http://127.0.0.1:5255'
const apiBase = origin + '/api/v1'
const hubUrl = origin + '/hubs/chat'
const server = process.env.AUTH_TEST_SQL_SERVER
const database = process.env.AUTH_TEST_DATABASE
if (!server || !database) throw new Error('Set AUTH_TEST_SQL_SERVER and AUTH_TEST_DATABASE.')
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Local server only.')

const prefix = 'msgtest_' + randomUUID().replaceAll('-', '').slice(0, 12)
const names = ['sender', 'receiver', 'outsider'].map(suffix => prefix + '_' + suffix)
const password = randomUUID()
const users = []
const tokens = []
const hubs = []
let ownNames = false
let passed = 0

function sql(query) {
  return execFileSync('sqlcmd', ['-S', server, '-d', database, '-E', '-C', '-b', '-l', '5',
    '-h', '-1', '-W', '-Q', 'SET NOCOUNT ON; SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON; ' +
      'SET ANSI_PADDING ON; SET ANSI_WARNINGS ON; SET CONCAT_NULL_YIELDS_NULL ON; ' +
      'SET ARITHABORT ON; SET NUMERIC_ROUNDABORT OFF; ' + query],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(apiBase + path, {
    method,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  return { status: response.status, data: await response.json().catch(() => null) }
}

function connect(token) {
  const connection = new signalR.HubConnectionBuilder()
    .withUrl(hubUrl, { accessTokenFactory: () => token })
    .configureLogging(signalR.LogLevel.Warning)
    .build()
  // Mọi client thật đều đăng ký listener; noop tránh cảnh báo ở các connection không được test event.
  connection.on('MessageReceived', () => {})
  connection.on('MessageStatusChanged', () => {})
  connection.on('PresenceChanged', () => {})
  connection.on('TypingChanged', () => {})
  hubs.push(connection)
  return connection
}

function nextMessage(connection, timeoutMs = 5000) {
  return nextEvent(connection, 'MessageReceived', timeoutMs)
}

function nextEvent(connection, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const handler = payload => {
      clearTimeout(timer)
      connection.off(eventName, handler)
      resolve(payload)
    }
    const timer = setTimeout(() => {
      connection.off(eventName, handler)
      reject(new Error(`Timed out waiting for ${eventName}.`))
    }, timeoutMs)
    connection.on(eventName, handler)
  })
}

function check(label, action) {
  action()
  passed++
  console.log('PASS ' + label)
}

try {
  assert.equal(sql("SELECT COUNT(*) FROM dbo.Users WHERE Username IN ('" + names.join("','") + "')"), '0')
  ownNames = true
  for (const username of names) {
    const registered = await api('/users', { method: 'POST', body: {
      username, displayName: 'Kiểm thử ' + username, password,
    } })
    assert.equal(registered.status, 201)
    users.push(registered.data)
    const session = await api('/sessions', { method: 'POST', body: { username, password } })
    assert.equal(session.status, 201)
    tokens.push(session.data.accessToken)
  }

  const created = await api('/conversations', {
    method: 'POST', token: tokens[0], body: { peerUserId: users[1].id },
  })
  assert.equal(created.status, 201)
  const conversationId = created.data.id

  const senderHub = connect(tokens[0])
  const receiverHub = connect(tokens[1])
  const outsiderHub = connect(tokens[2])
  await Promise.all([senderHub.start(), receiverHub.start(), outsiderHub.start()])
  check('Three authenticated clients connect to ChatHub', () => {
    assert.equal(senderHub.state, signalR.HubConnectionState.Connected)
    assert.equal(receiverHub.state, signalR.HubConnectionState.Connected)
  })

  const clientMessageId = randomUUID()
  const receiverEvent = nextMessage(receiverHub)
  const sent = await senderHub.invoke('SendMessage', {
    conversationId, clientMessageId, content: '  Xin chào từ SignalR  ',
  })
  const received = await receiverEvent
  check('Sender receives the saved message and receiver gets MessageReceived', () => {
    assert.equal(sent.content, 'Xin chào từ SignalR')
    assert.equal(sent.clientMessageId, clientMessageId)
    assert.equal(sent.conversationId, conversationId)
    assert.equal(sent.senderId, users[0].id)
    assert.deepEqual(received, sent)
    assert.equal(typeof sent.id, 'string')
    assert.ok(sent.createdAt.endsWith('Z'))
  })

  const histories = await Promise.all([
    api(`/conversations/${conversationId}/messages`, { token: tokens[0] }),
    api(`/conversations/${conversationId}/messages`, { token: tokens[1] }),
  ])
  check('Both members can reload the persisted history', () => {
    assert.ok(histories.every(result => result.status === 200))
    assert.ok(histories.every(result => result.data.items.some(message => message.id === sent.id)))
  })

  const conversationLists = await Promise.all([
    api('/conversations', { token: tokens[0] }),
    api('/conversations', { token: tokens[1] }),
  ])
  check('Conversation list exposes the latest message for its realtime preview', () => {
    const previews = conversationLists.map(result => result.data.items.find(item => item.id === conversationId).lastMessage)
    assert.ok(previews.every(message => message.content === sent.content))
    assert.ok(previews.every(message => message.id === sent.id))
    assert.equal(conversationLists[1].data.items.find(item => item.id === conversationId).unreadCount, 1)
    assert.equal(conversationLists[0].data.items.find(item => item.id === conversationId).peer.isOnline, true)
  })

  const deliveredEvent = nextEvent(senderHub, 'MessageStatusChanged')
  await receiverHub.invoke('AcknowledgeDelivered', {
    conversationId, upToMessageId: sent.id,
  })
  const delivered = await deliveredEvent
  check('Receiver ACK marks the message delivered and not read', () => {
    assert.equal(delivered.conversationId, conversationId)
    assert.equal(delivered.upToMessageId, sent.id)
    assert.equal(delivered.recipientUserId, users[1].id)
    assert.ok(delivered.deliveredAt.endsWith('Z'))
    assert.equal(delivered.readAt, null)
  })

  const readEvent = nextEvent(senderHub, 'MessageStatusChanged')
  await receiverHub.invoke('MarkAsRead', { conversationId, upToMessageId: sent.id })
  const read = await readEvent
  const receiverListAfterRead = await api('/conversations', { token: tokens[1] })
  const historyAfterRead = await api(`/conversations/${conversationId}/messages`, { token: tokens[0] })
  check('Opening the conversation marks incoming messages read and clears unread count', () => {
    assert.ok(read.readAt.endsWith('Z'))
    assert.equal(receiverListAfterRead.data.items.find(item => item.id === conversationId).unreadCount, 0)
    const stored = historyAfterRead.data.items.find(message => message.id === sent.id)
    assert.ok(stored.deliveredAt.endsWith('Z'))
    assert.ok(stored.readAt.endsWith('Z'))
  })

  const typingEvent = nextEvent(receiverHub, 'TypingChanged')
  await senderHub.invoke('StartTyping', { conversationId })
  const typing = await typingEvent
  check('Typing is transient and sent only to the conversation peer', () => {
    assert.deepEqual(typing, { conversationId, userId: users[0].id, isTyping: true })
  })

  const duplicate = await senderHub.invoke('SendMessage', {
    conversationId, clientMessageId, content: 'Xin chào từ SignalR',
  })
  check('Retry with the same ClientMessageId is idempotent', () => {
    assert.equal(duplicate.id, sent.id)
    assert.equal(sql(`SELECT COUNT(*) FROM dbo.Messages WHERE SenderId=${users[0].id} AND ClientMessageId='${clientMessageId}'`), '1')
  })

  await assert.rejects(() => senderHub.invoke('SendMessage', {
    conversationId, clientMessageId, content: 'Payload đã bị đổi',
  }))
  check('The same ClientMessageId cannot be reused with another payload', () =>
    assert.equal(sql(`SELECT Content FROM dbo.Messages WHERE Id=${sent.id}`), 'Xin chào từ SignalR'))

  await assert.rejects(() => outsiderHub.invoke('SendMessage', {
    conversationId, clientMessageId: randomUUID(), content: 'Không có quyền',
  }))
  await assert.rejects(() => outsiderHub.invoke('MarkAsRead', {
    conversationId, upToMessageId: sent.id,
  }))
  await assert.rejects(() => outsiderHub.invoke('StartTyping', { conversationId }))
  const outsiderHistory = await api(`/conversations/${conversationId}/messages`, { token: tokens[2] })
  check('A nonmember cannot send or read messages', () => assert.equal(outsiderHistory.status, 404))

  const extraIds = [randomUUID(), randomUUID()]
  for (const [index, id] of extraIds.entries()) {
    await senderHub.invoke('SendMessage', { conversationId, clientMessageId: id, content: 'Tin ' + (index + 2) })
  }
  const page1 = await api(`/conversations/${conversationId}/messages?limit=2`, { token: tokens[0] })
  const page2 = await api(`/conversations/${conversationId}/messages?limit=2&beforeId=${page1.data.nextCursor}`, { token: tokens[0] })
  check('History pagination returns old-to-new pages without duplicates', () => {
    assert.equal(page1.status, 200)
    assert.equal(page1.data.items.length, 2)
    assert.ok(page1.data.nextCursor)
    assert.equal(page2.data.items.length, 1)
    const ids = [...page1.data.items, ...page2.data.items].map(message => message.id)
    assert.equal(new Set(ids).size, 3)
  })

  const receiverHub2 = connect(tokens[1])
  await receiverHub2.start()
  const noOfflineEvent = nextEvent(senderHub, 'PresenceChanged', 400)
    .then(() => false, () => true)
  await receiverHub.stop()
  const stayedOnline = await noOfflineEvent
  check('Closing one of several connections keeps the account online', () =>
    assert.equal(stayedOnline, true))

  const offlineEvent = nextEvent(senderHub, 'PresenceChanged')
  await receiverHub2.stop()
  const offline = await offlineEvent
  const senderListAfterOffline = await api('/conversations', { token: tokens[0] })
  check('Presence changes only after the receiver loses its final Hub connection', () => {
    assert.equal(offline.userId, users[1].id)
    assert.equal(offline.isOnline, false)
    assert.ok(offline.lastSeenAt.endsWith('Z'))
    const peer = senderListAfterOffline.data.items.find(item => item.id === conversationId).peer
    assert.equal(peer.isOnline, false)
    assert.ok(peer.lastSeenAt.endsWith('Z'))
  })

  console.log(passed + ' checks passed.')
} finally {
  await Promise.allSettled(hubs.map(connection => connection.stop()))
  if (ownNames) {
    const usersQuery = "SELECT Id FROM dbo.Users WHERE Username IN ('" + names.join("','") + "')"
    const conversationsQuery = `SELECT Id FROM dbo.DirectConversations WHERE UserAID IN (${usersQuery}) AND UserBID IN (${usersQuery})`
    sql(`DELETE FROM dbo.Messages WHERE ConversationId IN (${conversationsQuery}); DELETE FROM dbo.DirectConversations WHERE Id IN (${conversationsQuery}); DELETE FROM dbo.Users WHERE Username IN ('${names.join("','")}')`)
    console.log('Removed only accounts, messages and conversations created by this run.')
  }
}

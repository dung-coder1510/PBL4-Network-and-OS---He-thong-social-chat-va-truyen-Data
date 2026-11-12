// Run only against an isolated local database explicitly named PBL4_AdminTest_*.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const origin = process.env.ADMIN_TEST_ORIGIN
const database = process.env.AUTH_TEST_DATABASE
const server = process.env.AUTH_TEST_SQL_SERVER
if (!origin || !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname) ||
    !/^PBL4_AdminTest_[a-f0-9]+$/.test(database || '') || !server)
  throw new Error('Use an isolated local PBL4_AdminTest_* database and ADMIN_TEST_ORIGIN.')
const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const signalR = require('@microsoft/signalr')
const prefix = 'adm_' + randomUUID().replaceAll('-', '').slice(0, 10)
const password = randomUUID()
const users = []
const hubs = []
function sql(query) {
  return execFileSync('sqlcmd', ['-S', server, '-d', database, '-E', '-C', '-b', '-l', '5', '-h', '-1', '-W', '-Q',
    'SET NOCOUNT ON; SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON; SET ANSI_PADDING ON; SET ANSI_WARNINGS ON; ' +
    'SET CONCAT_NULL_YIELDS_NULL ON; SET ARITHABORT ON; SET NUMERIC_ROUNDABORT OFF; ' + query],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
async function api(path, token, body, method = body ? 'POST' : 'GET') {
  const result = await fetch(origin + '/api/v1' + path, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) })
  return { status: result.status, data: await result.json().catch(() => null) }
}
async function login(user) {
  const result = await api('/sessions', null, { username: user.username, password })
  assert.equal(result.status, 201)
  return result.data.accessToken
}
async function hub(token) {
  const instance = new signalR.HubConnectionBuilder().withUrl(origin + '/hubs/chat', { accessTokenFactory: () => token })
    .configureLogging(signalR.LogLevel.None).build()
  hubs.push(instance)
  await instance.start(); await instance.invoke('Heartbeat')
  return instance
}
const passed = label => console.log('PASS ' + label)
try {
  for (const suffix of ['admin', 'other', 'user', 'peer', 'outsider']) {
    const username = prefix + '_' + suffix
    const created = await api('/users', null, { username, displayName: `Admin test ${suffix}`, password })
    assert.equal(created.status, 201)
    assert.equal(sql(`SELECT Id FROM dbo.Users WHERE Username=N'${username}'`), String(created.data.id), 'API must use the isolated database')
    users.push(created.data)
  }
  const [admin, other, target, peer, outsider] = users
  sql(`UPDATE dbo.Users SET Role='Admin' WHERE Id IN (${admin.id},${other.id})`)
  const adminToken = await login(admin)
  const otherToken = await login(other)
  const userToken = await login(target)
  const offlineToken = await login(target)
  const secondOfflineToken = await login(target)
  const peerToken = await login(peer)
  const outsiderToken = await login(outsider)
  assert.equal((await api('/admin/users')).status, 401)
  assert.equal((await api('/admin/users', userToken)).status, 403)
  passed('Admin endpoints enforce authentication and role at the server')
  const overview = await api('/admin/overview', adminToken)
  assert.equal(overview.data.total, 5)
  const first = await api('/admin/users?limit=2', adminToken)
  const next = await api(`/admin/users?limit=2&afterId=${first.data.nextCursor}`, adminToken)
  assert.equal(first.data.total, 5)
  assert.ok(first.data.items.every(a => next.data.items.every(b => b.id !== a.id)))
  assert.ok(!JSON.stringify(first.data).includes('passwordHash'))
  assert.equal((await api(`/admin/users?search=${target.username}`, adminToken)).data.items[0].id, target.id)
  passed('Account search, bounded pagination, statistics and safe DTOs work')

  const userHub = await hub(userToken)
  const peerHub = await hub(peerToken)
  assert.equal((await api(`/admin/users/${target.id}/connections`)).status, 401)
  assert.equal((await api(`/admin/users/${target.id}/connections`, userToken)).status, 403)
  const connections = await api(`/admin/users/${target.id}/connections`, adminToken)
  assert.equal(connections.status, 200)
  assert.equal(connections.data.userId, target.id)
  assert.equal(connections.data.total, 1)
  assert.equal(connections.data.connections[0].id, userHub.connectionId)
  assert.ok(connections.data.connections.every(link => link.userId === String(target.id)))
  assert.equal((await api(`/admin/users/${outsider.id}/connections`, adminToken)).data.total, 0)
  assert.equal((await api('/admin/users/2147483647/connections', adminToken)).status, 404)
  passed('Profile connections enforce Admin access and return only the selected account')
  const secondHub = await hub(offlineToken)
  assert.equal((await api('/admin/overview', adminToken)).data.online, 2)
  const chat = await api('/conversations', userToken, { peerUserId: peer.id })
  const message = await userHub.invoke('SendMessage', { conversationId: chat.data.id, clientMessageId: randomUUID(), content: 'Preserve history after disabling' })
  const transfer = await userHub.invoke('OfferFile', { conversationId: chat.data.id, clientTransferId: randomUUID(),
    fileName: 'test.bin', fileSizeBytes: 10, sha256Hex: 'ab'.repeat(32) })
  let unavailable = false
  let availability = false
  userHub.on('AccountUnavailable', () => { unavailable = true })
  peerHub.on('AccountAvailabilityChanged', () => { availability = true })
  let detail = (await api(`/admin/users/${target.id}`, adminToken)).data
  const originalVersion = detail.user.version
  const blank = await api(`/admin/users/${target.id}/disable`, adminToken,
    { requestId: randomUUID(), expectedVersion: originalVersion, reason: '   ' })
  assert.equal(blank.status, 400)
  const forbid = await api(`/admin/users/${other.id}/disable`, adminToken,
    { requestId: randomUUID(), expectedVersion: (await api(`/admin/users/${other.id}`, adminToken)).data.user.version, reason: 'Forbidden target' })
  assert.equal(forbid.status, 409)
  passed('Online counts users rather than tabs; blank reasons and Admin targets are rejected')

  sql(`UPDATE dbo.Users SET LastSeenAt=SYSUTCDATETIME() WHERE Id=${target.id}`)
  const stale = await api(`/admin/users/${target.id}/disable`, adminToken,
    { requestId: randomUUID(), expectedVersion: originalVersion, reason: 'Stale version' })
  assert.equal(stale.status, 409)
  detail = (await api(`/admin/users/${target.id}`, adminToken)).data
  const attempted = { requestId: randomUUID(), expectedVersion: detail.user.version, reason: 'SIMULATE_AUDIT_FAILURE' }
  sql("EXEC(N'CREATE TRIGGER dbo.TR_AdminTest_AuditFailure ON dbo.AdminAuditLogs AFTER INSERT AS BEGIN IF EXISTS(SELECT 1 FROM inserted WHERE Reason=N''SIMULATE_AUDIT_FAILURE'') THROW 53001, ''Simulated audit failure'', 1; END;')")
  try {
    assert.equal((await api(`/admin/users/${target.id}/disable`, adminToken, attempted)).status, 503)
    assert.equal(sql(`SELECT CONCAT(IsDisabled,':',SessionVersion) FROM dbo.Users WHERE Id=${target.id}`), '0:0')
    assert.equal(sql(`SELECT COUNT(*) FROM dbo.AdminAuditLogs WHERE TargetUserId=${target.id}`), '0')
    assert.equal((await api('/users/me', userToken)).status, 200)
  } finally { sql('DROP TRIGGER dbo.TR_AdminTest_AuditFailure') }
  passed('RowVersion conflicts are reported; an audit failure rolls back the entire SQL change')

  detail = (await api(`/admin/users/${target.id}`, adminToken)).data
  const change = { requestId: randomUUID(), expectedVersion: detail.user.version, reason: 'Account handling test' }
  const disabled = await api(`/admin/users/${target.id}/disable`, adminToken, change)
  assert.equal(disabled.status, 200)
  assert.equal(disabled.data.user.isDisabled, true)
  assert.equal(disabled.data.runtimeCleanupPending, false)
  assert.equal((await api('/admin/overview', adminToken)).data.online, 1)
  for (const token of [userToken, offlineToken, secondOfflineToken]) assert.equal((await api('/users/me', token)).status, 401)
  assert.equal((await api('/sessions', null, { username: target.username, password })).status, 403)
  await assert.rejects(userHub.invoke('SendMessage', { conversationId: chat.data.id, clientMessageId: randomUUID(), content: 'Blocked' }))
  assert.equal(sql(`SELECT COUNT(*) FROM dbo.FileTransfers WHERE Id=${transfer.id} AND FinishedAt IS NOT NULL`), '1')
  assert.ok(unavailable && availability)
  passed('Disabling revokes all tabs and dormant sessions, updates presence, closes a transfer and notifies clients')
  const repeated = await api(`/admin/users/${target.id}/disable`, adminToken, change)
  assert.equal(repeated.status, 200)
  assert.equal(repeated.data.replayed, true)
  assert.equal(sql(`SELECT COUNT(*) FROM dbo.AdminAuditLogs WHERE TargetUserId=${target.id}`), '1')
  assert.equal((await api(`/admin/users/${target.id}/disable`, adminToken, { ...change, reason: 'Different payload' })).status, 400)
  assert.equal((await api(`/admin/users?state=disabled&search=${target.username}`, adminToken)).data.items.length, 1)
  assert.equal((await api(`/conversations/${chat.data.id}/messages`, peerToken)).data.items[0].id, message.id)
  assert.equal((await api(`/conversations/${chat.data.id}/messages`, outsiderToken)).status, 404)
  passed('Retries are idempotent, payload reuse is rejected, and disabling preserves private history')

  detail = (await api(`/admin/users/${target.id}`, adminToken)).data
  const enabled = await api(`/admin/users/${target.id}/enable`, otherToken,
    { requestId: randomUUID(), expectedVersion: detail.user.version, reason: 'Account reviewed' })
  assert.equal(enabled.status, 200)
  for (const token of [userToken, offlineToken, secondOfflineToken]) assert.equal((await api('/users/me', token)).status, 401)
  const freshToken = await login(target)
  const oldReplay = await api(`/admin/users/${target.id}/disable`, adminToken, change)
  assert.equal(oldReplay.data.replayed, true)
  assert.equal(oldReplay.data.user.isDisabled, false)
  assert.equal((await api('/users/me', freshToken)).status, 200)
  const logs = await api(`/admin/audit-logs?userId=${target.id}`, adminToken)
  assert.equal(logs.data.items.length, 2)
  assert.equal(logs.data.items[0].action, 'EnableUser')
  assert.equal((await api(`/admin/audit-logs?target=${target.username}&action=DisableUser`, adminToken)).data.items.length, 1)
  assert.throws(() => sql(`UPDATE dbo.AdminAuditLogs SET Reason=N'Edited' WHERE TargetUserId=${target.id}`))
  passed('Unlock requires a new login; historical replays do not revoke new sessions; audit is filterable and append-only')

  const freshHub = await hub(freshToken)
  for (let i = 0; i < 8; i++) await freshHub.invoke('ReportFileObservation', { transferId: '999999999', stage: 'channel-open', bytes: 0 })
  await assert.rejects(freshHub.invoke('ReportFileObservation', { transferId: '999999999', stage: 'channel-open', bytes: 0 }))
  const metrics = (await api('/admin/monitoring', adminToken)).data.metrics
  const reportMetric = metrics.operations.find(item => item.operation === 'ReportFileObservation')
  assert.equal(reportMetric.count, 9)
  assert.equal(reportMetric.rejected, 1)
  passed('Monitoring includes rate-limited Hub calls in request/rejection totals')

  sql(`UPDATE dbo.Users SET SessionVersion=SessionVersion+1 WHERE Id=${target.id}`)
  assert.equal((await api('/users/me', freshToken)).status, 401)
  passed('Persistent session version rejects a signed old JWT even without cache-wide revocation')

  const outsiderDetail = (await api(`/admin/users/${outsider.id}`, adminToken)).data.user
  const concurrent = await Promise.all([adminToken, otherToken].map((token, index) => api(`/admin/users/${outsider.id}/disable`, token,
    { requestId: randomUUID(), expectedVersion: outsiderDetail.version, reason: `Concurrent decision ${index}` })))
  assert.deepEqual(concurrent.map(x => x.status).sort(), [200, 409])
  assert.equal(sql(`SELECT COUNT(*) FROM dbo.AdminAuditLogs WHERE TargetUserId=${outsider.id}`), '1')
  passed('Two administrators updating the same account produce one change and one audit')

  const beforeRace = (await api(`/admin/users/${target.id}`, adminToken)).data.user
  const [banRace, loginRace] = await Promise.all([
    api(`/admin/users/${target.id}/disable`, adminToken, { requestId: randomUUID(), expectedVersion: beforeRace.version, reason: 'Concurrent login revocation' }),
    api('/sessions', null, { username: target.username, password }),
  ])
  assert.equal(banRace.status, 200)
  assert.ok([201, 403].includes(loginRace.status))
  const afterRace = (await api(`/admin/users/${target.id}`, adminToken)).data.user
  assert.equal((await api(`/admin/users/${target.id}/enable`, adminToken,
    { requestId: randomUUID(), expectedVersion: afterRace.version, reason: 'Finish concurrent login check' })).status, 200)
  if (loginRace.status === 201) assert.equal((await api('/users/me', loginRace.data.accessToken)).status, 401)
  passed('Login racing with a disable cannot produce a surviving old session after unlock')

  const sharedId = randomUUID()
  const pair = await Promise.all([target, peer].map(async user => {
    const current = (await api(`/admin/users/${user.id}`, adminToken)).data.user
    return api(`/admin/users/${user.id}/disable`, adminToken,
      { requestId: sharedId, expectedVersion: current.version, reason: 'Cross-target request ID race' })
  }))
  assert.deepEqual(pair.map(x => x.status).sort(), [200, 409])
  assert.equal(sql(`SELECT COUNT(*) FROM dbo.Users WHERE Id IN (${target.id},${peer.id}) AND IsDisabled=1`), '1')
  assert.equal(sql(`SELECT COUNT(*) FROM dbo.AdminAuditLogs WHERE RequestId='${sharedId}'`), '1')
  passed('Concurrent reuse of a request ID across targets rolls back the losing account change')
} finally {
  await Promise.allSettled(hubs.map(connection => connection.stop()))
}

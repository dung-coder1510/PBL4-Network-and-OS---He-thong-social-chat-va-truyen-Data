// API thật + DB local có sẵn. Chỉ tạo và dọn tài khoản/cuộc trò chuyện riêng của lượt chạy.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const base = process.env.AUTH_TEST_API_URL || 'http://127.0.0.1:5173/api/v1'
const server = process.env.AUTH_TEST_SQL_SERVER
const database = process.env.AUTH_TEST_DATABASE
if (!server || !database) throw new Error('Set AUTH_TEST_SQL_SERVER and AUTH_TEST_DATABASE.')
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Local API only.')
const prefix = 'convtest_' + randomUUID().replaceAll('-', '').slice(0, 12)
const names = ['a', 'b', 'c'].map(suffix => prefix + '_' + suffix)
const password = randomUUID()
const users = []
const tokens = []
let ownNames = false
let passed = 0
function sql(query) {
  return execFileSync('sqlcmd', ['-S', server, '-d', database, '-E', '-C', '-b', '-l', '5', '-h', '-1', '-W', '-Q', 'SET NOCOUNT ON; ' + query], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(base + path, { method,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) })
  return { status: response.status, data: await response.json().catch(() => null), location: response.headers.get('location') }
}
function check(label, action) { action(); passed++; console.log('PASS ' + label) }
const create = (index, peerUserId, extras = {}) => api('/conversations', { method: 'POST', token: tokens[index], body: { peerUserId, ...extras } })
const list = (index, query = '') => api('/conversations' + query, { token: tokens[index] })
const details = (index, id) => api('/conversations/' + id, { token: tokens[index] })
const search = (index, term) => api('/users?search=' + encodeURIComponent(term), { token: tokens[index] })
try {
  assert.equal(sql("SELECT COUNT(*) FROM dbo.Users WHERE Username IN ('" + names.join("','") + "')"), '0')
  ownNames = true
  for (const username of names) {
    const registered = await api('/users', { method: 'POST', body: { username, displayName: 'Kiểm thử ' + username, password } })
    assert.equal(registered.status, 201, 'Test registration')
    users.push(registered.data)
    const loggedIn = await api('/sessions', { method: 'POST', body: { username, password } })
    assert.equal(loggedIn.status, 201, 'Test login')
    tokens.push(loggedIn.data.accessToken)
  }
  const protectedResults = await Promise.all([
    api('/conversations'), api('/conversations/1'), api('/users?search=test'),
    api('/conversations', { method: 'POST', body: { peerUserId: users[1].id } }),
  ])
  check('All conversation and search routes require authentication', () => assert.ok(protectedResults.every(r => r.status === 401)))
  const found = await search(0, prefix.toUpperCase())
  check('Search matches username without case and excludes self', () => {
    assert.equal(found.status, 200)
    assert.deepEqual(found.data.map(u => u.id).sort(), [users[1].id, users[2].id].sort())
    assert.deepEqual(Object.keys(found.data[0]).sort(), [
      'avatarPath', 'displayName', 'id', 'isDisabled', 'isOnline', 'lastSeenAt', 'username',
    ])
  })
  const displaySearch = await search(0, 'Kiểm thử ' + names[1])
  check('Search matches Vietnamese display name', () => assert.equal(displaySearch.data[0].id, users[1].id))
  const emptySearch = await search(0, ' ')
  const longSearch = await search(0, 'x'.repeat(101))
  check('Search is bounded and validates length', () => { assert.deepEqual(emptySearch.data, []); assert.equal(longSearch.status, 400) })
  const self = await create(0, users[0].id)
  const invalid = await create(0, 0)
  const missing = await create(0, 2147483647)
  check('Reject self, invalid ID and missing user', () => { assert.equal(self.status, 400); assert.equal(invalid.status, 400); assert.equal(missing.status, 404) })
  sql("UPDATE dbo.Users SET IsDisabled=1 WHERE Username='" + names[2] + "'")
  const blockedSearch = await search(0, names[2])
  const blockedCreate = await create(0, users[2].id)
  check('Disabled users are hidden and cannot be selected', () => { assert.deepEqual(blockedSearch.data, []); assert.equal(blockedCreate.status, 404) })
  sql("UPDATE dbo.Users SET IsDisabled=0 WHERE Username='" + names[2] + "'")
  const concurrent = await Promise.all([
    create(0, users[1].id, { userAID: users[2].id, userBID: users[2].id }),
    create(1, users[0].id),
  ])
  const ab = concurrent[0].data.id
  check('Opposite-side concurrent creation returns one conversation', () => {
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 201])
    assert.equal(concurrent[1].data.id, ab)
    assert.equal(typeof ab, 'string')
    assert.equal(concurrent[0].data.peer.id, users[1].id)
    assert.equal(concurrent[1].data.peer.id, users[0].id)
    assert.equal(concurrent[0].data.hasMessages, false)
    assert.equal(concurrent[0].data.lastMessage, null)
    assert.equal(concurrent[0].data.unreadCount, 0)
    assert.ok(concurrent[0].data.createdAt.endsWith('Z'))
    assert.ok(concurrent.find(r => r.status === 201).location.endsWith('/api/v1/conversations/' + ab))
  })
  check('DB stores normalized A/B and no duplicate', () => assert.equal(sql("SELECT COUNT(*) FROM dbo.DirectConversations WHERE UserAID=" + Math.min(users[0].id, users[1].id) + ' AND UserBID=' + Math.max(users[0].id, users[1].id)), '1'))
  const repeat = await create(0, users[1].id)
  check('Repeated create reopens existing conversation', () => { assert.equal(repeat.status, 200); assert.equal(repeat.data.id, ab) })
  const bothLists = await Promise.all([list(0), list(1)])
  check('Both participants see the saved conversation', () => {
    assert.ok(bothLists.every(r => r.status === 200 && r.data.items.some(c => c.id === ab)))
  })
  const bothDetails = await Promise.all([details(0, ab), details(1, ab)])
  check('Detail identifies the other participant for each side', () => {
    assert.equal(bothDetails[0].data.peer.id, users[1].id); assert.equal(bothDetails[1].data.peer.id, users[0].id)
  })
  const outsider = await details(2, ab)
  const outsiderList = await list(2)
  const nonexistent = await details(2, '9223372036854775807')
  check('Nonmember cannot read or discover conversation', () => {
    assert.equal(outsider.status, 404); assert.equal(nonexistent.status, 404)
    assert.equal(outsider.data.title, nonexistent.data.title)
    assert.deepEqual(outsiderList.data.items, [])
  })
  sql("UPDATE dbo.Users SET Role='Admin' WHERE Username='" + names[2] + "'")
  const adminOutsider = await details(2, ab)
  check('Admin role does not bypass conversation privacy', () => assert.equal(adminOutsider.status, 404))
  const ac = await create(0, users[2].id)
  assert.equal(ac.status, 201)
  const page1 = await list(0, '?limit=1')
  const page2 = await list(0, '?limit=1&beforeId=' + page1.data.nextCursor)
  check('Cursor pagination is ordered and has no duplicate', () => {
    assert.equal(page1.data.items[0].id, ac.data.id)
    assert.equal(page2.data.items[0].id, ab)
    assert.equal(page2.data.nextCursor, null)
  })
  const filtered = await list(0, '?search=' + names[1])
  check('Conversation search uses the peer, not current user', () => assert.deepEqual(filtered.data.items.map(c => c.id), [ab]))
  const invalidLimit = await list(0, '?limit=101')
  const invalidCursor = await list(0, '?beforeId=-1')
  check('Pagination rejects invalid bounds', () => { assert.equal(invalidLimit.status, 400); assert.equal(invalidCursor.status, 400) })
  await api('/sessions/current', { method: 'DELETE', token: tokens[0] })
  const newSession = await api('/sessions', { method: 'POST', body: { username: names[0], password } })
  assert.equal(newSession.status, 201)
  tokens[0] = newSession.data.accessToken
  const persisted = await list(0)
  check('Conversation survives logout and login', () => assert.ok(persisted.data.items.some(c => c.id === ab)))
  check('Creating a conversation does not insert messages', () => assert.equal(sql("SELECT COUNT(*) FROM dbo.Messages WHERE ConversationId IN (SELECT Id FROM dbo.DirectConversations WHERE UserAID IN (" + users.map(u => u.id).join(',') + ') AND UserBID IN (' + users.map(u => u.id).join(',') + '))'), '0'))
  console.log(passed + ' checks passed.')
} finally {
  if (ownNames) {
    const subquery = "SELECT Id FROM dbo.Users WHERE Username IN ('" + names.join("','") + "')"
    sql('DELETE FROM dbo.DirectConversations WHERE UserAID IN (' + subquery + ') AND UserBID IN (' + subquery + "); DELETE FROM dbo.Users WHERE Username IN ('" + names.join("','") + "')")
    console.log('Removed only accounts and conversations created by this run.')
  }
}

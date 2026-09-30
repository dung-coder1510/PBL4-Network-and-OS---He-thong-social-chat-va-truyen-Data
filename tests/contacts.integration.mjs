// API danh bạ thật trên SQL Server local; chỉ tạo và xóa dữ liệu có prefix riêng.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const base = process.env.AUTH_TEST_API_URL || 'http://127.0.0.1:5173/api/v1'
const server = process.env.AUTH_TEST_SQL_SERVER
const database = process.env.AUTH_TEST_DATABASE
if (!server || !database) throw new Error('Set AUTH_TEST_SQL_SERVER and AUTH_TEST_DATABASE.')
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Local API only.')

const prefix = 'contacttest_' + randomUUID().replaceAll('-', '').slice(0, 10)
const names = ['a', 'b', 'c'].map(suffix => prefix + '_' + suffix)
const password = randomUUID()
const users = []
const tokens = []
let ownUsers = false
let passed = 0

function sql(query) {
  return execFileSync('sqlcmd', ['-S', server, '-d', database, '-E', '-C', '-b', '-l', '5',
    '-h', '-1', '-W', '-Q', 'SET NOCOUNT ON; ' + query],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  return { status: response.status, data: await response.json().catch(() => null) }
}

function check(label, action) {
  action()
  passed++
  console.log('PASS ' + label)
}

try {
  assert.equal(sql("SELECT COUNT(*) FROM dbo.Users WHERE Username IN ('" + names.join("','") + "')"), '0')
  ownUsers = true
  for (const username of names) {
    const registered = await api('/users', { method: 'POST', body: {
      username, displayName: 'Liên hệ ' + username, password,
    } })
    assert.equal(registered.status, 201)
    users.push(registered.data)
    const session = await api('/sessions', { method: 'POST', body: { username, password } })
    assert.equal(session.status, 201)
    tokens.push(session.data.accessToken)
  }

  const anonymous = await api('/contacts')
  const empty = await api('/contacts', { token: tokens[0] })
  check('Contact routes require authentication and start empty', () => {
    assert.equal(anonymous.status, 401)
    assert.deepEqual(empty.data, [])
  })

  const self = await api('/contacts', {
    method: 'POST', token: tokens[0], body: { contactUserId: users[0].id },
  })
  const missing = await api('/contacts', {
    method: 'POST', token: tokens[0], body: { contactUserId: 2147483647 },
  })
  check('Cannot add self or a missing user', () => {
    assert.equal(self.status, 400)
    assert.equal(missing.status, 404)
  })

  const created = await api('/contacts', {
    method: 'POST', token: tokens[0],
    body: { contactUserId: users[1].id, alias: '  Bạn B  ' },
  })
  check('Create trims alias and returns public user data', () => {
    assert.equal(created.status, 201)
    assert.equal(created.data.alias, 'Bạn B')
    assert.equal(created.data.user.id, users[1].id)
    assert.equal(created.data.user.passwordHash, undefined)
    assert.equal(typeof created.data.user.isOnline, 'boolean')
  })

  const repeated = await api('/contacts', {
    method: 'POST', token: tokens[0],
    body: { contactUserId: users[1].id, alias: 'Không ghi đè' },
  })
  const reverseList = await api('/contacts', { token: tokens[1] })
  check('Create is idempotent and contacts remain one-way', () => {
    assert.equal(repeated.status, 200)
    assert.equal(repeated.data.alias, 'Bạn B')
    assert.deepEqual(reverseList.data, [])
    assert.equal(sql(`SELECT COUNT(*) FROM dbo.Contacts WHERE UserId=${users[0].id} AND ContactUserId=${users[1].id}`), '1')
  })

  const updated = await api('/contacts/' + users[1].id, {
    method: 'PUT', token: tokens[0], body: { alias: '  ' },
  })
  check('Alias can be cleared without deleting the contact', () => {
    assert.equal(updated.status, 200)
    assert.equal(updated.data.alias, null)
  })

  const removed = await api('/contacts/' + users[1].id, {
    method: 'DELETE', token: tokens[0],
  })
  const removedAgain = await api('/contacts/' + users[1].id, {
    method: 'DELETE', token: tokens[0],
  })
  check('Delete removes only the current user contact', () => {
    assert.equal(removed.status, 204)
    assert.equal(removedAgain.status, 404)
  })

  console.log(passed + ' checks passed.')
} finally {
  if (ownUsers) {
    const subquery = "SELECT Id FROM dbo.Users WHERE Username IN ('" + names.join("','") + "')"
    sql(`DELETE FROM dbo.Contacts WHERE UserId IN (${subquery}) OR ContactUserId IN (${subquery}); DELETE FROM dbo.Users WHERE Username IN ('${names.join("','")}')`)
    console.log('Removed only contacts and accounts created by this run.')
  }
}

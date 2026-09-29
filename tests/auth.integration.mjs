// Chạy với API đang mở và SQL Server local. Không tạo DB, không sửa user có sẵn.
// Mỗi lượt tạo username ngẫu nhiên; finally chỉ xóa đúng các username của lượt đó.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const base = process.env.AUTH_TEST_API_URL || 'http://127.0.0.1:5173/api/v1'
const sqlServer = process.env.AUTH_TEST_SQL_SERVER
const database = process.env.AUTH_TEST_DATABASE
if (!sqlServer || !database) throw new Error('Set AUTH_TEST_SQL_SERVER and AUTH_TEST_DATABASE to the existing local database.')
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Local API only.')
const username = 'authtest_' + randomUUID().replaceAll('-', '').slice(0, 16)
const raceName = username + '_r'
const password = ' ' + randomBytes(18).toString('base64url') + ' '
const registration = { username, displayName: ' Kiểm thử xác thực ', password }
const names = [username, raceName]
let passed = 0
let ownsTestNames = false

function sql(query) {
  return execFileSync('sqlcmd', ['-S', sqlServer, '-d', database, '-E', '-C', '-l', '5', '-b', '-h', '-1', '-W', '-Q', 'SET NOCOUNT ON; ' + query], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
async function api(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(base + path, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  })
  return { status: response.status, headers: response.headers, data: await response.json().catch(() => null) }
}
function check(label, fn) { fn(); passed++; console.log('PASS ' + label) }
const login = (body = { username, password }) => api('/sessions', { method: 'POST', body })
const me = token => api('/users/me', { token })
try {
  assert.equal(sql("SELECT COUNT(*) FROM dbo.Users WHERE Username IN ('" + names.join("','") + "')"), '0', 'Test usernames must not preexist.')
  ownsTestNames = true
  const anon = await me()
  check('Anonymous profile is rejected', () => assert.equal(anon.status, 401))
  for (const [label, overrides] of [
    ['short password', { password: '123' }],
    ['oversized password', { password: 'x'.repeat(129) }],
    ['invalid username', { username: 'bad user!' }],
    ['empty display name', { displayName: '   ' }],
  ]) {
    const result = await api('/users', { method: 'POST', body: { ...registration, ...overrides } })
    check('Validation: ' + label, () => assert.equal(result.status, 400))
  }
  const created = await api('/users', { method: 'POST', body: { ...registration, role: 'Admin', isDisabled: true, avatarPath: '/injected.png' } })
  check('Registration uses server-owned defaults and safe DTO', () => {
    assert.equal(created.status, 201)
    assert.deepEqual(Object.keys(created.data).sort(), ['avatarPath', 'displayName', 'id', 'role', 'username'])
    assert.equal(created.data.role, 'User')
    assert.equal(created.data.avatarPath, null)
    assert.equal(created.data.displayName, registration.displayName.trim())
  })
  // Kiểm tra hình thức lưu mật khẩu, không đọc/ghi hash ra log.
  check('SQL persists a hashed password', () => assert.equal(sql("SELECT CASE WHEN LEN(PasswordHash) > 60 AND PasswordHash LIKE 'AQAAAA%' THEN 1 ELSE 0 END FROM dbo.Users WHERE Username='" + username + "'"), '1'))
  const duplicate = await api('/users', { method: 'POST', body: { ...registration, username: username.toUpperCase() } })
  check('Case-insensitive duplicate is rejected', () => assert.equal(duplicate.status, 409))
  const races = await Promise.all([1, 2].map(() => api('/users', { method: 'POST', body: { ...registration, username: raceName } })))
  check('Concurrent duplicate creates exactly one account', () => assert.deepEqual(races.map(r => r.status).sort(), [201, 409]))
  const bad = await login({ username, password: 'wrong password' })
  const missing = await login({ username: 'missing_' + randomBytes(5).toString('hex'), password })
  check('Wrong credentials use the same generic response', () => {
    assert.equal(bad.status, 401); assert.equal(missing.status, 401)
    assert.equal(bad.data.code, missing.data.code); assert.equal(bad.data.title, missing.data.title)
  })
  const trimmed = await login({ username, password: password.trim() })
  check('Password whitespace is significant', () => assert.equal(trimmed.status, 401))
  const first = await login({ username: username.toUpperCase(), password })
  const second = await login()
  check('Login creates independent 30-minute sessions', () => {
    assert.equal(first.status, 201); assert.equal(second.status, 201)
    assert.notEqual(first.data.sessionId, second.data.sessionId)
    const seconds = (Date.parse(first.data.expiresAt) - Date.now()) / 1000
    assert.ok(seconds > 1750 && seconds <= 1800)
  })
  const token = first.data.accessToken
  const profile = await me(token)
  check('Bearer profile returns current DB user with no-store', () => {
    assert.equal(profile.status, 200); assert.equal(profile.data.id, created.data.id)
    assert.equal(profile.headers.get('cache-control'), 'no-store')
  })
  const segments = token.split('.')
  segments[2] = (segments[2][0] === 'A' ? 'B' : 'A') + segments[2].slice(1)
  const tampered = await me(segments.join('.'))
  check('JWT with modified signature is rejected', () => assert.equal(tampered.status, 401))
  sql("UPDATE dbo.Users SET Role='Admin' WHERE Username='" + username + "'")
  const changed = await me(token)
  check('Profile follows role changes in DB', () => { assert.equal(changed.status, 200); assert.equal(changed.data.role, 'Admin') })
  sql("UPDATE dbo.Users SET Role='User' WHERE Username='" + username + "'")
  const logout = await api('/sessions/current', { method: 'DELETE', token })
  const revoked = await me(token)
  const remaining = await me(second.data.accessToken)
  check('Logout revokes only the current session', () => {
    assert.equal(logout.status, 204); assert.equal(revoked.status, 401); assert.equal(remaining.status, 200)
  })
  sql("UPDATE dbo.Users SET IsDisabled=1 WHERE Username='" + username + "'")
  const disabled = await login()
  const blockedToken = await me(second.data.accessToken)
  check('Disabled user cannot log in or use existing token', () => {
    assert.equal(disabled.status, 403); assert.equal(disabled.data.code, 'ACCOUNT_DISABLED')
    assert.equal(blockedToken.status, 401)
  })
  sql("UPDATE dbo.Users SET IsDisabled=0 WHERE Username='" + username + "'")
  const stillRevoked = await me(second.data.accessToken)
  check('Unlocking does not restore a revoked session', () => assert.equal(stillRevoked.status, 401))
  let throttled
  for (let i = 0; i < 21; i++) {
    throttled = await login({ username, password: 'wrong password' })
    if (throttled.status === 429) break
  }
  check('Login rate limit returns 429 and Retry-After', () => {
    assert.equal(throttled.status, 429); assert.ok(Number(throttled.headers.get('retry-after')) > 0)
  })
  console.log(passed + ' checks passed.')
} finally {
  if (ownsTestNames) {
    sql("DELETE FROM dbo.Users WHERE Username IN ('" + names.join("','") + "')")
    console.log('Removed only the temporary accounts from this run.')
  }
}

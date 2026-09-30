// Kiểm thử hai phiên trình duyệt thật: A gửi cho B, B thấy ngay và trả lời được.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const runtimeModules = process.env.CODEX_NODE_MODULES
if (!runtimeModules) throw new Error('Set CODEX_NODE_MODULES to a node_modules directory containing Playwright.')
const runtimeRequire = createRequire(path.join(runtimeModules, 'package.json'))
const { chromium } = runtimeRequire('playwright')

const webOrigin = process.env.CHAT_UI_ORIGIN || 'http://127.0.0.1:5173'
const apiBase = webOrigin + '/api/v1'
const server = process.env.AUTH_TEST_SQL_SERVER
const database = process.env.AUTH_TEST_DATABASE
if (!server || !database) throw new Error('Set AUTH_TEST_SQL_SERVER and AUTH_TEST_DATABASE.')
if (!['localhost', '127.0.0.1'].includes(new URL(webOrigin).hostname)) throw new Error('Local web server only.')

const prefix = 'uitest_' + randomUUID().replaceAll('-', '').slice(0, 12)
const names = [prefix + '_a', prefix + '_b']
const displays = ['Kiểm thử A', 'Kiểm thử B']
const password = 'Ui-test-' + randomUUID()
let browser
let ownUsers = false

function sql(query) {
  return execFileSync('sqlcmd', ['-S', server, '-d', database, '-E', '-C', '-b', '-l', '5',
    '-h', '-1', '-W', '-Q', 'SET NOCOUNT ON; SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON; ' +
      'SET ANSI_PADDING ON; SET ANSI_WARNINGS ON; SET CONCAT_NULL_YIELDS_NULL ON; ' +
      'SET ARITHABORT ON; SET NUMERIC_ROUNDABORT OFF; ' + query],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function api(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(apiBase + pathname, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  return { status: response.status, data: await response.json().catch(() => null) }
}

async function login(page, username) {
  await page.goto(webOrigin, { waitUntil: 'networkidle' })
  await page.getByLabel('Tên đăng nhập').fill(username)
  await page.getByLabel('Mật khẩu').fill(password)
  await page.getByRole('button', { name: 'Đăng nhập' }).click()
  await page.locator('.conv-list h2').getByText('Trò chuyện', { exact: true }).waitFor()
}

try {
  assert.equal(sql("SELECT COUNT(*) FROM dbo.Users WHERE Username IN ('" + names.join("','") + "')"), '0')
  ownUsers = true
  for (let index = 0; index < names.length; index++) {
    const registered = await api('/users', { method: 'POST', body: {
      username: names[index], displayName: displays[index], password,
    } })
    assert.equal(registered.status, 201)
  }

  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  // Tái hiện trình duyệt mở qua IP LAN/HTTP, nơi randomUUID có thể không được cung cấp.
  await contextB.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true })
  })
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  await Promise.all([login(pageA, names[0]), login(pageB, names[1])])

  await pageA.getByRole('button', { name: 'Cuộc trò chuyện mới' }).first().click()
  await pageA.getByLabel('Tìm người để trò chuyện').fill(names[1])
  const person = pageA.locator('.conversation-person').filter({ hasText: '@' + names[1] })
  await person.waitFor()
  await person.click()
  await pageA.getByRole('dialog').getByRole('button', { name: 'Bắt đầu trò chuyện' }).click()
  await pageA.locator('textarea').waitFor({ state: 'visible' })
  await pageA.locator('textarea').fill('Tin nhắn realtime từ A')
  await pageA.locator('textarea').press('Enter')

  const newConversation = pageB.locator('.conv-item').filter({ hasText: displays[0] })
  await newConversation.waitFor({ timeout: 5000 })
  await assert.doesNotReject(() => newConversation.getByText('Tin nhắn realtime từ A').waitFor({ timeout: 1000 }))
  await newConversation.locator('.unread-badge').getByText('1', { exact: true }).waitFor()
  await newConversation.click()
  await pageB.getByRole('log').getByText('Tin nhắn realtime từ A').waitFor()
  const sentByA = pageA.getByRole('log').locator('.msg.self').filter({ hasText: 'Tin nhắn realtime từ A' })
  await sentByA.getByText('Đã đọc', { exact: true }).waitFor({ timeout: 5000 })

  await pageB.locator('textarea').fill('B đang nhập')
  const typingStatus = pageA.locator('.chat-connection-state').filter({ hasText: 'Đang nhập…' })
  await typingStatus.waitFor({ timeout: 5000 })
  await pageB.locator('textarea').fill('')
  await typingStatus.waitFor({ state: 'hidden', timeout: 5000 })

  await pageB.locator('textarea').fill('B trả lời không cần reload')
  await pageB.locator('textarea').press('Enter')
  await pageA.getByRole('log').getByText('B trả lời không cần reload').waitFor({ timeout: 5000 })
  assert.equal(await pageB.getByRole('alert').filter({ hasText: /randomUUID/i }).count(), 0)

  await contextA.setOffline(true)
  await pageB.locator('textarea').fill('Tin gửi lúc A mất mạng')
  await pageB.locator('textarea').press('Enter')
  await contextA.setOffline(false)
  await pageA.getByRole('log').getByText('Tin gửi lúc A mất mạng').waitFor({ timeout: 15000 })

  await pageA.getByRole('button', { name: 'Danh bạ' }).click()
  await pageA.getByRole('heading', { name: 'Danh bạ' }).waitFor()
  await pageA.getByRole('button', { name: 'Thêm liên hệ' }).click()
  const contactDialog = pageA.getByRole('dialog')
  await contactDialog.getByLabel('Tìm người để thêm').fill(names[1])
  const contactPerson = contactDialog.locator('.conversation-person').filter({ hasText: '@' + names[1] })
  await contactPerson.waitFor()
  await contactPerson.click()
  await contactDialog.locator('.form-field input').fill('Bạn B')
  await contactDialog.getByRole('button', { name: 'Thêm liên hệ', exact: true }).click()
  const contactRow = pageA.locator('.contact-list-item').filter({ hasText: '@' + names[1] })
  await contactRow.getByText('Bạn B', { exact: true }).waitFor()
  await contactRow.getByRole('button', { name: 'Đổi tên' }).click()
  await contactRow.getByLabel('Tên gợi nhớ cho ' + displays[1]).fill('Đồng đội B')
  await contactRow.getByRole('button', { name: 'Lưu' }).click()
  await contactRow.getByText('Đồng đội B', { exact: true }).waitFor()
  await contactRow.getByRole('button', { name: 'Xóa' }).click()
  await contactRow.waitFor({ state: 'detached' })
  console.log('PASS Step 2 chat states, reconnect, UUID fallback and one-way contacts UI.')
} finally {
  await browser?.close()
  if (ownUsers) {
    const usersQuery = "SELECT Id FROM dbo.Users WHERE Username IN ('" + names.join("','") + "')"
    const conversationsQuery = `SELECT Id FROM dbo.DirectConversations WHERE UserAID IN (${usersQuery}) AND UserBID IN (${usersQuery})`
    sql(`DELETE FROM dbo.Contacts WHERE UserId IN (${usersQuery}) OR ContactUserId IN (${usersQuery}); DELETE FROM dbo.Messages WHERE ConversationId IN (${conversationsQuery}); DELETE FROM dbo.DirectConversations WHERE Id IN (${conversationsQuery}); DELETE FROM dbo.Users WHERE Username IN ('${names.join("','")}')`)
    console.log('Removed only accounts, messages and conversations created by this run.')
  }
}

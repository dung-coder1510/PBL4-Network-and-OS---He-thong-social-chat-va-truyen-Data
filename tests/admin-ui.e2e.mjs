// Real AdminPage + browser; API responses are isolated fixtures, no user data is modified.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js'
import react from '../frontend/node_modules/@vitejs/plugin-react/dist/index.js'

const require = createRequire(path.join(process.env.CODEX_NODE_MODULES, 'package.json'))
const { chromium } = require('playwright')
const fixture = `import React from 'react'; import {createRoot} from 'react-dom/client';
import Page from '/src/pages/AdminPage.jsx'; import '/src/styles/app.css';
import Shell from '/src/components/layout/AppShell.jsx';
import {ChatRealtimeContext} from '/src/realtime/chatRealtimeContext.js';
window.expired=0; window.forbidden=0;
createRoot(document.getElementById('root')).render(
  React.createElement(ChatRealtimeContext.Provider, {value:{connectionState:'connected'}},
    React.createElement(Shell, {currentPage:'admin',user:{displayName:'Quản trị viên',role:'Admin'},onNavigate:()=>{},onLogout:()=>{}},
      React.createElement(Page, {token:'test',onSessionExpired:()=>window.expired++,onAccessLost:()=>window.forbidden++}))));`
const server = await createServer({ root: fileURLToPath(new URL('../frontend', import.meta.url)), configFile: false,
  cacheDir: 'node_modules/.vite-admin-test', plugins: [react(), {
    name: 'admin-test', resolveId(id) { if (id === '/fixture.js') return '\0admin-fixture' },
    load(id) { if (id === '\0admin-fixture') return fixture },
    configureServer(server) { server.middlewares.use('/admin-test', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end(await server.transformIndexHtml('/admin-test', '<div id="root"></div><script type="module" src="/fixture.js"></script>'))
    }) },
  }], server: { host: '127.0.0.1', port: 0 } })
let browser
const at = new Date().toISOString()
const version = value => Buffer.from(String(value).padStart(8, '0')).toString('base64')
const users = Array.from({ length: 31 }, (_, i) => ({ id: i + 1, username: i === 0 ? 'admin' : i === 30 ? 'special_user' : `user${i + 1}`,
  displayName: i === 0 ? 'Quản trị viên' : i === 30 ? 'Người dùng đặc biệt' : `Người dùng ${i + 1}`, role: i === 0 ? 'Admin' : 'User',
  isDisabled: false, isOnline: i < 2, createdAt: at, lastSeenAt: null, version: version(1) }))
const logs = []
const changes = []
const receipts = new Map()
let monitoringCalls = 0
let abortFirstDisable = true
let conflictFirstEnable = true
try {
  await server.listen()
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error('BROWSER:', error.message) })
  await page.route('**/api/v1/admin/**', async route => {
    const url = new URL(route.request().url())
    const p = url.pathname.replace('/api/v1/admin/', '')
    const send = (json, status = 200) => route.fulfill({ status, json })
    if (p === 'overview') return send({ total: users.length, enabled: users.filter(x => !x.isDisabled).length,
      disabled: users.filter(x => x.isDisabled).length, online: 2, updatedAt: at })
    if (p === 'monitoring') {
      monitoringCalls++
      return send({ metrics: { generatedAt: new Date().toISOString(), totalConnections: 2, connectedUsers: 1, connectionLimit: 500,
        connections: [], series: [], operations: [], fileEvents: [{ transferId: '10', source: 'client-B', stage: 'transferring', bytes: 10, at }] },
      users: [users[0]], files: [{ id: '10', senderId: 31, receiverId: 2, fileSizeBytes: 100, status: 'transferring' }], nextUserId: null, nextFileId: null })
    }
    if (p === 'users') {
      const q = url.searchParams.get('search')?.toLowerCase() || ''
      const role = url.searchParams.get('role')
      const state = url.searchParams.get('state')
      let rows = users.filter(x => `${x.username} ${x.displayName}`.toLowerCase().includes(q) && (!role || x.role === role) &&
        (!state || x.isDisabled === (state === 'disabled')))
      const total = rows.length
      rows = rows.filter(x => x.id > Number(url.searchParams.get('afterId') || 0))
      return send({ items: rows.slice(0, 25), total, nextCursor: rows.length > 25 ? rows[24].id : null })
    }
    const connectionsMatch = /^users\/(\d+)\/connections$/.exec(p)
    if (connectionsMatch) {
      const userId = Number(connectionsMatch[1])
      return send({ userId, total: 1, updatedAt: at, connections: [
        { id: `connection-${userId}-test`, userId: String(userId), connectedAt: at, lastHeartbeatAt: at },
      ] })
    }
    const match = /^users\/(\d+)(?:\/(disable|enable))?$/.exec(p)
    if (match) {
      const user = users.find(x => x.id === Number(match[1]))
      if (!match[2]) return send({ user, recentLogs: logs.filter(x => x.targetUserId === user.id).slice(0, 5) })
      const body = route.request().postDataJSON()
      changes.push(body)
      const previous = receipts.get(body.requestId)
      if (previous) return send({ user, operation: previous, replayed: true, runtimeCleanupPending: false })
      if (match[2] === 'enable' && conflictFirstEnable) {
        conflictFirstEnable = false; user.version = version(3)
        return send({ title: 'Thông tin tài khoản đã thay đổi. Vui lòng tải lại.', code: 'VERSION_CONFLICT' }, 409)
      }
      const disabled = match[2] === 'disable'
      const log = { id: String(logs.length + 1), requestId: body.requestId, adminUserId: 1, adminUsername: 'admin', adminName: 'Quản trị viên',
        targetUserId: user.id, targetUsername: user.username, targetName: user.displayName, action: disabled ? 'DisableUser' : 'EnableUser',
        oldIsDisabled: user.isDisabled, newIsDisabled: disabled, reason: body.reason, createdAt: new Date().toISOString() }
      user.isDisabled = disabled; user.version = version(disabled ? 2 : 4)
      logs.unshift(log); receipts.set(body.requestId, log)
      if (disabled && abortFirstDisable) { abortFirstDisable = false; return route.abort('failed') }
      return send({ user, operation: log, replayed: false, runtimeCleanupPending: false })
    }
    if (p === 'audit-logs') return send({ items: logs.filter(x => !url.searchParams.get('userId') || String(x.targetUserId) === url.searchParams.get('userId')), nextCursor: null })
    return send({ title: 'Unknown test route ' + p }, 404)
  })
  await mkdir(process.env.ADMIN_SCREENSHOT_DIR || 'artifacts/admin-workspace', { recursive: true })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/admin-test`)
  const userTab = page.getByRole('tab', { name: 'Tài khoản', exact: true })
  const usersPanel = page.getByRole('tabpanel', { name: 'Tài khoản', exact: true })
  await usersPanel.getByText('@admin · #1', { exact: true }).waitFor()
  assert.equal(await usersPanel.locator('tr[data-user-id="1"]').getByRole('button', { name: 'Khóa', exact: true }).count(), 0)
  const filters = usersPanel.getByRole('button', { name: /^Bộ lọc/ })
  assert.equal(await filters.getAttribute('aria-expanded'), 'false')
  await filters.click()
  await usersPanel.getByRole('combobox', { name: 'Vai trò', exact: true }).selectOption('Admin')
  await usersPanel.getByText('1 tài khoản phù hợp', { exact: true }).waitFor()
  await filters.click()
  assert.equal(await usersPanel.getByRole('combobox', { name: 'Vai trò', exact: true }).isVisible(), false)
  assert.equal(await usersPanel.locator('tr[data-user-id]').count(), 1, 'Collapsed filters stay applied')
  await usersPanel.getByRole('button', { name: 'Xóa bộ lọc', exact: true }).click()
  await usersPanel.getByText('31 tài khoản phù hợp', { exact: true }).waitFor()
  console.log('PASS compact filter controls preserve active filters and reset the list')
  await usersPanel.getByRole('button', { name: 'Trang tiếp', exact: true }).click()
  await usersPanel.getByText('@special_user · #31', { exact: true }).waitFor()
  await usersPanel.getByRole('button', { name: 'Trang trước', exact: true }).click()
  await usersPanel.getByLabel('Tìm tài khoản', { exact: true }).fill('special')
  await usersPanel.getByText('1 tài khoản phù hợp', { exact: false }).waitFor()
  assert.equal(monitoringCalls, 0)
  console.log('PASS redesigned workspace, cross-page account search, pagination and Admin target protection')

  const row = usersPanel.locator('tr[data-user-id="31"]')
  await row.getByRole('button', { name: 'Khóa', exact: true }).click()
  let dialog = page.getByRole('dialog')
  assert.ok(await dialog.getByRole('button', { name: 'Xác nhận khóa', exact: true }).isDisabled())
  await dialog.getByLabel('Lý do khóa').fill('   ')
  assert.ok(await dialog.getByRole('button', { name: 'Xác nhận khóa', exact: true }).isDisabled())
  await dialog.getByRole('button', { name: 'Hủy', exact: true }).click()
  assert.equal(changes.length, 0)
  await row.getByRole('button', { name: 'Khóa', exact: true }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByLabel('Lý do khóa').fill('Khóa kiểm tra phản hồi mạng')
  await dialog.getByRole('button', { name: 'Xác nhận khóa', exact: true }).click()
  await dialog.getByRole('button', { name: 'Kiểm tra kết quả', exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Đóng', exact: true }).click()
  await page.getByRole('tab', { name: 'Nhật ký', exact: true }).click()
  await userTab.click()
  await usersPanel.getByRole('button', { name: 'Kiểm tra kết quả', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Kiểm tra kết quả', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(logs.length, 1)
  assert.equal(changes[0].requestId, changes[1].requestId)
  assert.equal(changes[0].reason, changes[1].reason)
  console.log('PASS confirmation, validation and cancellation; lost response survives tab changes and retries the same intent')

  await row.getByRole('button', { name: 'Chi tiết', exact: true }).click()
  await page.getByRole('heading', { name: 'Chi tiết tài khoản', exact: true }).waitFor()
  await page.getByText('connection-3…', { exact: true }).waitFor()
  const profile = page.locator('.aw-account-detail')
  assert.ok(await profile.getByRole('region', { name: 'Kết nối hiện tại' }).isVisible())
  await page.screenshot({ path: path.join(process.env.ADMIN_SCREENSHOT_DIR || 'artifacts/admin-workspace', 'admin-profile.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await row.isVisible(), false, 'Mobile detail replaces the account list')
  await page.screenshot({ path: path.join(process.env.ADMIN_SCREENSHOT_DIR || 'artifacts/admin-workspace', 'admin-mobile-profile.png'), fullPage: true, animations: 'disabled' })
  await page.keyboard.press('Escape')
  await row.waitFor({ state: 'visible' })
  assert.ok(await row.getByRole('button', { name: 'Chi tiết', exact: true }).evaluate(el => el === document.activeElement))
  assert.equal(await usersPanel.getByLabel('Tìm tài khoản').inputValue(), 'special')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await row.getByRole('button', { name: 'Chi tiết', exact: true }).click()
  console.log('PASS scoped profile connections, mobile detail, Escape focus restoration and retained filters')
  await page.getByRole('button', { name: 'Xem nhật ký của tài khoản', exact: true }).click()
  await page.getByText('Đang lọc tài khoản @special_user', { exact: false }).waitFor()
  const logsPanel = page.getByRole('tabpanel', { name: 'Nhật ký', exact: true })
  await logsPanel.locator('.aw-audit-feed > li').waitFor()
  if (process.env.ADMIN_SCREENSHOT_DIR) {
    await mkdir(process.env.ADMIN_SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: path.join(process.env.ADMIN_SCREENSHOT_DIR, 'admin-audit.png'), fullPage: true, animations: 'disabled' })
  }
  await logsPanel.getByLabel('Từ ngày', { exact: true }).fill('2026-11-03')
  await logsPanel.getByLabel('Đến ngày', { exact: true }).fill('2026-11-02')
  await logsPanel.getByRole('button', { name: 'Áp dụng', exact: true }).click()
  await logsPanel.getByRole('alert').filter({ hasText: 'Ngày bắt đầu' }).waitFor()
  await userTab.click()
  await page.getByRole('button', { name: 'Đóng chi tiết tài khoản', exact: true }).click()
  await row.getByRole('button', { name: 'Mở khóa', exact: true }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByLabel('Lý do mở khóa').fill('Đã kiểm tra tài khoản')
  await dialog.getByRole('button', { name: 'Xác nhận mở khóa', exact: true }).click()
  await dialog.getByRole('button', { name: 'Tải lại thông tin', exact: true }).click()
  assert.equal(await dialog.getByLabel('Lý do mở khóa').inputValue(), 'Đã kiểm tra tài khoản')
  await dialog.getByRole('button', { name: 'Xác nhận mở khóa', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.notEqual(changes[2].requestId, changes[3].requestId)
  assert.equal(logs.length, 2)
  console.log('PASS detail-to-audit navigation, date validation and conflict recovery preserving the reason')

  await page.getByRole('tab', { name: 'Hoạt động hệ thống', exact: true }).click()
  await page.getByRole('heading', { name: 'Kết nối theo tài khoản', exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Truyền tệp', exact: true }).click()
  await page.getByRole('heading', { name: 'Phiên truyền tệp', exact: true }).waitFor()
  await page.getByRole('button', { name: '#10', exact: true }).click()
  await page.getByRole('heading', { name: 'Dòng thời gian phiên #10', exact: true }).waitFor()
  await userTab.click()
  const stopped = monitoringCalls
  await page.waitForTimeout(5500)
  assert.equal(monitoringCalls, stopped)
  console.log('PASS monitoring is loaded on demand and stops polling outside its active tab')
  await userTab.focus()
  await page.keyboard.press('ArrowDown')
  await page.getByRole('tab', { name: 'Hoạt động hệ thống', exact: true }).evaluate(element => { if (element.getAttribute('aria-selected') !== 'true') throw new Error('Keyboard navigation failed') })
  await page.keyboard.press('Home')
  assert.equal(await userTab.getAttribute('aria-selected'), 'true')
  const out = process.env.ADMIN_SCREENSHOT_DIR || 'artifacts/admin-workspace'
  await mkdir(out, { recursive: true })
  await page.screenshot({ path: path.join(out, 'admin-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  const bounds = await row.getByRole('button', { name: 'Khóa', exact: true }).boundingBox()
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390, 'Mobile account actions fit without horizontal scrolling')
  await row.getByRole('button', { name: 'Khóa', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  await page.screenshot({ path: path.join(out, 'admin-mobile-dialog.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('dialog').getByRole('button', { name: 'Hủy', exact: true }).click()
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.screenshot({ path: path.join(out, 'admin-dark.png'), fullPage: true, animations: 'disabled' })
  assert.ok(await page.locator('#main').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Mobile workspace has no horizontal overflow')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await usersPanel.getByRole('button', { name: 'Xóa bộ lọc', exact: true }).click()
  await usersPanel.locator('tr[data-user-id="2"]').getByRole('button', { name: 'Chi tiết', exact: true }).click()
  await page.getByText('connection-2…', { exact: true }).waitFor()
  assert.ok(await page.locator('.aw-detail-close .ico').isVisible(), 'Desktop profile close icon is visible')
  await usersPanel.getByRole('button', { name: 'Đóng thông báo', exact: true }).click()
  await page.locator('#main').evaluate(el => { el.scrollTop = 0 })
  await page.screenshot({ path: path.join(out, 'admin-workspace.png'), fullPage: true, animations: 'disabled' })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.screenshot({ path: path.join(out, 'admin-workspace-dark.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 1280, height: 800 })
  assert.ok(await page.locator('#main').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Desktop workspace fits alongside app navigation')
  assert.deepEqual(errors, [])
  console.log('PASS desktop/mobile/dark rendering without unhandled browser errors')
} finally { await browser?.close(); await server.close() }

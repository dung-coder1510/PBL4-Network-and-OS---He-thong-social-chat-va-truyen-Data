// Chạy ChatPage thật trong trình duyệt, giả lập API/context để đếm request mà không
// cần SQL, tài khoản thử hoặc thay đổi dữ liệu người dùng. Cần frontend/node_modules
// và CODEX_NODE_MODULES trỏ tới thư mục có playwright (giống các test E2E khác).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js'
import react from '../frontend/node_modules/@vitejs/plugin-react/dist/index.js'

if (!process.env.CODEX_NODE_MODULES) throw new Error('Set CODEX_NODE_MODULES to a directory containing playwright.')
const require = createRequire(path.join(process.env.CODEX_NODE_MODULES, 'package.json'))
const { chromium } = require('playwright')
const root = fileURLToPath(new URL('../frontend', import.meta.url))
const fixture = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import ChatPage from '/src/pages/ChatPage.jsx'
import { ChatRealtimeContext } from '/src/realtime/chatRealtimeContext.js'
import { FileTransferContext } from '/src/realtime/fileTransferContext.js'
window.fileLoads = []
window.syncChat = () => {}
const realtime = {
  connection: { state: 'Connected', on() {}, off() {}, invoke: async () => ({}) },
  connectionState: 'connected', textStates: {},
  subscribeMessages: () => () => {},
  subscribeSync: callback => { window.syncChat = callback; return () => {} },
  ensureTextSession: async () => {},
}
const files = {
  items: [], conversationPages: {},
  loadConversation: async (...args) => { window.fileLoads.push(args) },
}
createRoot(document.getElementById('root')).render(
  React.createElement(ChatRealtimeContext.Provider, { value: realtime },
    React.createElement(FileTransferContext.Provider, { value: files },
      React.createElement(ChatPage, { token: 'test', user: { id: 1 },
        onSessionExpired() { throw new Error('Unexpected session expiry') } }))))
`
const server = await createServer({
  // Tách cache optimizer để test không làm Vite đang chạy của người dùng tối ưu lại.
  root, configFile: false, cacheDir: 'node_modules/.vite-chat-selection-test', plugins: [react(), {
    name: 'chat-selection-fixture',
    resolveId(id) { if (id === '/selection-fixture.js') return '\0selection-fixture' },
    load(id) { if (id === '\0selection-fixture') return fixture },
    configureServer(server) {
      server.middlewares.use('/selection-test', async (_req, res, next) => {
        try {
          const html = await server.transformIndexHtml('/selection-test',
            '<div id="root"></div><script type="module" src="/selection-fixture.js"></script>')
          res.setHeader('Content-Type', 'text/html')
          res.end(html)
        } catch (error) { next(error) }
      })
    },
  }], server: { host: '127.0.0.1', port: 0 },
})
let browser
let releaseInitial
const initialGate = new Promise(resolve => { releaseInitial = resolve })
try {
  await server.listen()
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const counts = { details: 0, messages: 0 }
  let holdInitial = true
  let failDetail = false
  const conversations = ['10', '20'].map((id, index) => ({
    id, createdAt: '2026-01-01T00:00:00Z', unreadCount: 0, isContact: true,
    peer: { id: index + 2, displayName: `Peer ${id}`, username: `peer${id}`, isOnline: false },
  }))
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url())
    const match = url.pathname.match(/^\/api\/v1\/conversations\/(\d+)(\/messages)?$/)
    if (!match) {
      assert.equal(url.pathname, '/api/v1/conversations')
      return route.fulfill({ json: { items: conversations, nextCursor: null } })
    }
    const [, id, messages] = match
    counts[messages ? 'messages' : 'details']++
    if (holdInitial) await initialGate
    if (!messages) return route.fulfill(failDetail
      ? { status: 503, json: { detail: 'Lỗi tải thử nghiệm' } }
      : { json: conversations.find(item => item.id === id) })
    const older = url.searchParams.has('beforeId')
    return route.fulfill({ json: { nextCursor: older ? null : '100', items: [{
      id: older ? '99' : '100', conversationId: id, clientMessageId: `${id}-${older}`,
      senderId: 1, content: older ? `Older ${id}` : `Latest ${id}`,
      createdAt: '2026-01-01T00:00:00Z', readAt: '2026-01-01T00:00:01Z',
    }] } })
  })
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  await page.goto(origin + '/selection-test')
  const select = id => page.getByRole('button', { name: `Mở cuộc trò chuyện với Peer ${id}`, exact: true })
  await select('10').waitFor()
  // Click cùng một DOM node nhiều lần trong một task: bắt cả trường hợp ref cần
  // chặn trước render; API bị giữ để tái hiện bấm lại khi request chưa trả về.
  await select('10').evaluate(button => { for (let i = 0; i < 20; i++) button.click() })
  await page.waitForFunction(() => window.fileLoads.length > 0)
  await select('10').click({ clickCount: 3 })
  await page.waitForTimeout(300)
  assert.deepEqual(counts, { details: 1, messages: 1 }, 'Repeated clicks while loading must not restart requests')
  assert.equal(await page.evaluate(() => window.fileLoads.length), 1)
  holdInitial = false
  releaseInitial()
  await page.getByRole('log').getByText('Latest 10', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Xem tin nhắn cũ hơn' }).click()
  await page.getByRole('log').getByText('Older 10', { exact: true }).waitFor()
  await page.locator('textarea').fill('Bản nháp cần giữ')
  const before = { ...counts }
  await select('10').evaluate(button => { for (let i = 0; i < 20; i++) button.click() })
  await page.waitForTimeout(300)
  assert.deepEqual(counts, before, 'Selecting active chat must preserve history pagination without fetching')
  assert.equal(await page.locator('textarea').inputValue(), 'Bản nháp cần giữ')
  assert.equal(await page.getByRole('log').getByText('Older 10', { exact: true }).count(), 1)
  assert.equal(await page.evaluate(() => window.fileLoads.length), 1)
  console.log('PASS repeated selection during/after load: no extra detail/message/file loads; draft and history preserved')

  await page.setViewportSize({ width: 600, height: 900 })
  await page.getByRole('button', { name: 'Về danh sách cuộc trò chuyện' }).click()
  await select('10').click()
  await page.locator('textarea').waitFor({ state: 'visible' })
  assert.equal(await page.locator('textarea').inputValue(), 'Bản nháp cần giữ')
  await page.waitForTimeout(300)
  assert.deepEqual(counts, before, 'Mobile reopening must only change visibility')
  console.log('PASS mobile back/reopen preserves chat without fetching')

  await page.setViewportSize({ width: 1280, height: 900 })
  failDetail = true
  await select('20').click()
  await page.getByText('Lỗi tải thử nghiệm', { exact: true }).waitFor()
  failDetail = false
  await page.getByRole('button', { name: 'Thử lại', exact: true }).click()
  await page.locator('textarea').waitFor()
  await page.getByRole('log').getByText('Latest 20', { exact: true }).waitFor()
  assert.equal(await page.locator('textarea').inputValue(), '')
  assert.deepEqual(counts, { details: before.details + 2, messages: before.messages + 1 })
  assert.equal(await page.evaluate(() => window.fileLoads.length), 2)
  console.log('PASS switching chat still loads new data and explicit retry recovers detail failure')

  const beforeSync = { ...counts }
  await page.evaluate(() => window.syncChat(false))
  await page.getByRole('log').getByText('Latest 20', { exact: true }).waitFor()
  await page.waitForFunction(() => window.fileLoads.length === 3)
  assert.deepEqual(counts, { details: beforeSync.details + 1, messages: beforeSync.messages + 1 })
  assert.deepEqual(errors, [])
  console.log('PASS synchronization still reloads detail/messages/files; no browser errors')
} finally {
  releaseInitial()
  await browser?.close()
  await server.close()
}

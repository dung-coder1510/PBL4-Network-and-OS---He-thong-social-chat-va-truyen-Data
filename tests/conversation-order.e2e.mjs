import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { api, origin, testRun, waitFor } from './text-test-helpers.mjs'

if (!process.env.CODEX_NODE_MODULES) throw new Error('Set CODEX_NODE_MODULES to a directory containing playwright.')
const require = createRequire(path.join(process.env.CODEX_NODE_MODULES, 'package.json'))
const { chromium } = require('playwright')
const run = testRun()
let browser

// Dang nhap UI that, cho danh sach duoc tai va doi thu tu theo du lieu SQL/SignalR.
async function login(page) {
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.getByLabel('Tên đăng nhập').fill(run.names[0])
  await page.getByLabel('Mật khẩu').fill(run.password)
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
  await page.locator('.conv-item').first().waitFor()
}

// Doi dung thu tu tren DOM, khong chi dua vao phan hoi API hoac nhan thoi gian.
async function expectOrder(page, indexes) {
  await waitFor(() => page.locator('.conv-item .conv-name').allTextContents(),
    names => JSON.stringify(names) === JSON.stringify(indexes.map(index => run.names[index])))
}

try {
  await run.register()
  const conversations = []
  for (const peer of run.users.slice(1)) {
    const result = await api('/conversations', { token: run.tokens[0], method: 'POST',
      body: { peerUserId: peer.id } })
    assert.equal(result.status, 201)
    conversations.push(result.data.id)
  }
  const b = await run.connect(run.tokens[1])
  const c = await run.connect(run.tokens[2])
  const firstMessage = { conversationId: conversations[0], clientMessageId: randomUUID(), content: 'B first message' }
  await b.invoke('SendMessage', firstMessage)
  await c.invoke('SendMessage', { conversationId: conversations[1], clientMessageId: randomUUID(), content: 'C newer message' })

  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await login(page)
  await expectOrder(page, [2, 1])
  console.log('PASS initial list follows latest message time')

  await b.invoke('SendMessage', { conversationId: conversations[0], clientMessageId: randomUUID(), content: 'B latest incoming' })
  await expectOrder(page, [1, 2])
  console.log('PASS incoming message moves older conversation to the top')

  await page.getByRole('button', { name: `Mở cuộc trò chuyện với ${run.names[2]}`, exact: true }).click()
  await page.locator('textarea').fill('My newest outgoing message')
  await page.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click()
  await page.getByRole('log').getByText('My newest outgoing message', { exact: true }).waitFor()
  await expectOrder(page, [2, 1])
  console.log('PASS outgoing message also moves conversation to the top')

  await b.invoke('SendMessage', firstMessage)
  await expectOrder(page, [2, 1])
  assert.equal(await page.locator('.conv-item').filter({ hasText: run.names[1] })
    .locator('.conv-preview').innerText(), 'B latest incoming')
  console.log('PASS retrying an old message does not replace preview or reorder the list')

  await login(page)
  await expectOrder(page, [2, 1])
  assert.deepEqual(errors, [])
  console.log('PASS reloading and logging in preserves latest-message order')
} finally {
  await browser?.close()
  await run.cleanup()
  console.log('Removed only conversation order test data.')
}

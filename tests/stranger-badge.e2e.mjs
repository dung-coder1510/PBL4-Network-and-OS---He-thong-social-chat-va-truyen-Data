import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { api, origin, sql, testRun, waitFor } from './text-test-helpers.mjs'

if (!process.env.CODEX_NODE_MODULES) throw new Error('Set CODEX_NODE_MODULES to a directory containing playwright.')
const require = createRequire(path.join(process.env.CODEX_NODE_MODULES, 'package.json'))
const { chromium } = require('playwright')
const run = testRun()
const errors = []
const output = process.env.STRANGER_TEST_OUTPUT
let browser

// Dang nhap bang UI that, khong chen token hoac du lieu gia vao React.
async function login(page, index) {
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.getByLabel('Tên đăng nhập').fill(run.names[index])
  await page.getByLabel('Mật khẩu').fill(run.password)
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
  await page.locator('.conv-list h2').waitFor()
}

// Mo conversation da luu va cho header co du lieu thay vi chi cho request bat dau.
async function openConversation(page, name) {
  await page.getByRole('button', { name: `Mở cuộc trò chuyện với ${name}`, exact: true }).click()
  await page.locator('.thread-name').filter({ hasText: name }).waitFor()
}

try {
  await run.register()
  sql(`UPDATE dbo.Users SET DisplayName=N'Nguyễn An' WHERE Id=${run.users[0].id};
    UPDATE dbo.Users SET DisplayName=N'Trần Bình' WHERE Id=${run.users[1].id};`)
  const conversation = await api('/conversations', { token: run.tokens[0], method: 'POST',
    body: { peerUserId: run.users[1].id } })
  assert.equal(conversation.status, 201)
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const contextA = await browser.newContext({ viewport: { width: 1366, height: 900 } })
  const contextB = await browser.newContext()
  const [a, contactTab, b] = await Promise.all([contextA.newPage(), contextA.newPage(), contextB.newPage()])
  for (const page of [a, contactTab, b]) page.on('pageerror', error => errors.push(error.message))
  await Promise.all([login(a, 0), login(contactTab, 0), login(b, 1)])
  await openConversation(a, 'Trần Bình')
  await openConversation(b, 'Nguyễn An')
  await a.locator('.thread-header .stranger-label').waitFor()
  await b.locator('.thread-header .stranger-label').waitFor()
  assert.equal(await a.locator('.conv-list .stranger-label').count(), 0)
  assert.equal(await a.locator('.thread-meta .stranger-label').innerText(), 'NGƯỜI LẠ')
  await a.getByRole('button', { name: 'Thêm liên hệ', exact: true }).waitFor()
  console.log('PASS stranger label below name and add-contact bar, absent from conversation list')

  // Kiem tra khoang cach hai vach ngan bang nhau, khong bi CSS route ghi de margin.
  const metadataSpacing = await a.locator('.thread-meta .chat-connection-state, .thread-meta .text-route').evaluateAll(elements =>
    elements.map(element => ({ margin: getComputedStyle(element).marginLeft,
      padding: getComputedStyle(element).paddingLeft })))
  assert.deepEqual(metadataSpacing[0], metadataSpacing[1], 'Header dividers must have equal spacing')

  // Thanh lien he phai can giua icon, noi dung va nut tren cung mot hang o man hinh hep.
  for (const width of [1366, 1024, 901, 900, 768, 390, 320]) {
    await a.setViewportSize({ width, height: 900 })
    const layout = await a.locator('.stranger-contact-row').evaluate(row => {
      const rect = row.getBoundingClientRect()
      const parts = [...row.children].map(child => {
        const box = child.getBoundingClientRect()
        return { x: box.x, right: box.right, center: box.y + box.height / 2,
          top: box.top, bottom: box.bottom }
      })
      return { left: rect.left, right: rect.right, parts }
    })
    assert.ok(layout.parts.every(part => Math.abs(part.center - layout.parts[0].center) <= 1),
      `Contact bar must stay aligned at ${width}px`)
    assert.ok(layout.parts.every(part => part.x >= layout.left - 1 && part.right <= layout.right + 1),
      `Contact bar content must fit at ${width}px`)
    assert.ok(layout.parts.every((part, index) => index === 0 || part.x >= layout.parts[index - 1].right),
      `Contact bar content must not overlap at ${width}px`)
  }
  await a.setViewportSize({ width: 1366, height: 900 })
  console.log('PASS equal header divider spacing and contact bar alignment from 320px to desktop')

  // Du lieu ten/trang thai dai phai cat gon trong header, khong chen avatar hay thanh ben duoi.
  const detailUrl = `**/api/v1/conversations/${conversation.data.id}`
  await a.route(detailUrl, async route => {
    const response = await route.fetch()
    const data = await response.json()
    await route.fulfill({ response, json: { ...data, peer: { ...data.peer,
      displayName: 'Trần Bình với tên liên hệ rất dài để kiểm tra cách căn chỉnh khung trò chuyện',
      isOnline: false, lastSeenAt: '2026-10-01T12:30:00Z' } } })
  })
  await openConversation(a, 'Trần Bình')
  await a.locator('.thread-name').filter({ hasText: 'tên liên hệ rất dài' }).waitFor()
  for (const width of [1366, 901, 390, 320]) {
    await a.setViewportSize({ width, height: 900 })
    const geometry = await a.locator('.thread').evaluate(thread => {
      const rect = selector => thread.querySelector(selector).getBoundingClientRect().toJSON()
      return { header: rect('.thread-header'), avatar: rect('.thread-header .avatar'),
        title: rect('.thread-name'), meta: rect('.thread-meta'),
        status: rect('.chat-connection-state'), route: rect('.text-route'), bar: rect('.stranger-contact') }
    })
    assert.ok(geometry.title.left >= geometry.avatar.right, `Long title must not overlap avatar at ${width}px`)
    assert.ok(geometry.title.bottom <= geometry.meta.top, `Title and metadata must not overlap at ${width}px`)
    assert.ok(geometry.header.bottom <= geometry.bar.top, `Header must not overlap contact bar at ${width}px`)
    for (const name of ['title', 'meta', 'status', 'route']) {
      assert.ok(geometry[name].right <= geometry.header.right && geometry[name].left >= geometry.header.left,
        `${name} must fit inside header at ${width}px`)
    }
  }
  await a.unroute(detailUrl)
  await a.setViewportSize({ width: 1366, height: 900 })
  await openConversation(a, 'Trần Bình')
  await a.waitForFunction(() => document.querySelector('.thread-name')?.textContent === 'Trần Bình')
  console.log('PASS long name and offline status stay within header without overlap')

  if (output) {
    mkdirSync(output, { recursive: true })
    const header = await a.locator('.thread-header').boundingBox()
    const bar = await a.locator('.stranger-contact').boundingBox()
    await a.screenshot({ path: path.join(output, 'header.png'),
      clip: { x: header.x, y: header.y, width: header.width, height: bar.y + bar.height - header.y } })
    await a.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true })
    await a.setViewportSize({ width: 390, height: 844 })
    await a.locator('.stranger-label').waitFor({ state: 'visible' })
    assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await a.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true })
    await a.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await a.screenshot({ path: path.join(output, 'dark.png'), fullPage: true })
    await a.evaluate(() => { document.documentElement.dataset.theme = 'light' })
    await a.setViewportSize({ width: 1366, height: 900 })
    console.log('PASS desktop/mobile/dark rendering; no horizontal page overflow')
  }

  // Mo popup chi de nhap thong tin, Huy/Escape/nut dong deu khong luu lien he.
  const popup = a.getByRole('dialog', { name: 'Thêm vào danh bạ', exact: true })
  await a.getByRole('button', { name: 'Thêm liên hệ', exact: true }).click()
  await popup.waitFor({ state: 'visible' })
  assert.equal(await popup.getByLabel('Tên gợi nhớ').evaluate(input => input === document.activeElement), true)
  assert.equal(await popup.getByText('@' + run.names[1], { exact: true }).count(), 1)
  await popup.getByLabel('Tên gợi nhớ').fill('Bình lớp mạng')
  assert.equal((await api('/contacts', { token: run.tokens[0] })).data.length, 0)
  if (output) {
    await popup.screenshot({ path: path.join(output, 'popup.png') })
    await a.setViewportSize({ width: 390, height: 844 })
    await popup.screenshot({ path: path.join(output, 'popup-mobile.png') })
    assert.equal(await popup.evaluate(element => element.getBoundingClientRect().right <= innerWidth), true)
    await a.setViewportSize({ width: 1366, height: 900 })
  }
  await popup.getByRole('button', { name: 'Hủy', exact: true }).click()
  await popup.waitFor({ state: 'hidden' })
  await a.getByRole('button', { name: 'Thêm liên hệ', exact: true }).click()
  assert.equal(await popup.getByLabel('Tên gợi nhớ').inputValue(), '')
  await a.keyboard.press('Escape')
  await popup.waitFor({ state: 'hidden' })
  await a.getByRole('button', { name: 'Thêm liên hệ', exact: true }).click()
  await popup.getByRole('button', { name: 'Đóng thêm liên hệ', exact: true }).click()
  assert.equal((await api('/contacts', { token: run.tokens[0] })).data.length, 0)
  console.log('PASS popup opens without saving; cancel, Escape and close do not create contacts')

  // Khi luu loi thi giu popup va ten goi nho de thu lai; chi an thanh sau khi server luu thanh cong.
  await a.route('**/api/v1/contacts', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, contentType: 'application/problem+json',
      body: JSON.stringify({ title: 'Không kết nối được máy chủ thử nghiệm.' }) }) : route.continue())
  await a.getByRole('button', { name: 'Thêm liên hệ', exact: true }).click()
  await popup.getByLabel('Tên gợi nhớ').fill('  Bình lớp mạng  ')
  await popup.getByRole('button', { name: 'Thêm liên hệ', exact: true }).click()
  await popup.getByRole('alert').waitFor()
  assert.equal(await popup.getByLabel('Tên gợi nhớ').inputValue(), '  Bình lớp mạng  ')
  assert.equal(await a.locator('.stranger-label').isVisible(), true)
  await a.unroute('**/api/v1/contacts')
  await popup.getByRole('button', { name: 'Thêm liên hệ', exact: true }).click()
  await popup.waitFor({ state: 'hidden' })
  await a.locator('.stranger-contact').waitFor({ state: 'hidden' })
  assert.equal(await a.locator('.stranger-label').count(), 0)
  const ownContacts = await api('/contacts', { token: run.tokens[0] })
  assert.equal(ownContacts.data.filter(contact => contact.user.id === run.users[1].id).length, 1)
  assert.equal(ownContacts.data.find(contact => contact.user.id === run.users[1].id).alias, 'Bình lớp mạng')
  await b.locator('.stranger-contact').waitFor({ state: 'visible' })
  console.log('PASS popup preserves alias on failure/retry, saves one contact and hides bar only for owner')

  await contactTab.getByRole('button', { name: 'Danh bạ', exact: true }).click()
  await contactTab.locator('.contact-list-item').filter({ hasText: '@' + run.names[1] })
    .getByRole('button', { name: 'Xóa', exact: true }).click()
  await a.locator('.stranger-contact').waitFor({ state: 'visible' })

  // Them lien he o tab khac, header dang mo phai tu cap nhat qua SignalR.
  await contactTab.getByRole('button', { name: 'Thêm liên hệ', exact: true }).click()
  await contactTab.getByLabel('Tìm người để thêm').fill(run.names[1])
  await contactTab.locator('.conversation-person').filter({ hasText: '@' + run.names[1] }).click()
  await contactTab.getByRole('dialog').getByRole('button', { name: 'Thêm liên hệ', exact: true }).click()
  await contactTab.getByRole('dialog').waitFor({ state: 'hidden' })
  await a.locator('.stranger-label').waitFor({ state: 'hidden' })
  await a.locator('textarea').waitFor({ state: 'visible' })
  await b.locator('.stranger-label').waitFor({ state: 'visible' })
  assert.equal((await api('/contacts', { token: run.tokens[0] })).data
    .find(contact => contact.user.id === run.users[1].id).alias, null)
  console.log('PASS adding own contact in another tab removes own badge only')

  await contactTab.locator('.contact-list-item').filter({ hasText: '@' + run.names[1] })
    .getByRole('button', { name: 'Xóa', exact: true }).click()
  await a.locator('.stranger-label').waitFor({ state: 'visible' })
  console.log('PASS deleting own contact restores badge in the open chat')

  const reverse = await api('/contacts', { token: run.tokens[1], method: 'POST',
    body: { contactUserId: run.users[0].id } })
  assert.equal(reverse.status, 201)
  await b.locator('.stranger-label').waitFor({ state: 'hidden' })
  await a.locator('.stranger-label').waitFor({ state: 'visible' })
  console.log('PASS being in the other user contacts does not remove own stranger badge')

  await a.locator('textarea').fill('Chào bạn, mình vẫn nhắn tin bình thường nhé.')
  await a.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click()
  await b.getByRole('log').getByText('Chào bạn, mình vẫn nhắn tin bình thường nhé.', { exact: true }).waitFor()
  await waitFor(() => api(`/conversations/${conversation.data.id}/messages`, { token: run.tokens[0] }),
    response => response.data?.items?.length === 1)
  assert.deepEqual(errors, [])
  console.log('PASS messaging still works; no unhandled browser errors')
} finally {
  await browser?.close()
  await run.cleanup()
  console.log('Removed only stranger badge test data.')
}

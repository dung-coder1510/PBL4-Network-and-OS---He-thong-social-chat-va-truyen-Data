import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { api, origin, sql, testRun, waitFor } from './text-test-helpers.mjs'

if (!process.env.CODEX_NODE_MODULES) throw new Error('Set CODEX_NODE_MODULES to a directory containing playwright.')
const require = createRequire(path.join(process.env.CODEX_NODE_MODULES, 'package.json'))
const { chromium } = require('playwright')
const run = testRun()
const output = process.env.FILE_CHAT_OUTPUT
const errors = []
let browser

// Thu thap bang chung tren browser API; holdFile mo phong mang khong truyen duoc byte de thu huy/loi.
function instrument() {
  window.__fileChannels = []
  window.__holdFile = false
  window.__progressSeen = false
  const create = RTCPeerConnection.prototype.createDataChannel
  RTCPeerConnection.prototype.createDataChannel = function (...args) {
    const channel = create.apply(this, args)
    if (channel.label === 'file-v1') window.__fileChannels.push(channel)
    return channel
  }
  const send = RTCDataChannel.prototype.send
  RTCDataChannel.prototype.send = function (data) {
    if (this.label === 'file-v1' && window.__holdFile) return
    return send.call(this, data)
  }
  document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => {
    if (document.querySelector('.file-message-progress progress')) window.__progressSeen = true
  }).observe(document.body, { subtree: true, childList: true, attributes: true }))
}

// Dang nhap va mo chat qua UI that; byte file van truyen tren DataChannel that.
async function login(page, index, peerIndex = null) {
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.getByLabel('Tên đăng nhập').fill(run.names[index])
  await page.getByLabel('Mật khẩu').fill(run.password)
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
  await page.locator('.conv-list h2').waitFor()
  if (peerIndex !== null) {
    await page.getByRole('button', { name: `Mở cuộc trò chuyện với ${run.names[peerIndex]}`, exact: true }).click()
    await page.locator('textarea').waitFor()
  }
}

// Cho hai ben co dung mot the va dung cung trang thai sau moi su kien server.
async function expectState(a, b, name, state) {
  for (const page of [a, b]) {
    const card = page.locator('.file-message-card').filter({ hasText: name })
    await card.locator(`:scope[data-status="${state}"]`).waitFor()
    assert.equal(await card.count(), 1)
  }
}

// Chon file bang input that, cho loi moi xuat hien truoc khi ben nhan chap nhan.
async function offer(a, b, name, bytes) {
  await a.locator('.composer input[type=file]').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes })
  await expectState(a, b, name, 'offered')
  return [a, b].map(page => page.locator('.file-message-card').filter({ hasText: name }))
}

try {
  await run.register()
  const conversation = await api('/conversations', { token: run.tokens[0], method: 'POST', body: { peerUserId: run.users[1].id } })
  const otherConversation = await api('/conversations', { token: run.tokens[0], method: 'POST', body: { peerUserId: run.users[2].id } })
  assert.equal(conversation.status, 201)
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const contexts = await Promise.all([browser.newContext({ viewport: { width: 1366, height: 900 } }), browser.newContext()])
  for (const context of contexts) await context.addInitScript(instrument)
  const [a, b] = await Promise.all(contexts.map(context => context.newPage()))
  for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message))
  await Promise.all([login(a, 0, 1), login(b, 1, 0)])
  await a.locator('textarea').fill('Tin nhắn trước tệp')
  await a.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click()
  await b.getByRole('log').getByText('Tin nhắn trước tệp', { exact: true }).waitFor()

  const bytes = randomBytes(8 * 1024 * 1024)
  const name = 'Bao_cao_tien_do_PBL4.docx'
  const [sent, received] = await offer(a, b, name, bytes)
  await sent.getByRole('button', { name: 'Hủy gửi', exact: true }).waitFor()
  await received.getByRole('button', { name: 'Nhận file', exact: true }).waitFor()
  await received.getByRole('button', { name: 'Từ chối', exact: true }).waitFor()
  await waitFor(() => a.locator('.conv-item .conv-name').allTextContents(), names => names[0] === run.names[1])
  assert.ok((await a.locator('.conv-item').first().locator('.conv-preview').innerText()).includes('[Tệp] ' + name))
  if (output) {
    mkdirSync(output, { recursive: true })
    await sent.screenshot({ path: path.join(output, 'sender-offered.png') })
    await received.screenshot({ path: path.join(output, 'receiver-offered.png') })
    await b.setViewportSize({ width: 390, height: 844 })
    assert.equal(await b.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await received.screenshot({ path: path.join(output, 'receiver-mobile.png') })
    await b.setViewportSize({ width: 1280, height: 800 })
  }
  console.log('PASS immediate single offer card on both sides, inline actions and file sidebar preview')

  await received.getByRole('button', { name: 'Nhận file', exact: true }).click()
  await received.getByRole('link', { name: 'Tải xuống', exact: true }).waitFor({ timeout: 30000 })
  await expectState(a, b, name, 'completed')
  const downloadUrl = await received.getByRole('link', { name: 'Tải xuống', exact: true }).getAttribute('href')
  const digest = await b.evaluate(async url => {
    const data = await (await fetch(url)).arrayBuffer()
    const hash = await crypto.subtle.digest('SHA-256', data)
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  }, downloadUrl)
  assert.equal(digest, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(await b.evaluate(() => window.__progressSeen), true)
  if (output) await received.screenshot({ path: path.join(output, 'receiver-completed.png') })
  await a.locator('textarea').fill('Tin nhắn sau tệp')
  await a.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click()
  await b.getByRole('log').getByText('Tin nhắn sau tệp', { exact: true }).waitFor()
  const timeline = await b.getByRole('log').locator('.msg').allTextContents()
  assert.ok(timeline.findIndex(text => text.includes('Tin nhắn trước tệp')) < timeline.findIndex(text => text.includes(name)))
  assert.ok(timeline.findIndex(text => text.includes(name)) < timeline.findIndex(text => text.includes('Tin nhắn sau tệp')))
  console.log('PASS real P2P bytes/hash, live progress and text/file timeline order')

  const [, empty] = await offer(a, b, 'empty.txt', Buffer.alloc(0))
  await empty.getByRole('button', { name: 'Nhận file', exact: true }).click()
  await empty.getByRole('link', { name: 'Tải xuống', exact: true }).waitFor({ timeout: 20000 })
  await expectState(a, b, 'empty.txt', 'completed')
  console.log('PASS zero-byte file can be accepted and downloaded')

  const small = Buffer.from('inline file test')
  const [, rejected] = await offer(a, b, 'reject.zip', small)
  await rejected.getByRole('button', { name: 'Từ chối', exact: true }).click()
  await expectState(a, b, 'reject.zip', 'rejected')
  const [cancelled] = await offer(a, b, 'cancel-offer.txt', small)
  await cancelled.getByRole('button', { name: 'Hủy gửi', exact: true }).click()
  await expectState(a, b, 'cancel-offer.txt', 'cancelled')

  await a.evaluate(() => { window.__holdFile = true })
  const [, cancelDuring] = await offer(a, b, 'cancel-during.bin', small)
  await cancelDuring.getByRole('button', { name: 'Nhận file', exact: true }).click()
  await expectState(a, b, 'cancel-during.bin', 'transferring')
  await cancelDuring.getByRole('button', { name: 'Hủy', exact: true }).click()
  await expectState(a, b, 'cancel-during.bin', 'cancelled')
  const [, broken] = await offer(a, b, 'broken-channel.bin', small)
  await broken.getByRole('button', { name: 'Nhận file', exact: true }).click()
  await expectState(a, b, 'broken-channel.bin', 'transferring')
  await a.evaluate(() => window.__fileChannels.at(-1).close())
  await expectState(a, b, 'broken-channel.bin', 'failed')
  await a.evaluate(() => { window.__holdFile = false })
  console.log('PASS reject, cancel invitation, cancel in-flight and channel failure update the same card')

  // Day file cua chat khac vao trang global de chung minh chat hien tai van tai lich su rieng.
  sql(`DECLARE @n int=0; WHILE @n<51 BEGIN
    INSERT dbo.FileTransfers (ClientTransferId, ConversationId, SenderId, FileName, FileSizeBytes, Sha256, Status, CreatedAt, FinishedAt)
    VALUES (NEWID(), ${otherConversation.data.id}, ${run.users[0].id}, CONCAT(N'other-', @n, N'.txt'), 1, 0x${'ab'.repeat(32)}, 'cancelled', SYSUTCDATETIME(), SYSUTCDATETIME());
    SET @n=@n+1; END;`)
  await login(b, 1, 0)
  const historical = b.locator('.file-message-card').filter({ hasText: name })
  await historical.waitFor()
  assert.equal(await historical.getByRole('link', { name: 'Tải xuống', exact: true }).count(), 0)
  await historical.getByText('Tệp không còn ở tab này. Cần gửi lại để tải xuống.', { exact: true }).waitFor()
  assert.equal((await api(`/conversations/${conversation.data.id}/files`, { token: run.tokens[2] })).status, 404)
  assert.equal((await api(`/conversations/${conversation.data.id}/files`)).status, 401)
  const initial = await api(`/conversations/${conversation.data.id}`, { token: run.tokens[0] })
  assert.equal(initial.data.lastFile.fileName, 'broken-channel.bin')
  const fileActivityPage = await api('/conversations?limit=1', { token: run.tokens[0] })
  assert.equal(fileActivityPage.data.items[0].id, otherConversation.data.id)
  const fileActivityNext = await api('/conversations?limit=1&cursor=' + encodeURIComponent(fileActivityPage.data.nextCursor),
    { token: run.tokens[0] })
  assert.equal(fileActivityNext.data.items[0].id, conversation.data.id)
  console.log('PASS private per-conversation history survives reload without pretending blob is saved')

  sql(`DECLARE @n int=0; WHILE @n<51 BEGIN
    INSERT dbo.FileTransfers (ClientTransferId, ConversationId, SenderId, FileName, FileSizeBytes, Sha256, Status, CreatedAt, FinishedAt)
    VALUES (NEWID(), ${conversation.data.id}, ${run.users[0].id}, CONCAT(N'older-page-', @n, N'.txt'), 1, 0x${'ab'.repeat(32)}, 'cancelled', SYSUTCDATETIME(), SYSUTCDATETIME());
    SET @n=@n+1; END;`)
  await login(b, 1, 0)
  await b.getByRole('button', { name: 'Xem tin nhắn cũ hơn', exact: true }).click()
  await b.locator('.file-message-card').filter({ hasText: name }).waitFor()
  assert.equal(await b.locator('.file-message-card').filter({ hasText: name }).count(), 1)
  assert.deepEqual(errors, [])
  console.log('PASS older file pagination merges with messages without duplicate cards or browser errors')
} catch (error) {
  for (const page of browser?.contexts().flatMap(context => context.pages()) || []) {
    console.error('File card state:', await page.locator('.file-message-card').allTextContents().catch(() => []))
    console.error('Browser errors:', errors)
  }
  throw error
} finally {
  await browser?.close()
  await run.cleanup()
  console.log('Removed only inline file test data.')
}

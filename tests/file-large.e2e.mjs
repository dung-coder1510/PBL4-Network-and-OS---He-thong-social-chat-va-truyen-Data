import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { open, mkdtemp, mkdir, writeFile, unlink, rmdir, rm, statfs } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { api, origin, testRun } from './text-test-helpers.mjs'

const require = createRequire(path.join(process.env.CODEX_NODE_MODULES, 'package.json'))
const { chromium } = require('playwright')
const run = testRun()
const errors = []
const size = 1024 ** 3 + 1
const directory = await mkdtemp(path.join(tmpdir(), 'pbl4-large-test-'))
const name = 'large-audio.mp3'
const source = path.join(directory, name)
const profile = path.join(directory, 'receiver-profile')
let browser, receiverContext, monitor

function instrument() {
  window.__channels = []
  // Chỉ thay hộp picker native, đĩa OPFS và WebRTC vẫn là API thật.
  window.__savePicker = async options => {
    const root = await navigator.storage.getDirectory()
    const folder = await root.getDirectoryHandle('large-test-output', { create: true })
    return folder.getFileHandle(options.suggestedName, { create: true })
  }
  window.showSaveFilePicker = window.__savePicker
  const estimate = navigator.storage.estimate.bind(navigator.storage)
  navigator.storage.estimate = () => window.__quotaFull ? Promise.resolve({ quota: 10, usage: 10 }) : estimate()
  const create = RTCPeerConnection.prototype.createDataChannel
  RTCPeerConnection.prototype.createDataChannel = function (...args) {
    const channel = create.apply(this, args)
    if (channel.label.startsWith('file-')) window.__channels.push(channel.label)
    return channel
  }
}

const card = page => page.locator('.file-message-card').filter({ hasText: name })
async function login(page, index, peer) {
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.getByLabel('Tên đăng nhập').fill(run.names[index])
  await page.getByLabel('Mật khẩu').fill(run.password)
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
  await page.getByRole('button', { name: `Mở cuộc trò chuyện với ${run.names[peer]}`, exact: true }).click()
  await page.locator('textarea').waitFor()
}

try {
  const space = await statfs(directory)
  assert.ok(space.bavail * space.bsize > 4 * size, 'Test requires over 4 GiB free disk space')
  // Sinh dữ liệu theo phần, không giữ file >1 GiB trong RAM Node/Playwright.
  const handle = await open(source, 'wx')
  try {
    const block = Buffer.alloc(1024 * 1024)
    for (let index = 0; index < block.length; index++) block[index] = index % 251
    for (let offset = 0; offset < size; offset += block.length) {
      let written = 0
      const length = Math.min(block.length, size - offset)
      while (written < length) written += (await handle.write(block, written, length - written, offset + written)).bytesWritten
    }
  } finally { await handle.close() }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(source)) hash.update(chunk)
  const expectedHash = hash.digest('hex')
  await run.register()
  const conversation = await api('/conversations', { token: run.tokens[0], method: 'POST', body: { peerUserId: run.users[1].id } })
  assert.equal(conversation.status, 201)
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  // Receiver dùng profile thường riêng của test để OPFS ghi xuống đĩa. Context
  // incognito mặc định có quota nhỏ và có thể giữ hệ thống file trong bộ nhớ.
  receiverContext = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true })
  const contexts = [await browser.newContext(), receiverContext]
  for (const context of contexts) await context.addInitScript(instrument)
  const [a, b] = await Promise.all(contexts.map(context => context.newPage()))
  for (const page of [a, b]) {
    page.on('pageerror', error => errors.push(error.message))
    page.setDefaultTimeout(20000)
  }
  await Promise.all([login(a, 0, 1), login(b, 1, 0)])
  const quota = await b.evaluate(() => navigator.storage.estimate())
  assert.ok(quota.quota - quota.usage > 3 * size, 'Test requires quota for temp, OPFS target and write staging')
  console.log(`SETUP receiver uses a temporary persistent profile; available OPFS quota ${quota.quota - quota.usage} bytes`)
  await a.locator('.composer input[type=file]').setInputFiles(source)
  const warning = a.getByRole('dialog', { name: 'Gửi tệp lớn hơn 1 GiB?' })
  await warning.waitFor()
  assert.equal(await warning.getByRole('button', { name: 'Hủy', exact: true }).evaluate(button => button === document.activeElement), true)
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await a.setViewportSize(viewport)
    const rect = await warning.boundingBox()
    assert.ok(rect.x >= 0 && rect.x + rect.width <= viewport.width)
    assert.ok(rect.y >= 0 && rect.y + rect.height <= viewport.height)
    if (process.env.FILE_TEST_ARTIFACTS) {
      await mkdir(process.env.FILE_TEST_ARTIFACTS, { recursive: true })
      await a.screenshot({ path: path.join(process.env.FILE_TEST_ARTIFACTS, `large-warning-${viewport.width}.png`) })
    }
  }
  await a.keyboard.press('Escape')
  await warning.waitFor({ state: 'hidden' })
  assert.equal((await api('/files', { token: run.tokens[0] })).data.items.length, 0)
  console.log('PASS Chat warns before offering; Escape cancels, keyboard focus and mobile layout fit')

  await a.setViewportSize({ width: 1280, height: 800 })
  await a.goto(origin + '/#files', { waitUntil: 'networkidle' })
  await a.getByLabel('Người nhận').selectOption(conversation.data.id)
  await a.locator('.file-send input[type=file]').setInputFiles(source)
  await a.getByRole('button', { name: 'Gửi lời mời', exact: true }).click()
  await warning.getByRole('button', { name: 'Hủy', exact: true }).click()
  await warning.waitFor({ state: 'hidden' })
  assert.equal((await api('/files', { token: run.tokens[0] })).data.items.length, 0)
  assert.equal(await a.locator('.file-send input[type=file]').evaluate(input => input.files[0].name), name)
  console.log('PASS Files page cancellation sends no offer and preserves selected file')

  await a.getByRole('button', { name: 'Gửi lời mời', exact: true }).click()
  await warning.getByRole('button', { name: 'Tiếp tục gửi', exact: true }).click()
  await card(b).locator(':scope[data-status="offered"]').waitFor({ timeout: 120000 })
  const transfer = (await api('/files', { token: run.tokens[1] })).data.items.find(item => item.fileName === name)
  assert.deepEqual(transfer.supportedProtocols, ['file-v3'])
  assert.equal(transfer.fileSizeBytes, size)
  assert.equal(transfer.sha256Hex, expectedHash)
  assert.equal(await card(b).getByRole('button', { name: 'Nhận để tải xuống', exact: true }).count(), 0)
  await b.evaluate(() => { window.showSaveFilePicker = undefined })
  await card(b).getByRole('button', { name: 'Nhận file', exact: true }).click()
  await card(b).getByRole('alert').filter({ hasText: 'Tệp lớn cần' }).waitFor()
  assert.equal(await card(b).getAttribute('data-status'), 'offered')
  await b.evaluate(() => { window.showSaveFilePicker = window.__savePicker; window.__quotaFull = true })
  await card(b).getByRole('button', { name: 'Nhận file', exact: true }).click()
  await card(b).getByRole('alert').filter({ hasText: 'không đủ chỗ lưu tạm' }).waitFor()
  assert.equal(await card(b).getAttribute('data-status'), 'offered')
  await b.evaluate(() => { window.__quotaFull = false })
  console.log('PASS large files cannot downgrade to RAM; insufficient quota rejects before AcceptFile')
  await card(b).getByRole('button', { name: 'Nhận file', exact: true }).click()
  const started = Date.now()
  monitor = setInterval(() => void card(b).textContent().then(value => console.log('PROGRESS ' + value.replaceAll('\n', ' ').slice(-240))).catch(() => {}), 30000)
  await card(b).locator(':scope[data-status="transferring"]').waitFor()
  const notice = b.getByRole('button', { name: 'Đóng thông báo tệp', exact: true })
  if (await notice.isVisible()) await notice.click()
  await b.locator('textarea').fill('Chat vẫn hoạt động khi đang truyền file lớn')
  await b.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click()
  await a.goto(origin + '/#chat', { waitUntil: 'networkidle' })
  await a.getByRole('button', { name: `Mở cuộc trò chuyện với ${run.names[1]}`, exact: true }).click()
  await a.getByRole('log').getByText('Chat vẫn hoạt động khi đang truyền file lớn', { exact: true }).waitFor()
  await b.waitForFunction(name => [...document.querySelectorAll('.file-message-card')].some(element =>
    element.textContent.includes(name) && ['completed', 'failed', 'cancelled', 'expired'].includes(element.dataset.status)),
  name, { timeout: 900000 })
  assert.equal(await card(b).getAttribute('data-status'), 'completed', await card(b).textContent())
  await card(a).locator(':scope[data-status="completed"]').waitFor()
  clearInterval(monitor)
  const saved = await b.evaluate(async name => {
    const root = await navigator.storage.getDirectory()
    const folder = await root.getDirectoryHandle('large-test-output')
    const file = await (await folder.getFileHandle(name)).getFile()
    const { hashFile } = await import('/src/services/fileStreamProtocol.js')
    let remaining = 0
    for await (const key of root.keys()) if (key.startsWith('pbl4-') && key.endsWith('.part')) remaining++
    return { size: file.size, hash: await hashFile(file, new AbortController().signal), remaining }
  }, name)
  assert.deepEqual(saved, { size, hash: expectedHash, remaining: 0 })
  assert.deepEqual(await a.evaluate(() => window.__channels), ['file-v3-0'])
  const final = (await api('/files', { token: run.tokens[1] })).data.items.find(item => item.id === transfer.id)
  assert.equal(final.status, 'completed')
  assert.equal(final.verifiedSha256Hex, expectedHash)
  assert.deepEqual(errors, [])
  const seconds = Math.round((Date.now() - started) / 1000)
  if (process.env.FILE_TEST_ARTIFACTS) await writeFile(path.join(process.env.FILE_TEST_ARTIFACTS, 'large-file-result.json'),
    JSON.stringify({ completedAt: new Date().toISOString(), size, hash: expectedHash, seconds,
      protocol: 'file-v3', channels: 1, browser: 'Chrome persistent receiver', picker: 'OPFS test substitute',
      warningChatAndFiles: true, cancelBeforeOffer: true, quotaAndFallbackGuard: true,
      chatDuringTransfer: true, temporaryFilesRemaining: saved.remaining, errors }, null, 2))
  console.log(`PASS real one-channel v3 WebRTC + disk: ${size} bytes, SHA-256 verified, chat intact, ${seconds}s`)
} finally {
  clearInterval(monitor)
  await browser?.close()
  await receiverContext?.close()
  await run.cleanup()
  await unlink(source).catch(error => { if (error.code !== 'ENOENT') throw error })
  // Xóa đúng profile nằm trong mkdtemp của lượt này; không chạm profile người dùng.
  assert.equal(path.dirname(path.resolve(profile)), path.resolve(directory))
  assert.equal(path.basename(profile), 'receiver-profile')
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
  await rmdir(directory)
}

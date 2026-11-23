import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, unlink, rmdir, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { api, origin, testRun, waitFor } from './text-test-helpers.mjs'

const require = createRequire(path.join(process.env.CODEX_NODE_MODULES, 'package.json'))
const { chromium } = require('playwright')
const run = testRun()
const errors = []
const temporary = await mkdtemp(path.join(process.env.FILE_TEST_TMPDIR || tmpdir(), 'pbl4-flow-'))
const source = path.join(temporary, 'flow-110mb.bin')
const automaticSource = path.join(temporary, 'flow-auto-110mb.bin')
const fallbackSource = path.join(temporary, 'flow-auto-single-fallback.bin')
const bytes = randomBytes(110_000_000)
const digest = value => createHash('sha256').update(value).digest('hex')
let browser

function instrument() {
  window.__flowReady = []
  window.__flowChannels = []
  window.__flowActiveChannels = []
  window.showSaveFilePicker = async options =>
    (await navigator.storage.getDirectory()).getFileHandle(options.suggestedName, { create: true })
  const send = RTCDataChannel.prototype.send
  RTCDataChannel.prototype.send = function (data) {
    if (this.label.startsWith('file-') && typeof data === 'string') {
      const frame = JSON.parse(data)
      if (frame.type === 'READY') {
        if (window.__oldReceiver) delete frame.maxWindowBytes
        window.__flowReady.push(frame)
        data = JSON.stringify(frame)
      }
    }
    return send.call(this, data)
  }
  const create = RTCPeerConnection.prototype.createDataChannel
  RTCPeerConnection.prototype.createDataChannel = function (...args) {
    const channel = create.apply(this, args)
    if (channel.label.startsWith('file-')) {
      window.__flowChannels.push(channel.label)
      window.__flowActiveChannels.push(channel)
    }
    return channel
  }
  const Peer = window.RTCPeerConnection
  window.RTCPeerConnection = class extends Peer {
    constructor(...args) {
      if (window.__breakPeer) throw new DOMException('Simulated WebRTC failure', 'NotSupportedError')
      super(...args)
    }
  }
  const write = FileSystemWritableFileStream.prototype.write
  FileSystemWritableFileStream.prototype.write = async function (...args) {
    while (window.__holdWrites) await new Promise(resolve => setTimeout(resolve, 10))
    return write.apply(this, args)
  }
}

const card = (page, name) => page.locator('.file-message-card').filter({ hasText: name })
async function openConversation(page, peerIndex) {
  await page.getByRole('button', { name: `Mở cuộc trò chuyện với ${run.names[peerIndex]}`, exact: true }).click()
  await page.locator('textarea').waitFor()
}
async function reloadSender(page) {
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByLabel('Tên đăng nhập').fill(run.names[0])
  await page.getByLabel('Mật khẩu').fill(run.password)
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
  await openConversation(page, 1)
}
async function settings(page, count, parallel = false, enabled = true) {
  await page.goto(origin + '/#settings', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /^Nhà phát triển/ }).click()
  const developer = page.getByRole('switch', { name: 'Kích hoạt chế độ nhà phát triển' })
  if ((await developer.getAttribute('aria-checked') === 'true') !== enabled) await developer.click()
  if (enabled) {
    const multiple = page.getByRole('switch', { name: 'Dùng hai kết nối WebRTC riêng' })
    if ((await multiple.getAttribute('aria-checked') === 'true') !== parallel) await multiple.click()
    if (!parallel) await page.getByLabel('Số kênh truyền file').selectOption(String(count))
  }
  await page.goto(origin + '/#chat', { waitUntil: 'networkidle' })
  await openConversation(page, 1)
}
async function verifySaved(page, name, expected) {
  const result = await page.evaluate(async name => {
    const file = await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile()
    const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return { size: file.size, hash: [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('') }
  }, name)
  assert.deepEqual(result, { size: expected.length, hash: digest(expected) })
}
async function complete(a, b, name, expected) {
  for (const page of [a, b])
    await card(page, name).locator(':scope[data-status="completed"]').waitFor({ timeout: 120000 })
  await verifySaved(b, name, expected)
}

try {
  await writeFile(source, bytes)
  await run.register()
  assert.equal((await api('/conversations', { token: run.tokens[0], method: 'POST',
    body: { peerUserId: run.users[1].id } })).status, 201)
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const contexts = await Promise.all([browser.newContext({ viewport: { width: 1365, height: 900 } }),
    browser.newContext({ viewport: { width: 1365, height: 900 } })])
  for (const context of contexts) {
    await context.addInitScript(instrument)
    await context.addInitScript(() => {
      if (!localStorage.getItem('pbl4-developer-settings'))
        localStorage.setItem('pbl4-developer-settings', JSON.stringify({ enabled: true, fileChannelCount: 1 }))
    })
  }
  const pages = await Promise.all(contexts.map(context => context.newPage()))
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]
    page.on('pageerror', error => errors.push(error.message))
    page.setDefaultTimeout(30000)
    await page.goto(origin, { waitUntil: 'networkidle' })
    await page.getByLabel('Tên đăng nhập').fill(run.names[index])
    await page.getByLabel('Mật khẩu').fill(run.password)
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
    await openConversation(page, index === 0 ? 1 : 0)
  }
  const [a, b] = pages
  await b.evaluate(() => { window.__holdWrites = true })
  await a.locator('.composer input[type=file]').setInputFiles(source)
  await card(b, 'flow-110mb.bin').getByRole('button', { name: 'Nhận file', exact: true }).click()
  await waitFor(() => b.evaluate(() => window.__flowReady), frames => frames.length > 0)
  assert.ok((await b.evaluate(() => window.__flowReady)).every(frame => frame.maxWindowBytes === 8_000_000))
  const details = card(a, 'flow-110mb.bin').locator('.file-rtc-diagnostics')
  await details.getByText('Thống kê WebRTC', { exact: true }).click()
  await details.getByText('Tự điều chỉnh', { exact: false }).waitFor()
  await card(a, 'flow-110mb.bin').getByText('WebRTC trực tiếp', { exact: true }).waitFor()
  await details.getByText('8.0 MB', { exact: true }).waitFor()
  const chatMessage = 'Vẫn nhắn tin khi file đang chờ ghi ' + run.names[0]
  await a.locator('textarea').fill(chatMessage)
  await a.locator('textarea').press('Enter')
  await b.getByRole('log').getByText(chatMessage, { exact: true }).waitFor()
  if (process.env.FILE_TEST_ARTIFACTS) {
    await mkdir(process.env.FILE_TEST_ARTIFACTS, { recursive: true })
    await a.screenshot({ path: path.join(process.env.FILE_TEST_ARTIFACTS, 'webrtc-flow-desktop.png') })
    await a.setViewportSize({ width: 390, height: 844 })
    await a.screenshot({ path: path.join(process.env.FILE_TEST_ARTIFACTS, 'webrtc-flow-mobile.png') })
    assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await a.setViewportSize({ width: 1365, height: 900 })
  }
  await b.evaluate(() => { window.__holdWrites = false })
  await complete(a, b, 'flow-110mb.bin', bytes)
  await details.getByText('0 B', { exact: true }).first().waitFor()
  console.log('PASS real Chrome 110 MB, negotiated 8 MB cap, SHA-256, concurrent chat, direct route and desktop/mobile diagnostics')
  assert.equal(await a.evaluate(() => window.__flowChannels.length), 1,
    'Developer choice of one channel was overridden')

  await settings(a, 1, false, false)
  await writeFile(automaticSource, bytes)
  const beforeAutomatic = await a.evaluate(() => window.__flowChannels.length)
  await a.locator('.composer input[type=file]').setInputFiles(automaticSource)
  await card(b, 'flow-auto-110mb.bin').getByRole('button', { name: 'Nhận file', exact: true }).click()
  const autoChat = 'Chat trong lúc truyền tự động ' + run.names[0]
  await a.locator('textarea').fill(autoChat)
  await a.locator('textarea').press('Enter')
  await b.getByRole('log').getByText(autoChat, { exact: true }).waitFor()
  await complete(a, b, 'flow-auto-110mb.bin', bytes)
  assert.deepEqual(await a.evaluate(start => window.__flowChannels.slice(start), beforeAutomatic),
    ['file-v6-0', 'file-v6-1'])
  console.log('PASS normal mode automatically uses two connections for 110 MB, exact SHA-256 and concurrent chat')

  const oldConfiguration = async route => {
    const response = await route.fetch()
    const settings = await response.json()
    delete settings.supportsParallelFileConnections
    await route.fulfill({ response, json: settings })
  }
  await a.route('**/api/v1/files/configuration', oldConfiguration)
  await reloadSender(a)
  await writeFile(fallbackSource, bytes)
  await a.locator('.composer input[type=file]').setInputFiles(fallbackSource)
  await card(b, 'flow-auto-single-fallback.bin').getByRole('button', { name: 'Nhận file', exact: true }).click()
  await complete(a, b, 'flow-auto-single-fallback.bin', bytes)
  assert.deepEqual(await a.evaluate(() => window.__flowChannels), ['file-v4-0'])
  console.log('PASS normal mode keeps one connection with an older server configuration, exact SHA-256')
  await a.unroute('**/api/v1/files/configuration', oldConfiguration)
  await reloadSender(a)

  for (const [count, parallel] of [[8, false], [2, true]]) {
    await settings(a, count, parallel)
    const previousChannels = await a.evaluate(() => window.__flowChannels.length)
    const name = parallel ? 'flow-two-connections.bin' : 'flow-eight-channels.bin'
    const sample = bytes.subarray(0, 8_000_013)
    await a.locator('.composer input[type=file]').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: sample })
    await card(b, name).getByRole('button', { name: 'Nhận file', exact: true }).click()
    await complete(a, b, name, sample)
    assert.equal((await a.evaluate(previous => window.__flowChannels.slice(previous), previousChannels))
      .filter(label => label.startsWith(parallel ? 'file-v6-' : 'file-v5-')).length, count)
    console.log(`PASS negotiated window with ${parallel ? 'two independent connections' : 'eight channels'}, exact file and SHA-256`)
  }

  await settings(a, 1)
  await b.evaluate(() => { window.__oldReceiver = true; window.__holdWrites = true })
  const sample = bytes.subarray(0, 8_000_013)
  await a.locator('.composer input[type=file]').setInputFiles({ name: 'flow-old-receiver.bin', mimeType: 'application/octet-stream', buffer: sample })
  await card(b, 'flow-old-receiver.bin').getByRole('button', { name: 'Nhận file', exact: true }).click()
  const old = card(a, 'flow-old-receiver.bin').locator('.file-rtc-diagnostics')
  await old.locator('summary').click()
  await old.getByText('2.1 MB · Cố định', { exact: true }).waitFor()
  await b.evaluate(() => { window.__holdWrites = false; window.__oldReceiver = false })
  await complete(a, b, 'flow-old-receiver.bin', sample)
  console.log('PASS old READY without capability keeps the original 2.10 MB window and completes correctly')

  await b.evaluate(() => { window.__holdWrites = true })
  await a.locator('.composer input[type=file]').setInputFiles({ name: 'flow-cancel.bin', mimeType: 'application/octet-stream', buffer: sample })
  await card(b, 'flow-cancel.bin').getByRole('button', { name: 'Nhận file', exact: true }).click()
  await card(a, 'flow-cancel.bin').locator(':scope[data-status="transferring"]').waitFor()
  await card(a, 'flow-cancel.bin').getByRole('button', { name: 'Hủy', exact: true }).click()
  await card(b, 'flow-cancel.bin').locator(':scope[data-status="cancelled"]').waitFor()
  await b.evaluate(() => { window.__holdWrites = false })
  console.log('PASS cancellation while a slow receiver holds writes')

  await b.evaluate(() => { window.__breakPeer = true })
  await a.locator('.composer input[type=file]').setInputFiles({ name: 'flow-https-fallback.bin', mimeType: 'application/octet-stream', buffer: sample })
  await card(b, 'flow-https-fallback.bin').getByRole('button', { name: 'Nhận file', exact: true }).click()
  await complete(a, b, 'flow-https-fallback.bin', sample)
  assert.equal(await card(b, 'flow-https-fallback.bin').getAttribute('data-transport'), 'https')
  assert.equal(await card(a, 'flow-https-fallback.bin').locator('.file-rtc-info').count(), 0)
  console.log('PASS WebRTC failure switches to HTTPS without stale WebRTC statistics, exact SHA-256')
  assert.deepEqual(errors, [])
} catch (error) {
  console.log('FLOW_TEST_FAILURE', error.message)
  for (const [index, context] of (browser?.contexts() || []).entries()) {
    const page = context.pages()[0]
    if (!page) continue
    console.log('FLOW_BROWSER_STATE', index, await page.evaluate(() => ({
      cards: [...document.querySelectorAll('.file-message-card')].map(card => ({
        name: card.querySelector('strong')?.textContent, status: card.dataset.status,
        transport: card.dataset.transport, text: card.textContent?.slice(0, 1800),
      })),
      channels: window.__flowActiveChannels?.map(channel => ({ label: channel.label,
        readyState: channel.readyState, bufferedAmount: channel.bufferedAmount })),
      login: !!document.querySelector('input[type=password]'),
    })).catch(() => 'Page unavailable'))
  }
  for (const token of run.tokens.slice(0, 2)) {
    const files = await api('/files', { token })
    console.log('FLOW_SERVER_STATE', files.data?.items?.map(item => ({
      name: item.fileName, status: item.status, protocol: item.protocolVersion, failureCode: item.failureCode,
    })))
  }
  console.log('FLOW_BROWSER_ERRORS', errors)
  throw error
} finally {
  await browser?.close()
  await run.cleanup()
  await unlink(source).catch(error => { if (error.code !== 'ENOENT') throw error })
  await unlink(automaticSource).catch(error => { if (error.code !== 'ENOENT') throw error })
  await unlink(fallbackSource).catch(error => { if (error.code !== 'ENOENT') throw error })
  await rmdir(temporary)
}

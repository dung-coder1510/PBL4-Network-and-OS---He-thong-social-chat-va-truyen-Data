import assert from 'node:assert/strict'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { origin, sql, testRun, waitFor } from './text-test-helpers.mjs'

if (!process.env.CODEX_NODE_MODULES) throw new Error('Set CODEX_NODE_MODULES to a directory containing playwright.')
const require = createRequire(path.join(process.env.CODEX_NODE_MODULES, 'package.json'))
const { chromium } = require('playwright')
const run = testRun()
let browser
const errors = []
const check = label => console.log('PASS ' + label)

// Instrument browser APIs only. No production test hooks and no replacement transport.
function instrument() {
  const evidence = window.__textEvidence = { sent: [], received: [], server: [], peers: [], channels: [],
    dropAck: false, blockedText: '', dropPayload: '', cutPayload: '' }
  const nativeSend = RTCDataChannel.prototype.send
  RTCDataChannel.prototype.send = function (data) {
    if (this.label === 'chat-v1') {
      try {
        const frame = JSON.parse(data)
        evidence.sent.push(frame)
        if (frame.type === 'ack' && evidence.dropAck) return
        if (frame.type === 'message' && frame.message.content === evidence.dropPayload) return
        if (frame.type === 'message' && frame.message.content === evidence.cutPayload) { this.close(); return }
      } catch { /* binary file frames use a different channel */ }
    }
    return nativeSend.call(this, data)
  }
  const observe = channel => {
    evidence.channels.push({ label: channel.label, ordered: channel.ordered,
      maxRetransmits: channel.maxRetransmits, maxPacketLifeTime: channel.maxPacketLifeTime })
    channel.addEventListener('message', event => {
    if (channel.label === 'chat-v1') {
      try { evidence.received.push(JSON.parse(event.data)) } catch { /* invalid input stays visible to app */ }
    }
    })
  }
  const NativePeer = RTCPeerConnection
  window.RTCPeerConnection = class extends NativePeer {
    constructor(...args) {
      super(...args)
      evidence.peers.push(this)
      this.addEventListener('datachannel', event => observe(event.channel))
    }
    createDataChannel(...args) {
      const channel = super.createDataChannel(...args)
      observe(channel)
      return channel
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage')
  Object.defineProperty(WebSocket.prototype, 'onmessage', {
    configurable: true, get: descriptor.get,
    set(handler) {
      descriptor.set.call(this, typeof handler !== 'function' ? handler : function (event) {
        if (typeof event.data !== 'string') return handler.call(this, event)
        let changed = false
        const kept = event.data.split('\x1e').filter(Boolean).filter(text => {
          try {
            const frame = JSON.parse(text)
            if (frame.type === 1 && frame.target?.toLowerCase() === 'messagereceived') {
              evidence.server.push(frame.arguments[0])
              if (frame.arguments[0]?.content === evidence.blockedText) { changed = true; return false }
            }
          } catch { /* handshake */ }
          return true
        })
        if (!changed) return handler.call(this, event)
        if (kept.length) return handler.call(this, new MessageEvent('message', { data: kept.join('\x1e') + '\x1e' }))
      })
    },
  })
}

async function login(page, index) {
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.getByLabel('Tên đăng nhập').fill(run.names[index])
  await page.getByLabel('Mật khẩu').fill(run.password)
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
  await page.locator('.conv-list h2').getByText('Trò chuyện', { exact: true }).waitFor()
}

async function send(page, content) {
  await page.locator('textarea').fill(content)
  await page.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click()
}

async function openConversation(page, peerIndex) {
  await page.getByRole('button', { name: 'Trò chuyện', exact: true }).click()
  await page.getByRole('button', { name: `Mở cuộc trò chuyện với ${run.names[peerIndex]}`, exact: true }).click()
  await page.locator('textarea').waitFor()
}

try {
  await run.register()
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const contexts = await Promise.all([browser.newContext(), browser.newContext()])
  for (const context of contexts) await context.addInitScript(instrument)
  const [a, b] = await Promise.all(contexts.map(context => context.newPage()))
  for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message))
  await Promise.all([login(a, 0), login(b, 1)])

  await a.getByRole('button', { name: 'Cuộc trò chuyện mới' }).first().click()
  await a.getByLabel('Tìm người để trò chuyện').fill(run.names[1])
  await a.locator('.conversation-person').filter({ hasText: '@' + run.names[1] }).click()
  await a.getByRole('dialog').getByRole('button', { name: 'Bắt đầu trò chuyện' }).click()
  await a.locator('textarea').waitFor()
  await send(a, 'bootstrap text')
  await openConversation(b, 0)
  await b.getByRole('log').getByText('bootstrap text', { exact: true }).waitFor()
  await a.locator('.text-route[data-route="direct"]').waitFor({ timeout: 25000 })
  await b.locator('.text-route[data-route="direct"]').waitFor({ timeout: 25000 })

  const proofText = 'p2p-proof-' + randomUUID()
  await b.evaluate(text => { window.__textEvidence.blockedText = text }, proofText)
  await send(a, proofText)
  await b.getByRole('log').getByText(proofText, { exact: true }).waitFor()
  const evidence = await b.evaluate(() => ({
    received: window.__textEvidence.received, server: window.__textEvidence.server,
  }))
  assert.ok(evidence.received.some(frame => frame.type === 'message' && frame.message.content === proofText))
  assert.equal(evidence.server.some(message => message.content === proofText), false)
  assert.deepEqual(await a.evaluate(() => window.__textEvidence.channels.find(c => c.label === 'chat-v1')),
    { label: 'chat-v1', ordered: true, maxRetransmits: null, maxPacketLifeTime: null })
  assert.equal(sql(`SELECT COUNT(*) FROM dbo.Messages WHERE SenderId=${run.users[0].id} AND Content='${proofText}'`), '1')
  check('P2P payload reaches selected browser')

  const secondaryContext = await browser.newContext()
  await secondaryContext.addInitScript(instrument)
  const secondary = await secondaryContext.newPage()
  await login(secondary, 1)
  await openConversation(secondary, 0)
  await secondary.getByRole('log').getByText(proofText, { exact: true }).waitFor()
  const secondaryText = 'secondary-tab-' + randomUUID()
  await send(a, secondaryText)
  await secondary.getByRole('log').getByText(secondaryText, { exact: true }).waitFor()
  assert.equal(await secondary.evaluate(() => window.__textEvidence.received.some(
    frame => frame.type === 'message')), false)
  check('secondary tab history')
  await secondaryContext.close()

  // The document stays visible on mobile while CSS hides the selected thread.
  await b.setViewportSize({ width: 800, height: 800 })
  await b.getByRole('button', { name: 'Về danh sách cuộc trò chuyện', exact: true }).click()
  await b.locator('.thread').waitFor({ state: 'hidden' })
  const mobileHidden = 'mobile-hidden-' + randomUUID()
  await send(a, mobileHidden)
  await a.getByRole('log').locator('.msg.self').filter({ hasText: mobileHidden })
    .getByText('Đã nhận', { exact: true }).waitFor()
  assert.equal(sql(`SELECT COUNT(*) FROM dbo.Messages WHERE SenderId=${run.users[0].id} AND Content='${mobileHidden}' AND ReadAt IS NULL`), '1')
  await b.locator('.conv-item').filter({ hasText: run.names[0] }).locator('.unread-badge').waitFor()
  await b.getByRole('button', { name: `Mở cuộc trò chuyện với ${run.names[0]}`, exact: true }).click()
  await a.getByRole('log').locator('.msg.self').filter({ hasText: mobileHidden })
    .getByText('Đã đọc', { exact: true }).waitFor()
  await b.setViewportSize({ width: 1280, height: 800 })
  check('mobile hidden thread is not read or cleared')

  await b.getByRole('button', { name: 'Tệp', exact: true }).click()
  await b.getByRole('heading', { name: 'Tệp đã chia sẻ' }).waitFor()
  const hidden = 'hidden-thread-' + randomUUID()
  await send(a, hidden)
  await a.getByRole('log').locator('.msg.self').filter({ hasText: hidden })
    .getByText('Đã nhận', { exact: true }).waitFor()
  assert.equal(sql(`SELECT COUNT(*) FROM dbo.Messages WHERE SenderId=${run.users[0].id} AND Content='${hidden}' AND ReadAt IS NULL AND DeliveredAt IS NOT NULL`), '1')
  check('hidden thread is not read')
  check('receive while on Files')

  const fileBytes = randomBytes(1024 * 1024)
  const fileName = 'text-parallel-' + randomUUID() + '.bin'
  await a.locator('input[type=file]').setInputFiles({ name: fileName, mimeType: 'application/octet-stream', buffer: fileBytes })
  const fileRow = b.locator('tr').filter({ hasText: fileName })
  await fileRow.getByRole('button', { name: 'Chấp nhận', exact: true }).click()
  const duringFile = 'text-during-file-' + randomUUID()
  await send(a, duringFile)
  await fileRow.getByRole('link', { name: 'Tải xuống', exact: true }).waitFor({ timeout: 20000 })
  const blobUrl = await fileRow.getByRole('link', { name: 'Tải xuống', exact: true }).getAttribute('href')
  const actualHash = await b.evaluate(async url => {
    const bytes = await (await fetch(url)).arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  }, blobUrl)
  assert.equal(actualHash, createHash('sha256').update(fileBytes).digest('hex'))
  assert.equal(await a.locator('.text-route').getAttribute('data-route'), 'direct')
  assert.ok(await b.evaluate(text => window.__textEvidence.received.some(
    frame => frame.type === 'message' && frame.message.content === text), duringFile))
  check('file transfer while text stays ready')

  await openConversation(b, 0)
  await b.getByRole('log').getByText(hidden, { exact: true }).waitFor()
  await b.evaluate(() => { window.__textEvidence.dropAck = true })
  const lostAck = 'lost-ack-' + randomUUID()
  await send(a, lostAck)
  await b.getByRole('log').getByText(lostAck, { exact: true }).waitFor()
  // A periodic reconnect may already have restored P2P by the next UI poll.
  // Assert the actual fallback payload, not the duration of a transient badge.
  await b.waitForFunction(text => window.__textEvidence.server.some(message => message.content === text),
    lostAck, { timeout: 12000 })
  assert.equal(await b.getByRole('log').getByText(lostAck, { exact: true }).count(), 1)
  assert.equal(sql(`SELECT COUNT(*) FROM dbo.Messages WHERE SenderId=${run.users[0].id} AND Content='${lostAck}'`), '1')
  assert.ok(await b.evaluate(text => window.__textEvidence.server.some(message => message.content === text), lostAck))
  check('fallback after lost ACK has one bubble')
  await b.evaluate(() => { window.__textEvidence.dropAck = false })

  await a.locator('.text-route[data-route="direct"]').waitFor({ timeout: 25000 })
  const cutText = 'cut-channel-' + randomUUID()
  await a.evaluate(text => { window.__textEvidence.cutPayload = text }, cutText)
  await send(a, cutText)
  await b.getByRole('log').getByText(cutText, { exact: true }).waitFor({ timeout: 15000 })
  await b.waitForFunction(text => window.__textEvidence.server.some(m => m.content === text), cutText)
  assert.equal(await waitFor(() => b.getByRole('log').getByText(cutText, { exact: true }).count(), count => count === 1), 1)
  assert.equal(sql(`SELECT COUNT(*) FROM dbo.Messages WHERE SenderId=${run.users[0].id} AND Content='${cutText}'`), '1')
  check('channel cut after commit falls back once')

  await a.reload({ waitUntil: 'networkidle' })
  await login(a, 0)
  await openConversation(a, 1)
  await a.getByRole('log').getByText(proofText, { exact: true }).waitFor()
  assert.equal(await a.getByRole('log').getByText(lostAck, { exact: true }).count(), 1)
  check('reload history')

  await a.locator('.text-route[data-route="direct"]').waitFor({ timeout: 25000 })
  const crashText = 'crash-after-commit-' + randomUUID()
  await a.evaluate(text => { window.__textEvidence.dropPayload = text }, crashText)
  await send(a, crashText)
  await a.waitForFunction(text => window.__textEvidence.sent.some(
    frame => frame.type === 'message' && frame.message.content === text), crashText)
  await a.close()
  await b.getByRole('log').getByText(crashText, { exact: true }).waitFor({ timeout: 15000 })
  assert.equal(sql(`SELECT COUNT(*) FROM dbo.Messages WHERE SenderId=${run.users[0].id} AND Content='${crashText}'`), '1')
  check('sender crash after commit loads pending message')
  assert.deepEqual(errors, [])
  check('no unhandled browser errors')
} catch (error) {
  for (const page of browser?.contexts().flatMap(context => context.pages()) || []) {
    console.error('Browser failure state:', await page.locator('body').innerText().catch(() => '(page closed)'))
    console.error('Text evidence:', await page.evaluate(() => ({
      sent: window.__textEvidence?.sent.map(f => ({ type: f.type, id: f.message?.id || f.messageId })),
      received: window.__textEvidence?.received.map(f => ({ type: f.type, id: f.message?.id || f.messageId })),
      server: window.__textEvidence?.server.map(m => m.content), dropAck: window.__textEvidence?.dropAck,
    })).catch(() => ({})))
  }
  throw error
} finally {
  await browser?.close()
  await run.cleanup()
  console.log('Removed only text browser test data.')
}

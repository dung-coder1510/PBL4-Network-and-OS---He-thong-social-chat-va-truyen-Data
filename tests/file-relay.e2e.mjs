import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { api, origin, testRun, waitFor } from './text-test-helpers.mjs'

const require = createRequire(path.join(process.env.CODEX_NODE_MODULES, 'package.json'))
const { chromium } = require('playwright')
const run = testRun()
const sample = randomBytes(110_000_000)
const name = 'relay-110mb.bin'
const temp = await mkdtemp(path.join(tmpdir(), 'pbl4-relay-'))
const source = path.join(temp, name)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hash = digest(sample)
let browser

function instrument() {
  window.__relayPickerCalls = 0
  window.showSaveFilePicker = async options => {
    window.__relayPickerCalls++
    return (await navigator.storage.getDirectory()).getFileHandle(options.suggestedName, { create: true })
  }
  const Peer = window.RTCPeerConnection
  window.RTCPeerConnection = class extends Peer {
    constructor(...args) {
      if (window.__failPeer) throw new DOMException('Failed to construct RTCPeerConnection', 'NotSupportedError')
      super(...args)
    }
  }
  const nativeTimer = window.setTimeout
  window.setTimeout = (callback, delay, ...args) => {
    if (delay > 1_700_000 && delay <= 1_800_000) window.__expireLogin = callback
    return nativeTimer(callback, delay, ...args)
  }
  const write = FileSystemWritableFileStream.prototype.write
  FileSystemWritableFileStream.prototype.write = async function (...args) {
    while (window.__holdWriter) await new Promise(resolve => nativeTimer(resolve, 20))
    return write.apply(this, args)
  }
}

async function openPair(blockSignalr, relayConnections = 1) {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()])
  for (const context of contexts) {
    await context.addInitScript(instrument)
    await context.addInitScript(count => localStorage.setItem('pbl4-developer-settings', JSON.stringify({
      enabled: true, fileChannelCount: 1, parallelFileConnections: false, relayConnectionCount: count,
    })), relayConnections)
    if (blockSignalr) await context.route(/\/hubs\/chat(?:\/|\?|$)/, route => route.abort())
  }
  const pages = await Promise.all(contexts.map(context => context.newPage()))
  await Promise.all(pages.map(async (page, index) => {
    page.setDefaultTimeout(25000)
    await page.goto(origin)
    await page.getByLabel('Tên đăng nhập').fill(run.names[index])
    await page.getByLabel('Mật khẩu').fill(run.password)
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
    await page.getByRole('button', {
      name: 'Mở cuộc trò chuyện với ' + run.names[1 - index], exact: true,
    }).click()
    await page.locator('textarea').waitFor()
  }))
  return { contexts, pages }
}
const card = (page, fileName) => page.locator('.file-message-card').filter({ hasText: fileName })
const completed = (page, fileName) =>
  card(page, fileName).locator(':scope[data-status="completed"][data-transport="https"]').waitFor({ timeout: 150000 })

async function chooseRelayFile(page, file) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Gửi qua máy chủ', exact: true }).click()
  await (await chooser).setFiles(file)
}

async function assertSaved(page, fileName, bytes, expectedHash) {
  const result = await page.evaluate(async name => {
    const file = await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile()
    const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return { size: file.size, hash: Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('') }
  }, fileName)
  assert.deepEqual(result, { size: bytes, hash: expectedHash })
}

async function proveEarlyBytes(conversationId) {
  const payload = sample.subarray(0, 2_000_137)
  const sha = digest(payload)
  const [sender, receiver, outsider] = run.tokens
  const offer = { conversationId, clientTransferId: randomUUID(), fileName: 'early.bin',
    fileSizeBytes: payload.byteLength, sha256Hex: sha }
  const makeOffer = () => api('/files/relay', { method: 'POST', token: sender, body: offer })
  const transfer = (await makeOffer()).data
  assert.equal((await makeOffer()).data.id, transfer.id)
  const url = '/files/' + transfer.id
  assert.equal((await api(url, { token: outsider })).status, 404)
  const accept = () => api(url + '/relay/accept', {
    token: receiver, method: 'POST', body: { transferId: transfer.id, expectedVersion: transfer.version },
  })
  const claims = await Promise.all([accept(), accept()])
  assert.deepEqual(claims.map(result => result.status).sort(), [200, 409])
  const key = claims.find(result => result.status === 200).data.receiverKey
  const contentUrl = origin + '/api/v1' + url + '/relay/content'
  assert.equal((await fetch(contentUrl, { headers: {
    Authorization: 'Bearer ' + outsider, 'X-File-Relay-Key': key,
  } })).status, 404)
  const download = fetch(contentUrl, { headers: {
    Authorization: 'Bearer ' + receiver, 'X-File-Relay-Key': key,
  }, signal: AbortSignal.timeout(20000) })
  await waitFor(() => api(url, { token: sender }), result => result.data?.relayReady)
  const upload = http.request(contentUrl, { method: 'PUT', headers: {
    Authorization: 'Bearer ' + sender, 'Content-Type': 'application/octet-stream',
    'Content-Length': payload.byteLength, 'X-File-SHA256': sha,
  }, signal: AbortSignal.timeout(20000) })
  const result = new Promise((resolve, reject) => {
    upload.on('response', response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    upload.on('error', reject)
  })
  void result.catch(() => {})
  try {
    upload.write(payload.subarray(0, 64000))
    const response = await download
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    const first = await reader.read()
    assert.ok(first.value.byteLength > 0)
    assert.equal(upload.writableEnded, false)
    const receipt = { transferId: transfer.id, expectedVersion: transfer.version,
      receivedBytes: payload.length, verifiedSha256Hex: sha }
    assert.equal((await api(url + '/relay/complete', { method: 'POST', body: receipt })).status, 403)
    const receiptAttempt = fetch(origin + '/api/v1' + url + '/relay/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-File-Relay-Key': key },
      body: JSON.stringify(receipt), signal: AbortSignal.timeout(10000),
    })
    assert.equal(await Promise.race([receiptAttempt.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 150))]), false)
    upload.end(payload.subarray(64000))
    const received = createHash('sha256').update(first.value)
    let size = first.value.byteLength
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received.update(value)
      size += value.byteLength
    }
    assert.equal(size, payload.length)
    assert.equal(received.digest('hex'), sha)
    const confirmation = await receiptAttempt
    assert.equal(confirmation.status, 200)
    assert.equal((await confirmation.json()).status, 'completed')
    assert.equal(await result, 200)
  } finally { upload.destroy() }
  console.log('PASS early HTTP bytes, exact payload, duplicate acceptance, access control and scoped receipt')
}

try {
  await run.register()
  const conversation = await api('/conversations', {
    token: run.tokens[0], method: 'POST', body: { peerUserId: run.users[1].id },
  })
  assert.equal(conversation.status, 201)
  await proveEarlyBytes(conversation.data.id)
  await writeFile(source, sample)
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const manual = await openPair(true, 4)
  const [a, b] = manual.pages
  for (const page of manual.pages) await page.evaluate(() => { window.__failPeer = true })
  const cancelName = 'relay-cancelled.bin'
  await chooseRelayFile(a, { name: cancelName, mimeType: 'application/octet-stream', buffer: sample.subarray(0, 120_000) })
  await b.evaluate(() => { window.__holdWriter = true })
  await card(b, cancelName).getByRole('button', { name: 'Nhận file', exact: true }).click()
  await card(b, cancelName).locator(':scope[data-status="transferring"]').waitFor()
  await card(b, cancelName).getByRole('button', { name: 'Hủy', exact: true }).click()
  await Promise.all([a, b].map(page => card(page, cancelName).locator(':scope[data-status="cancelled"]').waitFor()))
  await b.evaluate(() => { window.__holdWriter = false })
  await assertSaved(b, cancelName, 0, digest(Buffer.alloc(0)))
  console.log('PASS the browser receiver can cancel an active relay and leaves no committed content')

  await chooseRelayFile(a, source)
  const incoming = card(b, name)
  await incoming.getByText('Qua máy chủ', { exact: true }).waitFor()
  await b.evaluate(() => { window.__holdWriter = true })
  await incoming.getByRole('button', { name: 'Nhận file', exact: true }).click()
  try {
    await incoming.locator(':scope[data-status="transferring"]').waitFor()
  } catch (error) {
    const details = await Promise.all([a, b].map(page => card(page, name).textContent({ timeout: 3000 }).catch(() => 'card missing')))
    throw new Error('Relay did not start. Sender: ' + details[0] + ' Receiver: ' + details[1], { cause: error })
  }
  await waitFor(() => incoming.getByRole('button', { name: 'Hủy', exact: true }).isEnabled(), Boolean)
  await b.evaluate(() => window.__expireLogin())
  await incoming.waitFor()
  await b.evaluate(() => { window.__holdWriter = false })
  await completed(a, name)
  await assertSaved(b, name, sample.length, hash)
  await b.getByRole('button', { name: 'Đăng nhập', exact: true }).waitFor()
  await Promise.all(manual.contexts.map(context => context.close()))
  console.log('PASS 4-connection HTTP-only 110 MB browser transfer, cancellation and simulated login expiry')

  for (const count of [1, 2, 4]) {
    const pair = await openPair(true, count)
    const [sender, receiver] = pair.pages
    for (let round = 1; round <= 3; round++) {
      await chooseRelayFile(sender, source)
      const latest = card(receiver, name).last()
      await latest.locator(':scope[data-status="offered"]').waitFor()
      const start = performance.now()
      await latest.getByRole('button', { name: 'Nhận file', exact: true }).click()
      await latest.locator(':scope[data-status="completed"]').waitFor({ timeout: 150000 })
      const seconds = (performance.now() - start) / 1000
      await assertSaved(receiver, name, sample.length, hash)
      console.log(JSON.stringify({ test: 'HTTPS browser 110 MB', connections: count, round,
        seconds: Number(seconds.toFixed(3)), MBps: Number((110 / seconds).toFixed(2)) }))
    }
    await Promise.all(pair.contexts.map(context => context.close()))
  }

  const automatic = await openPair(false, 2)
  const [c, d] = automatic.pages
  await waitFor(() => c.locator('textarea').isEnabled(), Boolean)
  await waitFor(() => d.locator('textarea').isEnabled(), Boolean)
  await d.evaluate(() => { window.__failPeer = true })
  const shorter = sample.subarray(0, 128_017)
  const fallback = 'webrtc-to-https.bin'
  await c.locator('.composer input[type=file]').setInputFiles({
    name: fallback, mimeType: 'application/octet-stream', buffer: shorter,
  })
  const offered = card(d, fallback)
  await offered.getByRole('button', { name: 'Nhận file', exact: true }).waitFor()
  const id = await offered.getAttribute('data-transfer-id')
  await offered.getByRole('button', { name: 'Nhận file', exact: true }).click()
  await Promise.all([completed(c, fallback), completed(d, fallback)])
  assert.equal(await card(d, fallback).count(), 1)
  assert.equal(await card(d, fallback).getAttribute('data-transfer-id'), id)
  assert.equal(await d.evaluate(() => window.__relayPickerCalls), 1)
  await assertSaved(d, fallback, shorter.length, digest(shorter))
  console.log('PASS browser WebRTC failure switches the same chat card to HTTPS and saves the correct file')

  let abortedPartOnce = false
  await d.route('**/api/v1/files/*/relay/parts/1*', async route => {
    if (!abortedPartOnce) {
      abortedPartOnce = true
      await route.abort('failed')
      return
    }
    await route.continue()
  })
  const retryPayload = sample.subarray(0, 9_000_013)
  const retryName = 'multipart-retry.bin'
  await chooseRelayFile(c, { name: retryName, mimeType: 'application/octet-stream', buffer: retryPayload })
  await card(d, retryName).getByRole('button', { name: 'Nhận file', exact: true }).click()
  await Promise.all([completed(c, retryName), completed(d, retryName)])
  assert.equal(abortedPartOnce, true)
  await assertSaved(d, retryName, retryPayload.length, digest(retryPayload))
  console.log('PASS multipart browser GET part failure retries automatically and preserves exact SHA-256')
} finally {
  await browser?.close()
  await run.cleanup()
  await unlink(source).catch(error => { if (error.code !== 'ENOENT') throw error })
  await rmdir(temp)
}

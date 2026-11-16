import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { api, origin, testRun, waitFor } from './text-test-helpers.mjs'

const require = createRequire(path.join(process.env.CODEX_NODE_MODULES, 'package.json'))
const { chromium } = require('playwright')
const run = testRun()
const errors = []
let browser
const temporary = await mkdtemp(path.join(tmpdir(), 'pbl4-stream-test-'))
const temporaryFiles = new Set()

function instrument() {
  window.__channels = []
  window.__activeFileChannels = []
  window.__picker = 'save'
  window.__pickerUsedGesture = false
  window.__holdWrites = false
  window.__corrupt = false
  window.__loseConfirmation = false
  // Thay hộp Save As native bằng file đích trong OPFS riêng của test. Ghi, đọc, đóng file
  // vẫn dùng File System API thật và nội dung vẫn qua WebRTC thật.
  window.showSaveFilePicker = async options => {
    window.__pickerUsedGesture = navigator.userActivation.isActive
    window.__pickerOptions = options
    if (window.__picker === 'cancel') throw new DOMException('Cancelled', 'AbortError')
    if (window.__picker === 'denied') throw new DOMException('Permission denied', 'NotAllowedError')
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('saved-test-files', { create: true })
    return directory.getFileHandle(window.__destinationName || options.suggestedName, { create: true })
  }
  const create = RTCPeerConnection.prototype.createDataChannel
  RTCPeerConnection.prototype.createDataChannel = function (...args) {
    const channel = create.apply(this, args)
    if (channel.label.startsWith('file-')) {
      window.__channels.push(channel.label)
      window.__activeFileChannels.push(channel)
    }
    return channel
  }
  const send = RTCDataChannel.prototype.send
  RTCDataChannel.prototype.send = function (data) {
    if (window.__corrupt && this.label === 'file-v2-0' && data instanceof ArrayBuffer) {
      const copy = data.slice(0)
      new Uint8Array(copy)[4] ^= 1
      return send.call(this, copy)
    }
    return send.call(this, data)
  }
  const write = FileSystemWritableFileStream.prototype.write
  FileSystemWritableFileStream.prototype.write = async function (...args) {
    while (window.__holdWrites) await new Promise(resolve => setTimeout(resolve, 10))
    if (window.__diskFull) throw new DOMException('Disk full', 'QuotaExceededError')
    if (args[0] instanceof ArrayBuffer) {
      window.__exportWrites = (window.__exportWrites || 0) + 1
      while (window.__holdExport) await new Promise(resolve => setTimeout(resolve, 10))
      if (window.__failExport && window.__exportWrites > 1) throw new DOMException('Disk full during save', 'QuotaExceededError')
    }
    return write.apply(this, args)
  }
  const socketSend = WebSocket.prototype.send
  WebSocket.prototype.send = function (data) {
    if (window.__loseConfirmation && typeof data === 'string' && data.includes('"target":"CompleteFile"')) {
      window.__loseConfirmation = false
      this.close()
      return
    }
    return socketSend.call(this, data)
  }
}

async function login(page, index, peerIndex) {
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.getByLabel('Tên đăng nhập').fill(run.names[index])
  await page.getByLabel('Mật khẩu').fill(run.password)
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
  await page.getByRole('button', { name: `Mở cuộc trò chuyện với ${run.names[peerIndex]}`, exact: true }).click()
  await page.locator('textarea').waitFor()
}

function card(page, name) { return page.locator('.file-message-card').filter({ hasText: name }) }
async function offer(a, b, name, bytes) {
  let input = { name, mimeType: 'application/octet-stream', buffer: bytes }
  if (bytes.length > 50 * 1024 * 1024) {
    input = path.join(temporary, name)
    await writeFile(input, bytes)
    temporaryFiles.add(input)
  }
  await a.locator('.composer input[type=file]').setInputFiles(input)
  await card(b, name).locator(':scope[data-status="offered"]').waitFor()
}
async function completed(a, b, name) {
  for (const page of [a, b]) await card(page, name).locator(':scope[data-status="completed"]').waitFor({ timeout: 120000 })
}
async function savedHash(page, name) {
  return page.evaluate(async name => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('saved-test-files')
    const file = await (await directory.getFileHandle(name)).getFile()
    const { hashFile } = await import('/src/services/fileStreamProtocol.js')
    return { size: file.size, hash: await hashFile(file, new AbortController().signal) }
  }, name)
}
async function expectClean(page) {
  await waitFor(() => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    let count = 0
    for await (const name of root.keys()) if (name.startsWith('pbl4-') && name.endsWith('.part')) count++
    return count
  }), count => count === 0)
}

try {
  await run.register()
  assert.equal((await api('/conversations', { token: run.tokens[0], method: 'POST',
    body: { peerUserId: run.users[1].id } })).status, 201)
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const contexts = await Promise.all([browser.newContext(), browser.newContext()])
  for (const context of contexts) await context.addInitScript(instrument)
  const [a, b] = await Promise.all(contexts.map(context => context.newPage()))
  for (const page of [a, b]) {
    page.on('pageerror', error => errors.push(error.message))
    page.setDefaultTimeout(15000)
  }
  await Promise.all([login(a, 0, 1), login(b, 1, 0)])
  for (const size of [0, 16384, 16385, 100 * 1024 * 1024]) {
    const name = `stream-${size}.bin`
    const bytes = randomBytes(size)
    await offer(a, b, name, bytes)
    await card(b, name).getByRole('button', { name: 'Nhận file', exact: true }).click()
    await completed(a, b, name)
    assert.deepEqual(await savedHash(b, name), { size, hash: createHash('sha256').update(bytes).digest('hex') })
    assert.equal(await card(b, name).getByRole('link', { name: 'Tải xuống', exact: true }).count(), 0)
    await expectClean(b)
    console.log(`PASS real one-channel WebRTC + OPFS saved exact ${size} bytes and SHA-256`)
  }
  assert.equal(await b.evaluate(() => window.__pickerUsedGesture), true)
  assert.deepEqual(await b.evaluate(() => window.__pickerOptions), {
    id: 'pbl4-receive', startIn: 'downloads', suggestedName: 'stream-104857600.bin',
    types: [{ description: 'Tệp .bin', accept: { 'application/octet-stream': ['.bin'] } }],
    excludeAcceptAllOption: true,
  })
  assert.deepEqual(await a.evaluate(() => window.__channels), Array(4).fill('file-v2-0'))

  // Tái hiện nhận âm thanh nhưng picker trả tên .exe đã tồn tại: chưa AcceptFile,
  // chưa ghi nội dung, thẻ hai bên vẫn mang tên âm thanh và có thể chọn lại.
  const audioBytes = randomBytes(16385)
  await b.evaluate(async () => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('saved-test-files')
    const target = await directory.getFileHandle('B.exe', { create: true })
    const writer = await target.createWritable()
    await writer.write('original destination bytes')
    await writer.close()
    window.__destinationName = 'B.exe'
  })
  await offer(a, b, 'A.m4a', audioBytes)
  await card(b, 'A.m4a').getByRole('button', { name: 'Nhận file', exact: true }).click()
  await card(b, 'A.m4a').getByRole('alert').filter({ hasText: 'Tên lưu phải giữ đuôi .m4a' }).waitFor()
  for (const page of [a, b]) {
    assert.equal(await card(page, 'A.m4a').getAttribute('data-status'), 'offered')
    assert.equal(await card(page, 'A.m4a').locator('.file-message-name').textContent(), 'A.m4a')
  }
  const offeredAudio = (await api('/files', { token: run.tokens[1] })).data.items.find(file => file.fileName === 'A.m4a')
  assert.equal(offeredAudio.status, 'offered')
  assert.equal(offeredAudio.sha256Hex, createHash('sha256').update(audioBytes).digest('hex'))
  assert.deepEqual(await savedHash(b, 'B.exe'), { size: 26, hash: createHash('sha256').update('original destination bytes').digest('hex') })
  await expectClean(b)
  await b.evaluate(() => { window.__destinationName = 'Bản thu.M4A' })
  await card(b, 'A.m4a').getByRole('button', { name: 'Nhận file', exact: true }).click()
  await completed(a, b, 'A.m4a')
  assert.deepEqual(await savedHash(b, 'Bản thu.M4A'), { size: audioBytes.length, hash: createHash('sha256').update(audioBytes).digest('hex') })
  await b.evaluate(() => { window.__destinationName = null })
  console.log('PASS audio rejects exe destination before accept/write, retains correct metadata and retries with matching extension')

  const bytes = randomBytes(17)
  await offer(a, b, 'stream-0.bin', bytes)
  await b.evaluate(() => { window.__destinationName = 'stream-0 (1).bin' })
  await card(b, 'stream-0.bin').last().getByRole('button', { name: 'Nhận file', exact: true }).click()
  await card(b, 'stream-0.bin').last().locator(':scope[data-status="completed"]').waitFor()
  assert.equal((await savedHash(b, 'stream-0.bin')).size, 0)
  assert.deepEqual(await savedHash(b, 'stream-0 (1).bin'), { size: 17, hash: createHash('sha256').update(bytes).digest('hex') })
  await b.evaluate(() => { window.__destinationName = null })
  console.log('PASS Save As uses selected new name and preserves previous file')

  await offer(a, b, 'cancel-picker.bin', bytes)
  await b.evaluate(() => { window.__picker = 'cancel' })
  await card(b, 'cancel-picker.bin').getByRole('button', { name: 'Nhận file', exact: true }).click()
  assert.equal(await card(b, 'cancel-picker.bin').getAttribute('data-status'), 'offered')
  await b.evaluate(() => { window.__picker = 'denied' })
  await card(b, 'cancel-picker.bin').getByRole('button', { name: 'Nhận file', exact: true }).click()
  await card(b, 'cancel-picker.bin').getByRole('alert').waitFor()
  assert.equal(await card(b, 'cancel-picker.bin').getAttribute('data-status'), 'offered')
  await card(b, 'cancel-picker.bin').getByRole('button', { name: 'Nhận để tải xuống', exact: true }).click()
  await completed(a, b, 'cancel-picker.bin')
  await card(b, 'cancel-picker.bin').getByRole('link', { name: 'Tải xuống', exact: true }).waitFor()
  await b.evaluate(() => { window.__picker = 'save' })
  console.log('PASS cancelled/denied picker leaves offer open, explicit fallback completes file-v1')

  await b.evaluate(() => { window.__holdWrites = true })
  await offer(a, b, 'slow-disk.bin', randomBytes(2 * 1024 * 1024))
  await card(b, 'slow-disk.bin').getByRole('button', { name: 'Nhận file', exact: true }).click()
  await card(a, 'slow-disk.bin').locator(':scope[data-status="transferring"]').waitFor()
  await a.locator('textarea').fill('Tin nhắn trong lúc đang truyền file')
  await a.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click()
  await b.getByRole('log').getByText('Tin nhắn trong lúc đang truyền file', { exact: true }).waitFor()
  await card(a, 'slow-disk.bin').getByRole('button', { name: 'Hủy', exact: true }).click()
  await b.evaluate(() => { window.__holdWrites = false })
  await card(b, 'slow-disk.bin').locator(':scope[data-status="cancelled"]').waitFor()
  await expectClean(b)
  console.log('PASS chat remains realtime during slow disk, cancellation cleans temporary file')

  await a.evaluate(() => { window.__corrupt = true })
  await b.evaluate(() => { window.__destinationName = 'stream-0 (1).bin' })
  await offer(a, b, 'bad-hash.bin', bytes)
  await card(b, 'bad-hash.bin').getByRole('button', { name: 'Nhận file', exact: true }).click()
  await card(b, 'bad-hash.bin').locator(':scope[data-status="failed"]').waitFor()
  await expectClean(b)
  await a.evaluate(() => { window.__corrupt = false })
  assert.deepEqual(await savedHash(b, 'stream-0 (1).bin'), { size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') })
  await b.evaluate(() => { window.__destinationName = null })
  console.log('PASS hash mismatch fails session, cleans temporary file and preserves existing destination')

  await b.evaluate(() => { window.__diskFull = true })
  await offer(a, b, 'disk-full.bin', bytes)
  await card(b, 'disk-full.bin').getByRole('button', { name: 'Nhận file', exact: true }).click()
  await card(b, 'disk-full.bin').locator(':scope[data-status="failed"]').waitFor()
  await expectClean(b)
  await b.evaluate(() => { window.__diskFull = false })
  console.log('PASS disk write failure fails session and cleans temporary file')

  await b.evaluate(() => {
    window.__destinationName = 'stream-0 (1).bin'
    window.__failExport = true
    window.__exportWrites = 0
  })
  await offer(a, b, 'save-error.bin', randomBytes(40 * 1024))
  await card(b, 'save-error.bin').getByRole('button', { name: 'Nhận file', exact: true }).click()
  await card(b, 'save-error.bin').locator(':scope[data-status="failed"]').waitFor()
  await expectClean(b)
  assert.deepEqual(await savedHash(b, 'stream-0 (1).bin'), { size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') })
  await b.evaluate(() => { window.__failExport = false; window.__holdExport = true; window.__exportWrites = 0 })
  console.log('PASS failure after partial destination write preserves existing file')

  await offer(a, b, 'cancel-save.bin', randomBytes(40 * 1024))
  await card(b, 'cancel-save.bin').getByRole('button', { name: 'Nhận file', exact: true }).click()
  await waitFor(() => b.evaluate(() => window.__exportWrites), count => count > 0)
  await card(b, 'cancel-save.bin').getByRole('button', { name: 'Hủy', exact: true }).click()
  // Đợi lệnh hủy được xác nhận trước khi cho writer chạy tiếp; click không đợi SignalR trả lời.
  await card(b, 'cancel-save.bin').locator(':scope[data-status="cancelled"]').waitFor()
  await b.evaluate(() => { window.__holdExport = false })
  await expectClean(b)
  assert.deepEqual(await savedHash(b, 'stream-0 (1).bin'), { size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') })
  await b.evaluate(() => { window.__destinationName = null })
  console.log('PASS cancelling destination save preserves existing file')

  await b.evaluate(() => { window.__holdWrites = true })
  await offer(a, b, 'parallel-broken.bin', randomBytes(2 * 1024 * 1024))
  await card(b, 'parallel-broken.bin').getByRole('button', { name: 'Nhận file', exact: true }).click()
  await card(a, 'parallel-broken.bin').locator(':scope[data-status="transferring"]').waitFor()
  await offer(a, b, 'parallel-good.bin', bytes)
  await card(b, 'parallel-good.bin').getByRole('button', { name: 'Nhận file', exact: true }).click()
  await card(a, 'parallel-good.bin').locator(':scope[data-status="transferring"]').waitFor()
  await a.evaluate(() => window.__activeFileChannels.at(-2).close())
  await card(b, 'parallel-broken.bin').locator(':scope[data-status="failed"]').waitFor()
  await b.evaluate(() => { window.__holdWrites = false })
  await completed(a, b, 'parallel-good.bin')
  assert.deepEqual(await savedHash(b, 'parallel-good.bin'), { size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') })
  await expectClean(b)
  console.log('PASS two independent file sessions, closing one channel leaves the other healthy')

  // Cùng thao tác nhận nhưng từ trang Tệp, giữ nguyên manager đang chạy.
  await offer(a, b, 'from-files-page.bin', bytes)
  await b.goto(origin + '/#files', { waitUntil: 'networkidle' })
  const row = b.getByRole('row').filter({ hasText: 'from-files-page.bin' })
  await row.getByRole('button', { name: 'Chấp nhận', exact: true }).click()
  await row.getByText('Đã lưu trên máy', { exact: true }).waitFor()
  assert.equal((await savedHash(b, 'from-files-page.bin')).size, bytes.length)
  console.log('PASS receiving through Files page uses same streaming protocol')

  await a.locator('.composer input[type=file]').setInputFiles({ name: 'unconfirmed.bin', mimeType: 'application/octet-stream', buffer: bytes })
  const unconfirmed = b.getByRole('row').filter({ hasText: 'unconfirmed.bin' })
  await unconfirmed.getByRole('button', { name: 'Chấp nhận', exact: true }).waitFor()
  await b.evaluate(() => { window.__loseConfirmation = true })
  await unconfirmed.getByRole('button', { name: 'Chấp nhận', exact: true }).click()
  await unconfirmed.getByText('Đã lưu trên máy, chưa xác nhận với máy chủ', { exact: true }).waitFor()
  assert.deepEqual(await savedHash(b, 'unconfirmed.bin'), { size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') })
  await expectClean(b)
  assert.deepEqual(errors, [])
  console.log('PASS connection lost at CompleteFile keeps saved file with accurate pending status')
} finally {
  await browser?.close()
  await run.cleanup()
  for (const file of temporaryFiles) await unlink(file)
  await rmdir(temporary)
}

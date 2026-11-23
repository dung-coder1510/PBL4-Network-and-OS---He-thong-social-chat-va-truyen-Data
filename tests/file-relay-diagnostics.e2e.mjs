import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { origin, testRun } from './text-test-helpers.mjs'

const require = createRequire(path.join(process.env.CODEX_NODE_MODULES, 'package.json'))
const { chromium } = require('playwright')
const run = testRun()
let browser
try {
  await run.register()
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    window.showSaveFilePicker = async options =>
      (await navigator.storage.getDirectory()).getFileHandle(options.suggestedName, { create: true })
  })
  await page.goto(origin)
  await page.getByLabel('Tên đăng nhập').fill(run.names[0])
  await page.getByLabel('Mật khẩu').fill(run.password)
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
  await page.locator('.app-shell').waitFor()
  await page.evaluate(() => { location.hash = 'settings' })
  await page.getByRole('button', { name: 'Nhà phát triển 🛠️', exact: true }).click()
  await page.getByRole('switch', { name: 'Kích hoạt chế độ nhà phát triển', exact: true }).click()
  await page.getByLabel('Số kết nối HTTPS', { exact: true }).selectOption('4')
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pbl4-developer-settings')).relayConnectionCount), 4)
  await page.getByRole('button', { name: 'Đo đường truyền HTTPS', exact: true }).click()
  await page.getByText('Đã đo xong và lưu tệp thử 110 MB. SHA-256 khớp.', { exact: true }).waitFor({ timeout: 90000 })
  const result = await page.locator('.settings-card').filter({ hasText: 'Truyền file qua máy chủ' }).textContent()
  console.log('Measured browser diagnostics:', result.match(/Máy này → máy chủ.*$/)?.[0])
  const saved = await page.evaluate(async () => {
    const file = await (await (await navigator.storage.getDirectory())
      .getFileHandle('wiremess-speed-test-110mb.bin')).getFile()
    const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return { size: file.size, hash: [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('') }
  })
  const hash = createHash('sha256')
  const block = Buffer.alloc(64_000)
  for (let left = 110_000_000; left > 0; left -= Math.min(left, block.length)) hash.update(block.subarray(0, left))
  assert.deepEqual(saved, { size: 110_000_000, hash: hash.digest('hex') })
  if (process.env.RELAY_SCREENSHOT_BASE) await page.screenshot({ path: process.env.RELAY_SCREENSHOT_BASE + '-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('Số kết nối HTTPS', { exact: true }).scrollIntoViewIfNeeded()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  if (process.env.RELAY_SCREENSHOT_BASE) await page.screenshot({ path: process.env.RELAY_SCREENSHOT_BASE + '-mobile.png' })
  assert.deepEqual(errors, [])
  console.log('PASS developer HTTPS settings, 110 MB per-leg measurements, saved SHA-256, desktop/mobile and no browser errors.')
} finally {
  await browser?.close()
  await run.cleanup()
}

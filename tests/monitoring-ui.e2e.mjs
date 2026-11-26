// Dashboard thật, API giả lập: không dùng tài khoản admin hoặc sửa SQL của người dùng.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js'
import react from '../frontend/node_modules/@vitejs/plugin-react/dist/index.js'
const require = createRequire(path.join(process.env.CODEX_NODE_MODULES, 'package.json'))
const { chromium } = require('playwright')
const fixture = `import React from 'react'; import {createRoot} from 'react-dom/client';
import Page from '/src/features/admin/monitoring/MonitoringPanel.jsx'; import '/src/styles/app.css'; import '/src/features/admin/admin.css';
createRoot(document.getElementById('root')).render(React.createElement('div', {className:'page admin-workspace'}, React.createElement(Page, {token:'test'})));`
const server = await createServer({ root: fileURLToPath(new URL('../frontend', import.meta.url)), configFile: false,
  cacheDir: 'node_modules/.vite-monitoring-test', plugins: [react(), {
    name: 'monitoring-test', resolveId(id) { if (id === '/fixture.js') return '\0fixture' },
    load(id) { if (id === '\0fixture') return fixture },
    configureServer(server) { server.middlewares.use('/test', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end(await server.transformIndexHtml('/test', '<div id="root"></div><script type="module" src="/fixture.js"></script>'))
    }) },
  }], server: { host: '127.0.0.1', port: 0 } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.clock.install()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let calls = 0
  let forbidden = false
  await page.route('**/api/v1/admin/monitoring?*', route => {
    calls++
    if (forbidden) return route.fulfill({ status: 403, json: { title: 'Không có quyền' } })
    const at = new Date().toISOString()
    return route.fulfill({ json: { metrics: { generatedAt: at, totalConnections: 1, connectedUsers: 1, connectionLimit: 500,
      connections: [{ id: 'connection-test', userId: '1', connectedAt: at, lastHeartbeatAt: at }],
      series: [{ kind: 'HTTP', at: new Date(Math.floor(Date.parse(at) / 5000) * 5000).toISOString(), requestsPerSecond: 2 }],
      operations: [{ kind: 'HTTP', operation: 'GET test/{id}', count: 10, errors: 1, rejected: 1, cancelled: 0, averageMs: 20, p95Ms: 90, inBytes: 100, outBytes: 500 }],
      fileEvents: [{ transferId: '10', source: 'client-B', stage: 'verifying', at, bytes: 100 }],
    }, users: [{ id: 1, displayName: 'Người dùng thử', username: 'test', role: 'User', isDisabled: false }],
    files: [{ id: '10', senderId: 1, receiverId: 2, fileSizeBytes: 100, status: 'transferring' }], nextUserId: null, nextFileId: null } })
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/test`)
  await page.getByRole('heading', { name: 'Kết nối theo tài khoản', exact: true }).waitFor()
  await page.getByLabel('Tìm trong trang kết nối').fill('không tồn tại')
  assert.equal(await page.getByText('@test - #1', { exact: true }).count(), 0)
  await page.getByLabel('Tìm trong trang kết nối').fill('')
  await page.getByRole('tab', { name: 'Lưu lượng', exact: true }).click()
  await page.getByRole('img', { name: /đỉnh HTTP 2/ }).waitFor()
  await page.getByRole('cell', { name: /GET test/ }).waitFor()
  await page.getByLabel('Loại request', { exact: true }).selectOption('SignalR')
  await page.getByRole('heading', { name: 'Chưa có mẫu request' }).waitFor()
  await page.getByRole('tab', { name: 'Truyền tệp', exact: true }).click()
  await page.getByRole('heading', { name: 'Phiên truyền tệp', exact: true }).waitFor()
  await page.getByRole('button', { name: '#10', exact: true }).click()
  await page.getByRole('heading', { name: 'Dòng thời gian phiên #10' }).waitFor()
  assert.equal(await page.getByRole('progressbar').getAttribute('value'), '100')
  assert.ok(await page.getByRole('heading', { name: 'Dòng thời gian phiên #10' }).evaluate(element => element === document.activeElement))
  await page.keyboard.press('Escape')
  assert.ok(await page.getByRole('button', { name: '#10', exact: true }).evaluate(element => element === document.activeElement))
  forbidden = true
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click()
  await page.getByRole('alert').waitFor()
  const stoppedAt = calls
  await page.clock.fastForward(11000)
  assert.ok(await page.locator('.aw-monitor-strip .aw-freshness.late').count())
  await page.clock.fastForward(11000)
  assert.ok(await page.locator('.aw-monitor-strip .aw-freshness.stale').count())
  assert.equal(calls, stoppedAt, '403 stops polling; stale timer still updates')
  await page.setViewportSize({ width: 600, height: 900 })
  assert.deepEqual(errors, [])
  console.log('PASS custom connection/traffic/transfer views, filters, chart, progress, timeline, freshness and stop-on-403; no browser errors')
} finally { await browser?.close(); await server.close() }

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../PBL4/', import.meta.url))
const assembly = process.env.PRODUCTION_TEST_DLL
  || fileURLToPath(new URL('../PBL4/bin/Release/net10.0/PBL4.dll', import.meta.url))
let checks = 0

// Xin cong tam tu he dieu hanh de khong dung vao backend dang chay cua nguoi dung.
async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

// Khoi dong assembly that trong Production voi SQL khong ton tai; khong truy cap DB cua nguoi dung.
async function startApp(overrides = {}) {
  const port = await freePort()
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/^(ASPNETCORE_|DOTNET_|ConnectionStrings__|Jwt__|Cors__)/i.test(name)) delete env[name]
  }
  Object.assign(env, {
    ASPNETCORE_ENVIRONMENT: 'Production', ASPNETCORE_URLS: `http://127.0.0.1:${port}`,
    ASPNETCORE_HTTPS_PORT: '5443',
    ConnectionStrings__DefaultConnection: 'Server=127.0.0.1,1;Database=Unavailable;User ID=unavailable;Password=test-only-unavailable;Connect Timeout=1;Encrypt=False;Pooling=False',
    Jwt__SigningKey: 'production-tests-only-key-with-at-least-32-bytes', ...overrides,
  })
  const child = spawn('dotnet', [assembly], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', value => { output += value })
  child.stderr.on('data', value => { output += value })
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)))
  // Dung dung tien trinh test, ke ca khi mot assertion that bai.
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  }
  return { port, child, exited, stop, output: () => output }
}

// Gui HTTP that, co the chon dia chi nguon de kiem tra proxy khong duoc tin cay.
function request(port, path, headers = {}, method = 'GET', localAddress = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, headers, method,
      localAddress, timeout: 8000 }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', value => { body += value })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('Production probe timed out.')))
    req.end()
  })
}

// Cho den khi HTTP san sang, nhung dung som neu tien trinh da chet.
async function waitReady(app) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (app.child.exitCode !== null) throw new Error(app.output())
    try { if ((await request(app.port, '/health/live')).status === 200) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Application did not start. ' + app.output())
}

// In ten hanh vi da kiem tra, khong in secret hay noi dung log cua ung dung khi thanh cong.
function pass(label) {
  checks++
  console.log('PASS ' + label)
}

const app = await startApp({ Cors__AllowedOrigins__0: 'https://chat.example.test' })
try {
  await waitReady(app)
  const live = await request(app.port, '/health/live')
  assert.equal(live.status, 200)
  assert.equal(live.body, 'Healthy')
  assert.match(live.headers['cache-control'], /no-store/)
  pass('Anonymous liveness works on HTTP without a database or HTTPS redirect')

  const ready = await request(app.port, '/health/ready')
  assert.equal(ready.status, 503)
  assert.equal(ready.body, 'Unhealthy')
  assert.doesNotMatch(ready.body, /Password|Unavailable|127\.0\.0\.1|SqlException/i)
  pass('Readiness reports SQL failure without exposing connection details')

  assert.equal((await request(app.port, '/api/v1/users')).status, 307)
  assert.equal((await request(app.port, '/api/v1/users', { 'X-Forwarded-Proto': 'https' })).status, 401)
  pass('Trusted loopback proxy scheme prevents redirect loops and preserves authentication')

  const untrusted = await request(app.port, '/api/v1/users', { 'X-Forwarded-Proto': 'https' }, 'GET', '127.0.0.2')
  assert.equal(untrusted.status, 307)
  pass('An untrusted proxy cannot spoof HTTPS with a forwarded header')

  const allowed = await request(app.port, '/api/v1/users', {
    Origin: 'https://chat.example.test', 'Access-Control-Request-Method': 'GET', 'X-Forwarded-Proto': 'https',
  }, 'OPTIONS')
  assert.equal(allowed.status, 204)
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://chat.example.test')
  assert.equal(allowed.headers['access-control-allow-credentials'], 'true')
  const denied = await request(app.port, '/api/v1/users', {
    Origin: 'https://untrusted.example.test', 'Access-Control-Request-Method': 'GET', 'X-Forwarded-Proto': 'https',
  }, 'OPTIONS')
  assert.equal(denied.headers['access-control-allow-origin'], undefined)
  pass('Configured CORS allows only the selected origin')

  assert.equal((await request(app.port, '/openapi/v1.json', { 'X-Forwarded-Proto': 'https' })).status, 401)
  pass('Production does not expose the development OpenAPI endpoint')
} finally { await app.stop() }

const defaultCors = await startApp()
try {
  await waitReady(defaultCors)
  const response = await request(defaultCors.port, '/api/v1/users', {
    Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET', 'X-Forwarded-Proto': 'https',
  }, 'OPTIONS')
  assert.equal(response.headers['access-control-allow-origin'], undefined)
  pass('Production does not inherit development localhost CORS origins')
} finally { await defaultCors.stop() }

const development = await startApp({ ASPNETCORE_ENVIRONMENT: 'Development' })
try {
  await waitReady(development)
  const response = await request(development.port, '/api/v1/users', {
    Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET', 'X-Forwarded-Proto': 'https',
  }, 'OPTIONS')
  assert.equal(response.headers['access-control-allow-origin'], 'http://localhost:5173')
  pass('Development retains the existing localhost frontend CORS behavior')
} finally { await development.stop() }

for (const key of ['', 'too-short']) {
  const invalid = await startApp({ Jwt__SigningKey: key })
  try {
    const code = await Promise.race([invalid.exited, new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Invalid JWT key did not stop startup.')), 10000).unref())])
    assert.notEqual(code, 0)
    assert.match(invalid.output(), /Jwt:SigningKey/)
    pass(key ? 'Production rejects a short JWT signing key' : 'Production requires a persistent JWT signing key')
  } finally { await invalid.stop() }
}
console.log(`SUCCESS: ${checks} production checks passed.`)

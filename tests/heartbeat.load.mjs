import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('../', import.meta.url))
const requireFromFrontend = createRequire(new URL('../frontend/package.json', import.meta.url))
const signalR = requireFromFrontend('@microsoft/signalr')
const sqlServer = process.env.AUTH_TEST_SQL_SERVER || 'localhost'
const database = process.env.AUTH_TEST_DATABASE || 'PBL4'
if (!['localhost', '127.0.0.1', '.'].includes(sqlServer)) throw new Error('Local SQL Server only.')
const origin = 'http://127.0.0.1:5255'
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + '-' + randomUUID().slice(0, 8)
const output = path.join(root, 'artifacts', 'heartbeat-load', runId)
mkdirSync(output, { recursive: true })
const prefix = 'hbload' + randomUUID().replaceAll('-', '').slice(0, 12)
const seedName = prefix + '_seed'
const password = randomUUID()
const pattern = prefix + '[_]%'
const usersQuery = `SELECT Id FROM dbo.Users WHERE Username LIKE N'${pattern}'`
const phasePath = path.join(output, 'phase.txt')
const stopPath = path.join(output, 'stop.txt')
const guardPath = path.join(output, 'guard.txt')
const samplesPath = path.join(output, 'resources.jsonl')
const backendLog = createWriteStream(path.join(output, 'backend.log'))
const stages = []
const clients = []
const latencySamples = []
const connectionsSamples = []
const offlineEvents = []
const errors = []
const silenced = new Set()
let phase = 'setup'
let backend
let sampler
let seeded = false
let interrupted = false
let closing = false
let completed = false
const clientLoopDelay = monitorEventLoopDelay({ resolution: 20 })
clientLoopDelay.enable()
process.on('SIGINT', () => { interrupted = true })

function setPhase(name) {
  phase = name
  writeFileSync(phasePath, name)
  console.log('PHASE ' + name)
}

function sql(query) {
  return execFileSync('sqlcmd', ['-S', sqlServer, '-d', database, '-E', '-C', '-b', '-l', '5',
    '-h', '-1', '-W', '-Q', 'SET NOCOUNT ON; SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON; ' +
    'SET ANSI_PADDING ON; SET ANSI_WARNINGS ON; SET CONCAT_NULL_YIELDS_NULL ON; ' +
    'SET ARITHABORT ON; SET NUMERIC_ROUNDABORT OFF; ' + query],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim()
}

function api(pathname, body, localAddress = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const request = http.request(origin + '/api/v1' + pathname, {
      method: 'POST', localAddress, agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.on('end', () => {
        try {
          const data = JSON.parse(text)
          if (response.statusCode >= 400) reject(new Error(`API ${pathname}: HTTP ${response.statusCode}`))
          else resolve(data)
        } catch (failure) { reject(failure) }
      })
    })
    request.setTimeout(20000, () => request.destroy(new Error(`API ${pathname} timed out`)))
    request.on('error', reject)
    request.end(payload)
  })
}

async function pool(items, concurrency, action) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      checkGuard()
      const index = next++
      await action(items[index], index)
    }
  }))
}

function checkGuard() {
  if (interrupted) throw new Error('Load test interrupted.')
  if (existsSync(guardPath)) throw new Error(readFileSync(guardPath, 'utf8'))
  if (errors.filter(error => error.phase === phase).length >= 10)
    throw new Error('Stopping after 10 errors in the current phase.')
}

function summary(values) {
  if (!values.length) return null
  const ordered = [...values].sort((first, second) => first - second)
  const percentile = fraction => ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)]
  return {
    count: values.length,
    mean: Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(3)),
    p50: Number(percentile(0.5).toFixed(3)),
    p95: Number(percentile(0.95).toFixed(3)),
    p99: Number(percentile(0.99).toFixed(3)),
    max: Number(ordered.at(-1).toFixed(3)),
  }
}

async function beat(client) {
  const startedAt = performance.now()
  const requestPhase = phase
  try {
    const ack = await client.connection.invoke('Heartbeat')
    assert.equal(ack.intervalSeconds, 15)
    client.lastAckAt = Date.now()
    latencySamples.push({ phase: requestPhase, ms: performance.now() - startedAt })
  } catch (failure) {
    errors.push({ phase: requestPhase, kind: 'heartbeat', message: failure.message })
  }
}

function schedule(client) {
  client.timer = setTimeout(async () => {
    if (closing || silenced.has(client.id)) return
    await beat(client)
    if (!closing && !silenced.has(client.id)) schedule(client)
  }, 15000)
}

async function openClient(index) {
  const sourceAddress = `127.1.${Math.floor(index / 250)}.${index % 250 + 1}`
  const session = await api('/sessions', { username: prefix + '_' + index, password }, sourceAddress)
  const connection = new signalR.HubConnectionBuilder()
    .withUrl(origin + '/hubs/chat', {
      accessTokenFactory: () => session.accessToken,
      transport: signalR.HttpTransportType.WebSockets,
      skipNegotiation: true,
    })
    .configureLogging(signalR.LogLevel.None)
    .build()
  const client = { id: session.user.id, connection, timer: null, lastAckAt: null }
  clients.push(client)
  for (const event of ['MessageReceived', 'MessageStatusChanged', 'TypingChanged', 'ConversationChanged'])
    connection.on(event, () => {})
  connection.on('PresenceChanged', event => {
    if (event.isOnline) return
    const target = clients.find(candidate => candidate.id === event.userId)
    offlineEvents.push({
      phase, userId: event.userId, expected: silenced.has(event.userId),
      silenceMs: target?.lastAckAt ? Date.now() - target.lastAckAt : null,
    })
  })
  connection.onclose(failure => {
    clearTimeout(client.timer)
    if (!closing) errors.push({ phase, kind: 'disconnect', message: failure?.message || 'Unexpected close' })
  })
  const startedAt = performance.now()
  await connection.start()
  connectionsSamples.push({ phase, ms: performance.now() - startedAt })
  await beat(client)
  schedule(client)
}

async function observe(seconds) {
  for (let elapsed = 0; elapsed < seconds; elapsed++) {
    checkGuard()
    await delay(1000)
    if ((elapsed + 1) % 15 === 0) {
      const samples = latencySamples.filter(sample => sample.phase === phase).map(sample => sample.ms)
      console.log(JSON.stringify({ phase, elapsedSeconds: elapsed + 1,
        connected: clients.filter(client => client.connection.state === 'Connected').length,
        heartbeatAck: summary(samples), errors: errors.length }))
    }
  }
}

try {
  setPhase('starting')
  const portFree = await new Promise(resolve => {
    const probe = http.get(origin + '/api/v1/users/me', response => {
      response.resume()
      resolve(false)
    })
    probe.setTimeout(1000, () => probe.destroy())
    probe.on('error', () => resolve(true))
  })
  assert.ok(portFree, 'Port 5255 is already in use; refusing to test an unrelated server.')
  backend = spawn(path.join(root, 'PBL4', 'bin', 'Release', 'net10.0', 'PBL4.exe'),
    ['--urls', origin], {
      cwd: path.join(root, 'PBL4'), windowsHide: true,
      env: { ...process.env, ASPNETCORE_ENVIRONMENT: 'Development',
        Logging__LogLevel__Default: 'Warning',
        'Logging__LogLevel__Microsoft.EntityFrameworkCore.Database.Command': 'Warning' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  backend.stdout.pipe(backendLog, { end: false })
  backend.stderr.pipe(backendLog, { end: false })
  let ready = false
  for (let attempt = 0; attempt < 40; attempt++) {
    if (backend.exitCode !== null) throw new Error('Benchmark backend exited during startup.')
    try {
      const response = await fetch(origin + '/api/v1/users/me', { signal: AbortSignal.timeout(1000) })
      if (response.status === 401) { ready = true; break }
    } catch { }
    await delay(250)
  }
  assert.ok(ready, 'Benchmark backend did not become ready.')
  assert.equal(sql(`SELECT COUNT(*) FROM dbo.Users WHERE Username LIKE N'${pattern}'`), '0')
  seeded = true
  await api('/users', { username: seedName, displayName: 'Heartbeat load seed', password })
  sql(`WITH numbers AS (SELECT 0 AS number UNION ALL SELECT number+1 FROM numbers WHERE number<999)
    INSERT INTO dbo.Users(Username, PasswordHash, DisplayName, Role)
    SELECT CONCAT(N'${prefix}_', number), seed.PasswordHash, CONCAT(N'Heartbeat load ', number), 'User'
    FROM numbers CROSS JOIN (SELECT PasswordHash FROM dbo.Users WHERE Username=N'${seedName}') seed
    OPTION (MAXRECURSION 1000);
    WITH ordered AS (SELECT Id, LEAD(Id) OVER(ORDER BY Id) AS NextId FROM dbo.Users
      WHERE Username LIKE N'${pattern}' AND Username<>N'${seedName}')
    INSERT INTO dbo.Contacts(UserId, ContactUserId) SELECT Id, NextId FROM ordered WHERE NextId IS NOT NULL;`)
  const databaseProcessId = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "(Get-CimInstance Win32_Service -Filter \"Name='MSSQLSERVER'\").ProcessId"],
  { encoding: 'utf8', windowsHide: true }).trim())
  sampler = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(root, 'tests', 'measure-heartbeat-load.ps1'),
    '-BackendProcessId', String(backend.pid), '-ClientProcessId', String(process.pid),
    '-DatabaseProcessId', String(databaseProcessId), '-OutputPath', samplesPath,
    '-PhasePath', phasePath, '-StopPath', stopPath, '-GuardPath', guardPath],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  sampler.stderr.on('data', data => console.error('Sampler: ' + data.toString().trim()))
  setPhase('baseline')
  await observe(10)

  for (const target of [100, 500, 1000]) {
    setPhase('ramp-' + target)
    const rampStartedAt = performance.now()
    await pool(Array.from({ length: target - clients.length }, (_, index) => clients.length + index),
      20, openClient)
    checkGuard()
    console.log(`Opened ${target} distinct accounts/connections in ${((performance.now() - rampStartedAt) / 1000).toFixed(1)}s`)
    setPhase('steady-' + target)
    const startedAt = Date.now()
    if (target === 1000) {
      const silentClients = clients.slice(-10)
      for (const client of silentClients) {
        clearTimeout(client.timer)
        silenced.add(client.id)
      }
      await Promise.all(silentClients.map(beat))
    }
    await observe(target === 1000 ? 90 : 75)
    const unexpectedOffline = offlineEvents.filter(event => event.phase === phase && !event.expected)
    stages.push({
      phase, target, durationSeconds: (Date.now() - startedAt) / 1000,
      connected: clients.filter(client => client.connection.state === 'Connected').length,
      heartbeatAckMs: summary(latencySamples.filter(sample => sample.phase === phase).map(sample => sample.ms)),
      errors: errors.filter(error => error.phase === phase).length,
      unexpectedOffline: unexpectedOffline.length,
    })
    assert.equal(unexpectedOffline.length, 0, 'A client sending heartbeats was incorrectly marked offline.')
    if (target === 1000) {
      const observed = new Set(offlineEvents.filter(event => event.expected).map(event => event.userId))
      assert.equal(observed.size, 10, 'Not all ten silenced accounts announced offline under load.')
      assert.ok(offlineEvents.filter(event => event.expected).every(event => event.silenceMs >= 59000),
        'An offline notification arrived too early.')
      for (const client of clients.slice(-10)) {
        silenced.delete(client.id)
        await beat(client)
        schedule(client)
      }
    }
  }

  setPhase('burst-1000')
  const burstStartedAt = performance.now()
  for (const client of clients) clearTimeout(client.timer)
  await Promise.all(clients.map(beat))
  stages.push({ phase, target: 1000, durationSeconds: (performance.now() - burstStartedAt) / 1000,
    heartbeatAckMs: summary(latencySamples.filter(sample => sample.phase === phase).map(sample => sample.ms)),
    errors: errors.filter(error => error.phase === phase).length })
  checkGuard()
  setPhase('closing')
  closing = true
  await pool(clients, 30, client => client.connection.stop())
  setPhase('cooldown')
  await observe(65)
  completed = true
} catch (failure) {
  errors.push({ phase, kind: 'test', message: failure.message })
  console.error('LOAD TEST STOPPED: ' + failure.message)
  process.exitCode = 1
} finally {
  closing = true
  for (const client of clients) clearTimeout(client.timer)
  await pool(clients, 30, client => client.connection.stop()).catch(() => {})
  writeFileSync(stopPath, 'stop')
  if (sampler) {
    await Promise.race([new Promise(resolve => sampler.once('exit', resolve)), delay(3000)])
    if (sampler.exitCode === null) sampler.kill()
  }
  if (backend) backend.kill()
  backendLog.end()
  if (seeded) {
    try {
      sql(`DELETE FROM dbo.Contacts WHERE UserId IN (${usersQuery}) OR ContactUserId IN (${usersQuery});
        DELETE FROM dbo.Users WHERE Username LIKE N'${pattern}';`)
      console.log('Removed only users and contacts created by this load test.')
    } catch (failure) {
      errors.push({ phase: 'cleanup', kind: 'database', message: failure.message })
      process.exitCode = 1
    }
  }
  clientLoopDelay.disable()
  const resources = existsSync(samplesPath) ? readFileSync(samplesPath, 'utf8').trim().split('\n')
    .filter(Boolean).map(line => JSON.parse(line)) : []
  const resourceSummary = []
  for (const name of [...new Set(resources.map(sample => sample.phase))]) {
    for (const processName of ['backend', 'sqlserver', 'client']) {
      const samples = resources.filter(sample => sample.phase === name && sample.process === processName)
      if (!samples.length) continue
      resourceSummary.push({ phase: name, process: processName, samples: samples.length,
        cpuMachinePercent: summary(samples.map(sample => sample.cpuMachinePercent).filter(Number.isFinite)),
        workingSetMiB: summary(samples.map(sample => sample.workingSetMiB)),
        privateMiB: summary(samples.map(sample => sample.privateMiB)),
        maxThreads: Math.max(...samples.map(sample => sample.threads)),
        maxHandles: Math.max(...samples.map(sample => sample.handles)),
      })
    }
  }
  const result = {
    runId, completed, generatedAt: new Date().toISOString(),
    configuration: { build: 'Release', intervalSeconds: 15, timeoutSeconds: 60,
      transport: 'WebSockets', distinctUsers: 1000, contacts: 'chain, at most two watchers per user',
      authenticationSetup: 'Real login API with distinct loopback source IPs; account insertion outside measured phases',
      logicalProcessors: os.cpus().length, cpuModel: os.cpus()[0].model,
      systemMemoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
      backendAndSqlAndGeneratorOnSameMachine: true },
    stages, resourceSummary,
    connectionStartMs: summary(connectionsSamples.map(sample => sample.ms)),
    expectedOfflineMs: summary(offlineEvents.filter(event => event.expected).map(event => event.silenceMs)),
    clientEventLoopDelayMs: { p99: clientLoopDelay.percentile(99) / 1e6, max: clientLoopDelay.max / 1e6 },
    errors,
  }
  writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2))
  const rows = stages.map(stage => {
    const resource = resourceSummary.find(sample => sample.phase === stage.phase && sample.process === 'backend')
    return `| ${stage.phase} | ${stage.target} | ${stage.heartbeatAckMs?.count ?? 0} | ${stage.heartbeatAckMs?.p95 ?? '-'} | ${resource?.cpuMachinePercent?.mean ?? '-'} | ${resource?.workingSetMiB.max ?? '-'} | ${resource?.privateMiB.max ?? '-'} | ${stage.errors} |`
  })
  writeFileSync(path.join(output, 'summary.md'), [
    '# Heartbeat load test', '',
    `Run: ${runId}. Completed: ${completed}.`, '',
    '| Phase | Connections | ACKs | ACK p95 ms | Backend CPU mean % machine | Peak working set MiB | Peak private MiB | Errors |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |', ...rows, '',
    'All clients, backend and SQL Server ran on this machine. Each connection used a different account.',
    'Accounts were seeded outside measured phases; login used separate loopback source IPs to represent separate clients without changing the production rate limiter.',
    'Steady phases used 15-second heartbeats. Ten clients at 1000 connections stopped heartbeat while keeping their sockets alive.',
    'CPU is normalized across all logical processors. Working set/private memory are process metrics, not managed live-heap measurements.',
    'This measures heartbeat/presence, not chat throughput, file transfer, WAN latency, authentication capacity or maximum system capacity.',
    'Cooldown retains unexpired login sessions. Memory remaining can also be allocator/GC high-water retention; a short run cannot establish or exclude a memory leak.', '',
    `Errors: ${JSON.stringify(errors)}`, '',
    'Detailed metrics: results.json. One-second samples: resources.jsonl.', '',
  ].join('\n'))
  console.log('RESULTS ' + path.join(output, 'results.json'))
  console.log(JSON.stringify({ completed, stages, errors }, null, 2))
}

import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

assert.equal(process.platform, 'linux', 'Run on the authorized AWS Linux host only.')
assert.equal(process.env.LOAD_TEST_AUTHORIZED, 'wiremess', 'Explicit target authorization required.')
const maximum = Number(process.env.LOAD_MAX_USERS || 7500)
const holdSeconds = Number(process.env.LOAD_HOLD_SECONDS || 35)
assert.ok(Number.isInteger(maximum) && maximum >= 2 && maximum <= 8000 && maximum % 2 === 0)
assert.ok(holdSeconds >= 15 && holdSeconds <= 120)
const require = createRequire('/home/ubuntu/pbl4/frontend/package.json')
const signalR = require('@microsoft/signalr')
const runId = new Date().toISOString().replaceAll(':', '-') + '-' + randomBytes(4).toString('hex')
const prefix = 'awsload' + randomBytes(6).toString('hex')
const output = path.join('/home/ubuntu/pbl4-loadtest', runId)
mkdirSync(output, { recursive: true, mode: 0o700 })
const password = 'Load-' + randomBytes(24).toString('hex')
const envText = readFileSync('/etc/pbl4/pbl4.env', 'utf8')
const connectionLine = envText.split('\n').find(line => line.startsWith('ConnectionStrings__DefaultConnection='))
const dbPassword = connectionLine?.match(/Password=([^;"\r\n]+)/)?.[1]
assert.ok(dbPassword && connectionLine.includes('Database=PBL4;') && connectionLine.includes('User ID=pbl4_backend;'))
const sqlEnv = { ...process.env, SQLCMDPASSWORD: dbPassword }
const userIds = `SELECT Id FROM dbo.Users WHERE Username LIKE N'${prefix}[_]%'`
const conversations = `SELECT Id FROM dbo.DirectConversations WHERE UserAID IN (${userIds}) AND UserBID IN (${userIds})`
const clients = []
const clientById = new Map()
const deliveries = new Map()
const stages = []
const samples = []
const heartbeat = []
const errors = []
const loop = monitorEventLoopDelay({ resolution: 20 })
loop.enable()
let phase = 'setup', stopReason = '', closing = false, owned = false, sampleBusy = false
let sampler, baseline, cleanup, previousCpu, previousProc = new Map(), highCpuCount = 0, healthFailures = 0
const backendPid = Number(execFileSync('systemctl', ['show', 'pbl4', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim())
const cpuCount = os.cpus().length
const deadline = Date.now() + 15 * 60 * 1000

// Chi bao cao thong tin chan doan, khong de token hoac mat khau lot vao ket qua.
function safe(value) {
  return String(value).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<REDACTED>')
    .replace(/access_token=[^\s&"']+/g, 'access_token=<REDACTED>').split(password).join('<REDACTED>')
    .split(dbPassword).join('<REDACTED>').slice(0, 500)
}

// SQL chi chuan bi va don du lieu co prefix ngau nhien cua luot thu nay.
function sql(query) {
  return execFileSync('/opt/mssql-tools18/bin/sqlcmd', ['-S', '127.0.0.1', '-U', 'pbl4_backend',
    '-d', 'PBL4', '-C', '-b', '-l', '5', '-t', '45', '-h', '-1', '-W', '-s', '|', '-Q',
    'SET NOCOUNT ON; SET XACT_ABORT ON; SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON; ' +
    'SET ANSI_PADDING ON; SET ANSI_WARNINGS ON; SET CONCAT_NULL_YIELDS_NULL ON; ' +
    'SET ARITHABORT ON; SET NUMERIC_ROUNDABORT OFF; ' + query],
  { env: sqlEnv, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// Dem bang nghiep vu de doi chieu truoc va sau khi don du lieu thu.
function counts() {
  const tables = ['Users', 'Contacts', 'DirectConversations', 'Messages', 'FileTransfers', 'Calls', 'AdminAuditLogs']
  return Object.fromEntries(sql(tables.map(name => `SELECT '${name}', COUNT_BIG(*) FROM dbo.${name}`).join(' UNION ALL '))
    .split(/\r?\n/).map(line => { const [key, value] = line.split('|'); return [key.trim(), Number(value)] }))
}

// Gioi han so tac vu dong thoi; doi tat ca worker truoc khi bat dau don dep.
async function pool(items, concurrency, action, guard = true) {
  let cursor = 0
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      if (guard) check()
      const index = cursor++
      await action(items[index], index)
    }
  }))
  const failed = results.find(result => result.status === 'rejected')
  if (failed) throw failed.reason
}

// Phan vi dung nearest-rank, khong suy rong thanh so user toi da cua san pham.
function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const percentile = p => Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)].toFixed(2))
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: sorted.at(-1) }
}

// Dung tang tai khi RAM, health, CPU hoac so loi vuot nguong da dat.
function check() {
  if (Date.now() > deadline) stopReason ||= 'Fifteen minute runtime budget reached.'
  if (stopReason) throw new Error(stopReason)
  if (errors.filter(item => item.phase === phase).length >= 10) throw new Error('Ten errors in current phase.')
}

// Goi API dang nhap that bang nhieu IP loopback de mo phong nhieu may, khong tat rate limiter.
function loginApi(pathname, body, index = 0) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const localAddress = `127.23.${Math.floor(index / 250)}.${index % 250 + 1}`
    const request = http.request('http://127.0.0.1:5000/api/v1' + pathname, {
      method: 'POST', localAddress, agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, response => {
      let text = ''
      response.on('data', chunk => { text += chunk })
      response.on('end', () => {
        if (response.statusCode >= 400) return reject(new Error(`Setup ${pathname}: HTTP ${response.statusCode}`))
        try { resolve(JSON.parse(text)) } catch { reject(new Error('Invalid setup API JSON.')) }
      })
    })
    request.setTimeout(20000, () => request.destroy(new Error('Setup request timed out.')))
    request.on('error', reject)
    request.end(payload)
  })
}

// Them gioi han thoi gian cho hub invocation, tranh treo viec don dep.
function bounded(promise, milliseconds = 10000) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Hub invocation timed out.')), milliseconds)
  })]).finally(() => clearTimeout(timer))
}

// Do heartbeat ACK va cap nhat online nhu frontend that.
async function beat(client) {
  const at = performance.now(), current = phase
  try {
    await bounded(client.connection.invoke('Heartbeat'))
    heartbeat.push({ phase: current, ms: performance.now() - at })
  } catch (failure) { if (!closing) errors.push({ phase: current, kind: 'heartbeat', message: safe(failure.message) }) }
}

// Rai nhip dau de tranh moi client cung danh thuc dung mot thoi diem.
function schedule(client, first = false) {
  client.timer = setTimeout(async () => {
    if (closing || stopReason) return
    await beat(client)
    if (!closing && !stopReason) schedule(client)
  }, first ? 500 + Math.random() * 14500 : 15000)
}

// Mo mot user that qua TLS/Nginx rt.wiremess.io.vn; moi user co mot socket.
async function openClient(row, index) {
  const session = await loginApi('/sessions', { username: row.username, password }, index + 1)
  const connection = new signalR.HubConnectionBuilder().withUrl('https://rt.wiremess.io.vn/hubs/chat', {
    accessTokenFactory: () => session.accessToken,
    transport: signalR.HttpTransportType.WebSockets, skipNegotiation: true,
  }).configureLogging(signalR.LogLevel.None).build()
  const client = { ...row, token: session.accessToken, connection, timer: null }
  clients.push(client)
  clientById.set(client.id, client)
  for (const event of ['MessageStatusChanged', 'TypingChanged', 'ConversationChanged', 'PresenceChanged',
    'TextSessionStarted', 'TextSignal', 'TextSessionClosed', 'FileChanged', 'FileSignal']) connection.on(event, () => {})
  connection.on('MessageReceived', message => {
    const pending = deliveries.get(message.clientMessageId)
    if (pending && message.senderId !== client.id && pending.peerId === client.id)
      pending.resolve(performance.now() - pending.at)
  })
  connection.onclose(failure => {
    clearTimeout(client.timer)
    if (!closing) errors.push({ phase, kind: 'disconnect', message: safe(failure?.message || 'Unexpected close') })
  })
  const at = performance.now()
  await bounded(connection.start(), 20000)
  client.openMs = performance.now() - at
  await beat(client)
  schedule(client, true)
  if ((index + 1) % 250 === 0)
    console.log(JSON.stringify({ event: 'ramp-progress', phase, opened: index + 1 }))
  // Nhuong CPU trong luc chuan bi, khong bien login thanh bai stress mat khau.
  await delay(120)
}

// Doc CPU/RAM truc tiep tu procfs, tach CPU backend va may tao tai.
async function sample() {
  if (sampleBusy || closing) return
  sampleBusy = true
  try {
    const memory = readFileSync('/proc/meminfo', 'utf8')
    const availableMiB = Number(memory.match(/^MemAvailable:\s+(\d+)/m)[1]) / 1024
    const totalMiB = Number(memory.match(/^MemTotal:\s+(\d+)/m)[1]) / 1024
    const cpu = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number)
    const total = cpu.slice(0, 8).reduce((sum, value) => sum + value, 0)
    const idle = cpu[3] + cpu[4]
    const delta = previousCpu ? total - previousCpu.total : 0
    const cpuPercent = delta > 0 ? 100 * (1 - (idle - previousCpu.idle) / delta) : null
    previousCpu = { total, idle }
    const processes = {}
    for (const [name, pid] of [['backend', backendPid], ['generator', process.pid]]) {
      const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')
      const ticks = Number(fields[11]) + Number(fields[12])
      const rss = Number(readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)[1]) / 1024
      processes[name] = { rssMiB: rss, cpuMachinePercent: delta > 0 && previousProc.has(pid)
        ? 100 * (ticks - previousProc.get(pid)) / delta : null }
      previousProc.set(pid, ticks)
    }
    const at = performance.now()
    let healthMs = null
    try {
      const response = await fetch('http://127.0.0.1:5000/health/ready', { signal: AbortSignal.timeout(3000) })
      await response.text()
      if (response.status !== 200) throw new Error('Readiness failed.')
      healthMs = performance.now() - at
      healthFailures = 0
    } catch { healthFailures++ }
    const record = { at: new Date().toISOString(), phase, connected: clients.filter(c => c.connection.state === 'Connected').length,
      availableMiB, totalMiB, cpuPercent, healthMs, processes, loopP95Ms: loop.percentile(95) / 1e6 }
    samples.push(record)
    writeFileSync(path.join(output, 'progress.json'), JSON.stringify(record), { mode: 0o600 })
    if (availableMiB < 1024) stopReason ||= 'Available RAM fell below 1024 MiB.'
    if (healthFailures >= 2) stopReason ||= 'Readiness failed twice.'
    highCpuCount = phase.startsWith('steady-') && cpuPercent > 90 ? highCpuCount + 1 : 0
    if (highCpuCount >= 5) stopReason ||= 'CPU exceeded 90 percent for sustained samples.'
  } catch (failure) { stopReason ||= 'Resource sampler: ' + safe(failure.message) }
  finally { sampleBusy = false }
}

// Moi user gui mot tin nho; do ACK SQL va thoi gian peer nhan duoc, khong chi dem socket.
async function chatRound(active) {
  const ack = [], delivered = []
  await pool(active, 6, async client => {
    const uuid = randomUUID(), at = performance.now()
    let resolve
    const received = new Promise(done => { resolve = done })
    deliveries.set(uuid, { peerId: client.peerId, at, resolve })
    try {
      await bounded(client.connection.invoke('SendMessage', {
        conversationId: client.conversationId, clientMessageId: uuid, content: 'AWS capacity ' + prefix,
      }))
      ack.push(performance.now() - at)
      delivered.push(await bounded(received, 5000))
    } catch (failure) { errors.push({ phase, kind: 'chat', message: safe(failure.message) }) }
    finally { deliveries.delete(uuid) }
    await delay(15)
  })
  return { messageAckMs: stats(ack), peerDeliveryMs: stats(delivered) }
}

// Do API mo thread qua duong cong khai hien tai, khong ghi du lieu hoac luu noi dung chat.
async function apiRound(active) {
  const times = []
  await pool(Array.from({ length: 12 }, (_, index) => active[index % active.length]), 2, async client => {
    const at = performance.now()
    try {
      const response = await fetch(`https://wiremess.io.vn/api/v1/conversations/${client.conversationId}`, {
        headers: { Authorization: 'Bearer ' + client.token }, signal: AbortSignal.timeout(10000), cache: 'no-store',
      })
      await response.text()
      if (response.status !== 200) throw new Error('Conversation API HTTP ' + response.status)
      times.push(performance.now() - at)
    } catch (failure) { errors.push({ phase, kind: 'api', message: safe(failure.message) }) }
  })
  return stats(times)
}

// Gom tai nguyen cua mot phase, bao cao ca RAM may tao tai cung nam tren EC2.
function resourceSummary(name) {
  const rows = samples.filter(item => item.phase === name)
  return { samples: rows.length, cpuPercent: stats(rows.map(r => r.cpuPercent)),
    minimumAvailableMiB: rows.length ? Math.min(...rows.map(r => r.availableMiB)) : null,
    backendRssMiB: stats(rows.map(r => r.processes.backend.rssMiB)),
    generatorRssMiB: stats(rows.map(r => r.processes.generator.rssMiB)),
    backendCpuPercent: stats(rows.map(r => r.processes.backend.cpuMachinePercent)),
    readinessMs: stats(rows.map(r => r.healthMs)) }
}

// Ngat co kiem soat van di qua finally de dong socket, thu hoi phien va don SQL.
process.on('SIGINT', () => { stopReason ||= 'Interrupted by operator.' })
process.on('SIGTERM', () => { stopReason ||= 'Terminated by operator.' })
console.log(JSON.stringify({ event: 'start', runId, prefix, output, maximum, cpuCount, holdSeconds }))
try {
  assert.ok(backendPid > 0)
  baseline = counts()
  assert.equal(sql(`SELECT COUNT(*) FROM dbo.Users WHERE Username LIKE N'${prefix}[_]%'`), '0')
  owned = true
  await loginApi('/users', { username: prefix + '_seed', displayName: 'AWS load seed', password })
  sql(`BEGIN TRANSACTION;
    WITH n AS (SELECT TOP (${maximum}) ROW_NUMBER() OVER(ORDER BY (SELECT NULL))-1 AS n
      FROM sys.all_objects a CROSS JOIN sys.all_objects b)
    INSERT dbo.Users(Username,PasswordHash,DisplayName,Role)
      SELECT CONCAT('${prefix}_',n),s.PasswordHash,CONCAT('AWS load ',n),'User'
      FROM n CROSS JOIN (SELECT PasswordHash FROM dbo.Users WHERE Username='${prefix}_seed')s;
    WITH u AS (SELECT Id,TRY_CONVERT(int,SUBSTRING(Username,${prefix.length + 2},20))n FROM dbo.Users
      WHERE Username LIKE N'${prefix}[_]%' AND Username<>'${prefix}_seed')
    INSERT dbo.Contacts(UserId,ContactUserId) SELECT a.Id,b.Id FROM u a JOIN u b ON b.n=a.n+1;
    WITH u AS (SELECT Id,TRY_CONVERT(int,SUBSTRING(Username,${prefix.length + 2},20))n FROM dbo.Users
      WHERE Username LIKE N'${prefix}[_]%' AND Username<>'${prefix}_seed')
    INSERT dbo.DirectConversations(UserAID,UserBID)
      SELECT IIF(a.Id<b.Id,a.Id,b.Id),IIF(a.Id<b.Id,b.Id,a.Id) FROM u a JOIN u b ON b.n=a.n+1 WHERE a.n%2=0;
    COMMIT;`)
  const rows = sql(`WITH u AS (SELECT Id,Username,TRY_CONVERT(int,SUBSTRING(Username,${prefix.length + 2},20))n
    FROM dbo.Users WHERE Username LIKE N'${prefix}[_]%' AND Username<>'${prefix}_seed')
    SELECT a.Id,a.Username,c.Id,b.Id FROM u a JOIN u b ON b.n=IIF(a.n%2=0,a.n+1,a.n-1)
    JOIN dbo.DirectConversations c ON c.UserAID=IIF(a.Id<b.Id,a.Id,b.Id) AND c.UserBID=IIF(a.Id<b.Id,b.Id,a.Id)
    ORDER BY a.n;`).split(/\r?\n/).map(line => {
    const [id, username, conversationId, peerId] = line.split('|').map(value => value.trim())
    return { id: Number(id), username, conversationId, peerId: Number(peerId) }
  })
  assert.equal(rows.length, maximum)
  await sample()
  sampler = setInterval(() => { void sample() }, 2000)
  const requestedTargets = process.env.LOAD_TARGETS ? process.env.LOAD_TARGETS.split(',').map(Number)
    : [50,100,250,500,1000,2000,3000,5000,7500,maximum].filter(n => n <= maximum)
  assert.ok(requestedTargets.every(n => Number.isInteger(n) && n >= 2 && n <= maximum && n % 2 === 0))
  const targets = [...new Set(requestedTargets)].sort((a,b) => a-b)
  for (const target of targets) {
    check()
    phase = 'ramp-' + target
    console.log(JSON.stringify({ event: 'phase', phase, connected: clients.length }))
    const rampStart = performance.now(), previousCount = clients.length
    await pool(rows.slice(previousCount, target), 4, (row,index) => openClient(row,previousCount+index))
    phase = 'steady-' + target
    const steadyStart = performance.now()
    console.log(JSON.stringify({ event: 'phase', phase, rampSeconds: (performance.now()-rampStart)/1000 }))
    const active = clients.slice(0,target)
    const [chat, apiMs] = await Promise.all([chatRound(active), apiRound(active)])
    while (performance.now() - steadyStart < holdSeconds * 1000) { check(); await delay(1000) }
    await sample()
    const hb = stats(heartbeat.filter(item => item.phase === phase).map(item => item.ms))
    const row = { target, phase, durationSeconds: (performance.now()-steadyStart)/1000,
      connected: active.filter(c => c.connection.state === 'Connected').length,
      connectionStartMs: stats(active.slice(previousCount).map(c => c.openMs)), heartbeatMs: hb,
      ...chat, publicConversationApiMs: apiMs, resources: resourceSummary(phase),
      errors: errors.filter(item => item.phase === phase).length }
    stages.push(row)
    console.log(JSON.stringify({ event: 'stage', ...row }))
    check()
    if (row.connected !== target || row.errors || chat.messageAckMs?.count !== target || chat.peerDeliveryMs?.count !== target)
      throw new Error('Current stage did not deliver all messages or keep all clients connected.')
    if (hb?.p95 > 1000 || chat.messageAckMs?.p95 > 2000) throw new Error('Latency safety threshold reached.')
  }
} catch (failure) {
  stopReason ||= safe(failure.message)
  console.log(JSON.stringify({ event: 'stop', phase, reason: stopReason, connected: clients.length }))
} finally {
  phase = 'cleanup'; closing = true
  clearInterval(sampler)
  for (const client of clients) clearTimeout(client.timer)
  await pool(clients,20,client => bounded(client.connection.stop(),10000).catch(() => {}),false)
  await pool(clients,10,async client => {
    try { const response = await fetch('http://127.0.0.1:5000/api/v1/sessions/current', {
      method: 'DELETE', headers: { Authorization: 'Bearer '+client.token }, signal: AbortSignal.timeout(5000),
    }); await response.text() } catch { }
  },false)
  await delay(1500)
  if (owned) {
    try {
      sql(`BEGIN TRANSACTION;
        DELETE FROM dbo.Messages WHERE ConversationId IN (${conversations});
        DELETE FROM dbo.Contacts WHERE UserId IN (${userIds}) OR ContactUserId IN (${userIds});
        DELETE FROM dbo.DirectConversations WHERE Id IN (${conversations});
        DELETE FROM dbo.Users WHERE Id IN (${userIds}); COMMIT;`)
      cleanup = { remainingTestUsers: Number(sql(`SELECT COUNT(*) FROM dbo.Users WHERE Username LIKE N'${prefix}[_]%'`)),
        before: baseline, after: counts() }
    } catch (failure) { cleanup = { error: safe(failure.message) } }
  }
  loop.disable()
  const result = { runId, prefix, generatedAt: new Date().toISOString(), maximumRequested: maximum,
    maximumAttempted: clients.length,
    maximumOpened: clients.filter(client => Number.isFinite(client.openMs)).length,
    completed: !stopReason, stopReason, stages, errors, cleanup,
    conditions: { cpuCount, totalRamMiB: os.totalmem()/1024**2, generatorOnSameEc2: true,
      applicationRelease: '/opt/pbl4/current', transport: 'WebSockets through rt TLS/Nginx',
      setup: 'Real API login from distinct loopback addresses; SQL seed outside measured stages',
      heartbeatSeconds: 15, chat: 'One message per user per stage; six send operations concurrently',
      api: 'Twelve authenticated conversation GET requests per stage via OneShield',
      limitations: 'Not a browser rendering, simultaneous login, P2P, TURN, file transfer or endurance test.' } }
  writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2),{mode:0o600})
  writeFileSync(path.join(output,'resources.jsonl'),samples.map(row=>JSON.stringify(row)).join('\n')+'\n',{mode:0o600})
  console.log(JSON.stringify({event:'finished',output,maximumAttempted:clients.length,
    maximumOpened:result.maximumOpened,stopReason,cleanup}))
  if (cleanup?.remainingTestUsers !== 0 || cleanup?.error) process.exitCode=2
}

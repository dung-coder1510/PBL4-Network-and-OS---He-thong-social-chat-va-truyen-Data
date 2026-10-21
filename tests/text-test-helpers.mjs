import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

export const origin = process.env.TEXT_TEST_ORIGIN || 'http://127.0.0.1:5173'
const server = process.env.AUTH_TEST_SQL_SERVER
const database = process.env.AUTH_TEST_DATABASE
if (!server || !database || !['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
  throw new Error('Use localhost and set AUTH_TEST_SQL_SERVER / AUTH_TEST_DATABASE.')
const require = createRequire(new URL('../frontend/package.json', import.meta.url))
const signalR = require('@microsoft/signalr')

export function sql(query) {
  return execFileSync('sqlcmd', ['-S', server, '-d', database, '-E', '-C', '-b', '-l', '5', '-h', '-1', '-W',
    '-Q', 'SET NOCOUNT ON; SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON; SET ANSI_PADDING ON; ' +
    'SET ANSI_WARNINGS ON; SET CONCAT_NULL_YIELDS_NULL ON; SET ARITHABORT ON; SET NUMERIC_ROUNDABORT OFF; ' + query],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(origin + '/api/v1' + path, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  })
  return { status: response.status, data: await response.json().catch(() => null) }
}

export async function waitFor(action, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await action()
    if (predicate(result)) return result
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for text test condition.')
}

export function testRun() {
  const prefix = 'p2ptest_' + randomUUID().replaceAll('-', '').slice(0, 10)
  const password = 'Test-' + randomUUID()
  const names = [prefix + 'a', prefix + 'b', prefix + 'c']
  const users = []
  const tokens = []
  const hubs = []
  const timers = []
  let owned = false
  return {
    names, password, users, tokens, hubs,
    async register() {
      assert.equal(sql(`SELECT COUNT(*) FROM dbo.Users WHERE Username IN ('${names.join("','")}')`), '0')
      owned = true
      for (const username of names) {
        const user = await api('/users', { method: 'POST', body: { username, password, displayName: username } })
        assert.equal(user.status, 201)
        users.push(user.data)
        const login = await api('/sessions', { method: 'POST', body: { username, password } })
        assert.equal(login.status, 201)
        tokens.push(login.data.accessToken)
      }
    },
    async connect(token) {
      const hub = new signalR.HubConnectionBuilder().withUrl(origin + '/hubs/chat', {
        accessTokenFactory: () => token,
      }).configureLogging(signalR.LogLevel.Error).build()
      for (const name of ['MessageReceived', 'MessageStatusChanged', 'ConversationChanged', 'PresenceChanged',
        'TypingChanged', 'TextSessionStarted', 'TextSignal', 'TextSessionClosed', 'FileChanged', 'FileSignal'])
        hub.on(name, () => {})
      hubs.push(hub)
      await hub.start()
      await hub.invoke('Heartbeat')
      timers.push(setInterval(() => { if (hub.state === 'Connected') void hub.invoke('Heartbeat').catch(() => {}) }, 15000))
      return hub
    },
    async cleanup() {
      for (const timer of timers) clearInterval(timer)
      await Promise.allSettled(hubs.map(hub => hub.stop()))
      if (owned) {
        const ids = `SELECT Id FROM dbo.Users WHERE Username IN ('${names.join("','")}')`
        const conversations = `SELECT Id FROM dbo.DirectConversations WHERE UserAID IN (${ids}) AND UserBID IN (${ids})`
        sql(`DELETE FROM dbo.FileTransfers WHERE ConversationId IN (${conversations});
          DELETE FROM dbo.Messages WHERE ConversationId IN (${conversations});
          DELETE FROM dbo.Contacts WHERE UserId IN (${ids}) OR ContactUserId IN (${ids});
          DELETE FROM dbo.DirectConversations WHERE Id IN (${conversations});
          DELETE FROM dbo.Users WHERE Username IN ('${names.join("','")}')`)
      }
    },
  }
}

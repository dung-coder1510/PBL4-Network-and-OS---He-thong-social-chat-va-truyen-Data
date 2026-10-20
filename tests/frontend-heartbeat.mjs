import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHeartbeatLoop } from '../frontend/src/services/heartbeat.js'

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

test('sends immediately, then every 15 seconds, and stops cleanly', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let sent = 0
  const heartbeat = createHeartbeatLoop(async () => {
    sent++
    return { intervalSeconds: 15 }
  })
  heartbeat.start()
  await flush()
  assert.equal(sent, 1)
  context.mock.timers.tick(14999)
  assert.equal(sent, 1)
  context.mock.timers.tick(1)
  await flush()
  assert.equal(sent, 2)
  heartbeat.stop()
  context.mock.timers.tick(60000)
  assert.equal(sent, 2)
})

test('a failed heartbeat retries and reports the failure', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let attempts = 0
  const failures = []
  const heartbeat = createHeartbeatLoop(async () => {
    attempts++
    if (attempts === 1) throw new Error('Disconnected')
    return { intervalSeconds: 15 }
  }, failure => failures.push(failure.message))
  heartbeat.start()
  await flush()
  assert.deepEqual(failures, ['Disconnected'])
  context.mock.timers.tick(15000)
  await flush()
  assert.equal(attempts, 2)
  heartbeat.stop()
})

test('restarting during an outstanding ACK does not overlap requests or duplicate timers', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let finish
  let sent = 0
  const heartbeat = createHeartbeatLoop(() => {
    sent++
    if (sent === 1) return new Promise(resolve => { finish = resolve })
    return Promise.resolve({ intervalSeconds: 15 })
  })
  heartbeat.start()
  heartbeat.stop()
  heartbeat.start()
  heartbeat.start()
  assert.equal(sent, 1)
  finish({ intervalSeconds: 1 })
  await flush()
  assert.equal(sent, 2)
  context.mock.timers.tick(15000)
  await flush()
  assert.equal(sent, 3)
  heartbeat.stop()
})

test('an ACK arriving after cleanup cannot start another timer', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let finish
  let sent = 0
  const heartbeat = createHeartbeatLoop(() => {
    sent++
    return new Promise(resolve => { finish = resolve })
  })
  heartbeat.start()
  heartbeat.stop()
  finish({ intervalSeconds: 15 })
  await flush()
  context.mock.timers.tick(60000)
  assert.equal(sent, 1)
})

test('uses the interval returned by the server', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let sent = 0
  const heartbeat = createHeartbeatLoop(async () => {
    sent++
    return { intervalSeconds: 20 }
  })
  heartbeat.start()
  await flush()
  context.mock.timers.tick(15000)
  assert.equal(sent, 1)
  context.mock.timers.tick(5000)
  await flush()
  assert.equal(sent, 2)
  heartbeat.stop()
})

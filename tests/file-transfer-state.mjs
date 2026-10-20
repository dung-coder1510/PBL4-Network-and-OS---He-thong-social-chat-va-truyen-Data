import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForTransferring } from '../frontend/src/services/fileTransferState.js'

test('waits for delayed transferring metadata and returns its new version', async () => {
  let transfer = { status: 'accepted', version: 'old' }
  const changes = new EventTarget()
  let completed = false
  const waiting = waitForTransferring(() => transfer, changes, new AbortController().signal)
    .then(current => { completed = true; return current })
  changes.dispatchEvent(new Event('change'))
  await Promise.resolve()
  assert.equal(completed, false)
  transfer = { status: 'transferring', version: 'new' }
  changes.dispatchEvent(new Event('change'))
  assert.equal((await waiting).version, 'new')
})

test('does not wait if the transferring notification already arrived', async () => {
  const transfer = { status: 'transferring', version: 'current' }
  assert.equal(await waitForTransferring(() => transfer, new EventTarget(),
    new AbortController().signal), transfer)
})

test('cancelled, failed, expired and completed sessions never authorize completion', async () => {
  for (const status of ['cancelled', 'failed', 'expired', 'completed', 'rejected']) {
    let transfer = { status: 'accepted' }
    const changes = new EventTarget()
    const waiting = waitForTransferring(() => transfer, changes, new AbortController().signal)
    transfer = { status }
    changes.dispatchEvent(new Event('change'))
    await assert.rejects(waiting, /đã kết thúc/)
  }
})

test('disconnect or cancellation aborts the wait and removes state listeners', async () => {
  const changes = new EventTarget()
  const controller = new AbortController()
  let reads = 0
  const waiting = waitForTransferring(() => {
    reads++
    return { status: 'accepted' }
  }, changes, controller.signal)
  controller.abort()
  await assert.rejects(waiting, { name: 'AbortError' })
  changes.dispatchEvent(new Event('change'))
  assert.equal(reads, 1)
})

test('an already aborted peer cannot confirm even when its metadata is transferring', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(waitForTransferring(() => ({ status: 'transferring' }),
    new EventTarget(), controller.signal), { name: 'AbortError' })
})

test('missing or locally failed metadata cannot authorize completion', async () => {
  for (const transfer of [null, { status: 'transferring', localFailure: true }])
    await assert.rejects(waitForTransferring(() => transfer, new EventTarget(),
      new AbortController().signal), /đã kết thúc/)
})

test('missing notification times out and releases its state listener', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const changes = new EventTarget()
  let reads = 0
  const waiting = waitForTransferring(() => {
    reads++
    return { status: 'accepted' }
  }, changes, new AbortController().signal)
  const rejected = assert.rejects(waiting, /Hết thời gian/)
  context.mock.timers.tick(60000)
  await rejected
  changes.dispatchEvent(new Event('change'))
  assert.equal(reads, 1)
})

test('successful synchronization releases listeners before later updates', async () => {
  const changes = new EventTarget()
  let reads = 0
  await waitForTransferring(() => {
    reads++
    return { status: 'transferring' }
  }, changes, new AbortController().signal)
  changes.dispatchEvent(new Event('change'))
  assert.equal(reads, 1)
})

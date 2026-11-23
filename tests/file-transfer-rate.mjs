import assert from 'node:assert/strict'
import test from 'node:test'
import { createTransferRate } from '../frontend/src/services/fileTransferRate.js'

test('current speed excludes negotiation and the wait for the first file bytes', () => {
  const rate = createTransferRate(0)
  assert.equal(rate.sample(250_000, 10_000).bytesPerSecond, 0)
  const sample = rate.sample(1_250_000, 10_250)
  assert.equal(sample.bytesPerSecond, 4_000_000)
  assert.ok(sample.averageBytesPerSecond < 125_000)
})

test('the one-second window follows a speed change instead of averaging the entire file', () => {
  const rate = createTransferRate(0)
  rate.sample(0, 0)
  rate.sample(1_000_000, 1000)
  const fast = rate.sample(9_000_000, 2000)
  assert.equal(fast.bytesPerSecond, 8_000_000)
  assert.equal(fast.averageBytesPerSecond, 4_500_000)
  const stalled = rate.sample(9_000_000, 4000)
  assert.equal(stalled.bytesPerSecond, 0)
  assert.equal(stalled.averageBytesPerSecond, 2_250_000)
})

test('same-timestamp samples and a restarted counter do not produce negative or infinite speed', () => {
  const rate = createTransferRate(0)
  rate.sample(0, 0)
  rate.sample(100, 100)
  assert.equal(rate.sample(200, 100).bytesPerSecond, 2000)
  const restarted = rate.sample(0, 200)
  assert.equal(restarted.bytesPerSecond, 0)
  assert.equal(restarted.averageBytesPerSecond, 0)
  assert.equal(rate.sample(1000, 450).bytesPerSecond, 4000)
})

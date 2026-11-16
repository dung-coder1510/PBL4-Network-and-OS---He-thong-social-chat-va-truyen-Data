import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createFileStorage, pickFileDestination } from '../frontend/src/services/fileStorage.js'

function mockPicker(t, picker) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'showSaveFilePicker')
  Object.defineProperty(globalThis, 'showSaveFilePicker', { configurable: true, value: picker })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'showSaveFilePicker', previous)
    else delete globalThis.showSaveFilePicker
  })
}

test('receiving audio refuses an exe destination returned by Save As', async t => {
  mockPicker(t, async () => ({ name: 'B.exe' }))
  await assert.rejects(() => pickFileDestination('A.m4a'), /\.m4a/)
})

test('Save As proposes the audio extension and only its matching file type', async t => {
  let options
  mockPicker(t, async value => { options = value; return { name: 'Bản thu mới.M4A' } })
  const target = await pickFileDestination('Bản thu gốc.m4a')
  assert.equal(target.name, 'Bản thu mới.M4A')
  assert.equal(options.suggestedName, 'Bản thu gốc.m4a')
  assert.equal(options.excludeAcceptAllOption, true)
  assert.deepEqual(options.types[0].accept, { 'application/octet-stream': ['.m4a'] })
})

test('shortening a long suggested name keeps its original extension', async t => {
  let suggestedName
  mockPicker(t, async options => { suggestedName = options.suggestedName; return { name: suggestedName } })
  await pickFileDestination('a'.repeat(240) + '.mp3')
  assert.ok(suggestedName.length <= 180)
  assert.ok(suggestedName.endsWith('.mp3'))
})

for (const [source, destination] of [
  ['a.mp3', 'b.mp3'], ['report.PDF', 'bản báo cáo.pdf'], ['archive.tar.gz', 'copy.gz'],
  ['setup.exe', 'setup (1).exe'], ['README', 'README-copy'], ['.gitignore', '.env'],
  ['file.abcdefghijklmnop', 'copy.abcdefghijklmnop'],
]) {
  test(`renaming ${source} to ${destination} preserves its extension`, async t => {
    mockPicker(t, async () => ({ name: destination }))
    assert.equal((await pickFileDestination(source)).name, destination)
  })
}

test('rejects removing or appending another extension', async t => {
  let destination
  mockPicker(t, async () => ({ name: destination }))
  for (destination of ['audio', 'audio.mp3.exe'])
    await assert.rejects(() => pickFileDestination('audio.mp3'), /\.mp3/)
  destination = 'README.exe'
  await assert.rejects(() => pickFileDestination('README'), /không có đuôi/)
})

test('reserved Windows names keep their extension in the suggested replacement', async t => {
  mockPicker(t, async options => ({ name: options.suggestedName }))
  assert.equal((await pickFileDestination('CON.mp3')).name, 'tep.mp3')
})

test('unsupported filter suffixes use the picker without invalid types', async t => {
  mockPicker(t, async options => {
    assert.equal(options.types, undefined)
    assert.equal(options.excludeAcceptAllOption, undefined)
    return { name: options.suggestedName }
  })
  for (const name of ['README', 'file.abcdefghijklmnop', 'source.c++'])
    assert.equal((await pickFileDestination(name)).name, name)
})

test('cancelling Save As preserves the AbortError for the accept flow', async t => {
  mockPicker(t, async () => { throw new DOMException('Cancelled', 'AbortError') })
  await assert.rejects(() => pickFileDestination('audio.mp3'), { name: 'AbortError' })
})

test('a mismatch leaves the selected writer uncommitted and aborts it', async () => {
  let closed = false
  let aborted = false
  const disk = await createFileStorage({ name: 'received.bin', async createWritable() {
    return { async write() {}, async close() { closed = true }, async abort() { aborted = true } }
  } }, new AbortController().signal, 3)
  await disk.write(0, Uint8Array.of(1, 2, 3))
  assert.throws(() => disk.verify(createHash('sha256').update('wrong data').digest('hex')), /SHA-256 không khớp/)
  await assert.rejects(disk.commit(), /chưa xác minh/)
  await disk.dispose()
  assert.equal(closed, false)
  assert.equal(aborted, true)
})

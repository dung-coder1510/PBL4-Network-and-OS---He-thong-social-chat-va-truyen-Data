import { requestFileContent } from './apiClient.js'
import { createFileStorage } from './fileStorage.js'

export const RELAY_SAMPLE_BYTES = 110_000_000

// Cấp một khối 64 KB rồi tạo Blob tham chiếu các phần, giữ RAM chuẩn bị phép đo ở mức nhỏ.
function sampleFile() {
  const block = new Blob([new Uint8Array(64_000)])
  const chunks = Array(Math.floor(RELAY_SAMPLE_BYTES / block.size)).fill(block)
  chunks.push(block.slice(0, RELAY_SAMPLE_BYTES % block.size))
  return new Blob(chunks, { type: 'application/octet-stream' })
}

export async function measureRelayPath(token, target, signal, onStage) {
  const content = '/files/relay/diagnostics'
  const disk = await createFileStorage(target, signal, RELAY_SAMPLE_BYTES)
  try {
    onStage('Đang đo tải lên máy chủ…')
    const sample = sampleFile()
    const uploadStart = performance.now()
    const upload = await requestFileContent(content, { method: 'PUT', body: sample, token, signal })
    const uploaded = await upload.json()
    if (uploaded.receivedBytes !== RELAY_SAMPLE_BYTES) throw new Error('Phép đo tải lên thiếu byte.')
    const uploadSeconds = (performance.now() - uploadStart) / 1000
    onStage('Đang đo tải xuống và ghi tệp thử…')
    const downloadStart = performance.now()
    const download = await requestFileContent(content, { token, signal })
    const reader = download.body.getReader()
    let received = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await disk.write(received, value)
        received += value.byteLength
      }
    } finally { reader.releaseLock() }
    disk.verify(download.headers.get('X-File-SHA256'))
    await disk.commit()
    const downloadSeconds = (performance.now() - downloadStart) / 1000
    return { uploadSeconds, downloadSeconds,
      uploadMBps: RELAY_SAMPLE_BYTES / uploadSeconds / 1_000_000,
      downloadMBps: RELAY_SAMPLE_BYTES / downloadSeconds / 1_000_000 }
  } finally { await disk.dispose() }
}

export const RELAY_BLOCK_BYTES = 64_000
export const RELAY_CONNECTION_COUNTS = [1, 2, 4]

// Blob giữ các lát của file gốc. Mỗi kết nối gửi các khối xen kẽ để relay ghép theo thứ tự.
export function createRelayUploadBodies(file, connections) {
  if (!RELAY_CONNECTION_COUNTS.includes(connections)) throw new Error('Số kết nối HTTPS không hợp lệ.')
  if (connections === 1) return [file]
  return Array.from({ length: connections }, (_, channel) => {
    const slices = []
    for (let offset = channel * RELAY_BLOCK_BYTES; offset < file.size; offset += connections * RELAY_BLOCK_BYTES)
      slices.push(file.slice(offset, Math.min(file.size, offset + RELAY_BLOCK_BYTES)))
    return new Blob(slices, { type: 'application/octet-stream' })
  })
}

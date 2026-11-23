// Tốc độ hiện tại lấy từ cửa sổ một giây, tách khỏi trung bình cả phiên.
// Chờ có hai mẫu byte thực để thời gian mở kênh/khởi tạo Worker không làm
// sai tốc độ đầu phiên. Cửa sổ nhỏ, không giữ lịch sử của toàn bộ file.
export function createTransferRate(startedAt = performance.now()) {
  const samples = []
  return {
    sample(bytes, now = performance.now()) {
      if (samples.length && bytes < samples.at(-1).bytes) {
        samples.length = 0
        startedAt = now
      }
      if (samples.at(-1)?.at === now) samples.at(-1).bytes = bytes
      else samples.push({ bytes, at: now })
      const cutoff = now - 1000
      while (samples.length > 2 && (samples[1].at <= cutoff || samples.length > 16)) samples.shift()
      let { bytes: baseline, at } = samples[0]
      if (at < cutoff && samples.length > 1) {
        const next = samples[1]
        baseline += (next.bytes - baseline) * (cutoff - at) / (next.at - at)
        at = cutoff
      }
      return {
        bytesPerSecond: now > at ? (bytes - baseline) * 1000 / (now - at) : 0,
        averageBytesPerSecond: bytes * 1000 / Math.max(1, now - startedAt),
      }
    },
  }
}

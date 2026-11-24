import { CHUNK_BYTES } from './fileProtocol.js'

// Hạn mức payload của ứng dụng, tách biệt với bộ đệm SCTP của trình duyệt.
export const INITIAL_FILE_WINDOW = 2 * 1024 ** 2
export const MAX_FILE_WINDOW = 8_000_000
const WRITE_RESERVE_BYTES = 512 * 1024
const CONTROL_INTERVAL_MS = 500

// Chỉ bật điều chỉnh khi READY của máy nhận quảng bá một hạn mức hợp lệ.
// ACK luôn đại diện cho byte đã ghi, không phải byte vừa đến DataChannel.
export function createFileFlowControl({ initialWindow = INITIAL_FILE_WINDOW,
  maxWindowCap = MAX_FILE_WINDOW, slowWriteMs = 100, clock = () => performance.now(), roundTripMs = () => null } = {}) {
  let windowBytes = initialWindow
  let maximumWindowBytes = initialWindow
  let adaptive = false
  let acknowledged = 0
  let lastAckAt = clock()
  let epochAt = lastAckAt
  let epochBytes = 0
  let epochWait = 0
  let epochBufferWait = 0
  let ackWaitMs = 0
  let bufferWaitMs = 0
  let receiverWriteMs = null
  let ackBytesPerSecond = 0

  return {
    get windowBytes() { return windowBytes },
    negotiate(maximum) {
      if (maximum === undefined) return // Tab cũ giữ nguyên cửa sổ cố định.
      if (!Number.isSafeInteger(maximum) || maximum < initialWindow || maximum > maxWindowCap)
        throw new Error('Hạn mức cửa sổ ACK không hợp lệ.')
      maximumWindowBytes = maximum
      adaptive = maximum > initialWindow
      epochAt = lastAckAt = clock()
    },
    waited(kind, milliseconds) {
      if (kind === 'ack') ackWaitMs += milliseconds
      else bufferWaitMs += milliseconds
    },
    acknowledge(bytes, writeMs) {
      if (writeMs !== undefined && (!Number.isFinite(writeMs) || writeMs < 0 || writeMs > 60_000))
        throw new Error('Thời gian ghi trong ACK không hợp lệ.')
      if (bytes === acknowledged) return
      const now = clock()
      const gap = now - lastAckAt
      lastAckAt = now
      acknowledged = bytes
      if (writeMs !== undefined)
        receiverWriteMs = receiverWriteMs === null ? writeMs : receiverWriteMs * 0.75 + writeMs * 0.25
      const elapsed = now - epochAt
      if (elapsed < CONTROL_INTERVAL_MS) return
      ackBytesPerSecond = (acknowledged - epochBytes) * 1000 / elapsed
      if (adaptive) {
        const rtt = roundTripMs()
        const latency = Number.isFinite(rtt) && rtt > 0 ? rtt : 0
        const writerSlow = receiverWriteMs !== null && receiverWriteMs > slowWriteMs
        const stalled = gap > Math.max(1500, latency * 4)
        if (writerSlow || stalled) windowBytes *= 0.75
        else {
          // BDP có dự phòng cho ghi đĩa/ACK. Thiếu RTT thì chỉ thăm dò tăng
          // khi thực sự phải chờ pipeline và máy nhận ghi đủ nhanh.
          const highSpeed = slowWriteMs > 100
          const fastWriteLimit = highSpeed ? Math.min(120, Math.floor(slowWriteMs * 0.4)) : 25
          const bdpSeconds = highSpeed ? Math.max(0.5, latency / 1000) : Math.max(0.05, latency / 1000)
          const reserveBytes = highSpeed ? WRITE_RESERVE_BYTES * 8 : WRITE_RESERVE_BYTES
          const waitedOnPipeline = ackWaitMs - epochWait > 20 ||
            (highSpeed && (ackWaitMs - epochWait > 0 || bufferWaitMs - epochBufferWait > 20))
          const target = latency > 0
            ? ackBytesPerSecond * bdpSeconds * 2 + reserveBytes
            : windowBytes
          if (target > windowBytes || (waitedOnPipeline && (receiverWriteMs ?? 0) < fastWriteLimit))
            windowBytes = Math.min(windowBytes * 1.5, Math.max(target, windowBytes * 1.25))
          else if (latency > 0 && target < windowBytes / 2 && !waitedOnPipeline)
            windowBytes *= 0.875
        }
        // ICE RTT không bao gồm toàn bộ độ trễ SCTP/ghi đĩa. Không thu cửa sổ
        // xuống dưới mức gốc chỉ vì tốc độ quan sát ban đầu đang còn thấp.
        windowBytes = Math.max(initialWindow, Math.min(maximumWindowBytes, Math.floor(windowBytes / CHUNK_BYTES) * CHUNK_BYTES))
      }
      epochAt = now
      epochBytes = acknowledged
      epochWait = ackWaitMs
      epochBufferWait = bufferWaitMs
    },
    snapshot() {
      return { adaptive, windowBytes, maximumWindowBytes, ackWaitMs, bufferWaitMs,
        receiverWriteMs, ackBytesPerSecond }
    },
  }
}

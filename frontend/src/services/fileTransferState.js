export function localFileStatus(transfer) {
  if (transfer.savedLocally) return transfer.status === 'completed'
    ? 'Đã lưu trên máy' : 'Đã lưu trên máy, chưa xác nhận với máy chủ'
  if (transfer.localFailure) return transfer.error || 'Kết nối đã ngắt. Cần gửi lại tệp.'
  if (transfer.localPhase === 'verifying') return 'Đang xác minh SHA-256…'
  if (transfer.localPhase === 'saving') return 'Đang lưu vào vị trí đã chọn…'
  return null
}

export function waitForTransferring(getTransfer, changes, signal, timeoutMs = 60000, requireHash = false) {
  return new Promise((resolve, reject) => {
    let timer
    function finish(error, transfer) {
      clearTimeout(timer)
      changes.removeEventListener('change', check)
      signal.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve(transfer)
    }
    function aborted() {
      finish(new DOMException('Phiên truyền đã dừng.', 'AbortError'))
    }
    function check() {
      if (signal.aborted) return aborted()
      const transfer = getTransfer()
      if (!transfer || transfer.localFailure ||
          !['offered', 'accepted', 'transferring'].includes(transfer.status)) {
        finish(new Error('Phiên truyền đã kết thúc trước khi xác nhận tệp.'))
      } else if (transfer.status === 'transferring' && (!requireHash || transfer.sha256Hex))
        finish(null, transfer)
    }
    changes.addEventListener('change', check)
    signal.addEventListener('abort', aborted, { once: true })
    timer = setTimeout(() => finish(new Error('Hết thời gian đồng bộ trạng thái truyền tệp.')), timeoutMs)
    check()
  })
}

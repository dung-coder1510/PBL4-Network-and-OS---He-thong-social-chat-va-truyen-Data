export function waitForTransferring(getTransfer, changes, signal, timeoutMs = 60000) {
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
      } else if (transfer.status === 'transferring') finish(null, transfer)
    }
    changes.addEventListener('change', check)
    signal.addEventListener('abort', aborted, { once: true })
    timer = setTimeout(() => finish(new Error('Hết thời gian đồng bộ trạng thái truyền tệp.')), timeoutMs)
    check()
  })
}

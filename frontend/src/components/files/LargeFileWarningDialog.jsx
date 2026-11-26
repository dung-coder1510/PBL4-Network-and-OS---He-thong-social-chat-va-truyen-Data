import { useEffect, useRef } from 'react'
import { formatFileSize } from '../../utils/chatTimeline.js'
import { LARGE_FILE_WARNING_BYTES } from '../../services/fileProtocol.js'

export default function LargeFileWarningDialog({ file, onConfirm, onCancel }) {
  const dialog = useRef(null)
  useEffect(() => {
    const element = dialog.current
    const trigger = document.activeElement
    element.showModal()
    return () => { element.close(); trigger?.focus() }
  }, [])

  return <dialog ref={dialog} className="file-warning-dialog" aria-labelledby="large-file-title"
    aria-describedby="large-file-description" onCancel={event => { event.preventDefault(); onCancel() }}>
    <h2 id="large-file-title">Gửi tệp lớn hơn {formatFileSize(LARGE_FILE_WARNING_BYTES)}?</h2>
    <p className="file-warning-name"><strong>{file.name}</strong> - {formatFileSize(file.size)}</p>
    <p id="large-file-description">Việc kiểm tra và truyền tệp có thể mất nhiều thời gian.
      Hãy giữ hai tab mở và kết nối ổn định. Máy nhận cần đủ chỗ ở vị trí đã chọn để lưu tệp.</p>
    <p>Nếu phiên truyền bị ngắt, bạn cần gửi lại từ đầu.</p>
    <footer>
      <button type="button" className="btn" autoFocus onClick={onCancel}>Hủy</button>
      <button type="button" className="btn btn--primary" onClick={onConfirm}>Tiếp tục gửi</button>
    </footer>
  </dialog>
}

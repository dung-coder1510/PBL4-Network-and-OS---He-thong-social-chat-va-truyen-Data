import { useEffect, useRef } from 'react'
import Avatar from '../../../components/Avatar.jsx'
import Icon from '../../../components/Icon.jsx'
import { AccountState } from '../AdminUi.jsx'

export default function AccountActionDialog({ intent, busy, error, onReason, onConfirm, onReload, onClose }) {
  const dialog = useRef(null)
  useEffect(() => {
    const element = dialog.current
    const trigger = document.activeElement
    element.showModal()
    return () => { element.close(); trigger?.focus() }
  }, [])
  const unknown = intent.mode === 'unknown'
  const allowed = intent.user.role === 'User' && intent.user.isDisabled !== intent.disabled
  return <dialog ref={dialog} className="aw-dialog" aria-labelledby="aw-change-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <form onSubmit={event => { event.preventDefault(); if (!busy) onConfirm() }} aria-busy={busy}>
      <header><span className={`aw-action-symbol ${intent.disabled ? 'aw-error' : 'aw-good'}`}><Icon name={intent.disabled ? 'lock' : 'unlock'} /></span>
        <div><h2 id="aw-change-title">{intent.disabled ? 'Khóa' : 'Mở khóa'} tài khoản</h2><p>Xác nhận thay đổi quyền truy cập</p></div></header>
      <div className="aw-dialog-person"><Avatar person={{ id: intent.user.id, name: intent.user.displayName }} />
        <div><strong>{intent.user.displayName}</strong><small>@{intent.user.username} · #{intent.user.id}</small></div><AccountState user={intent.user} /></div>
      <p>{intent.disabled ? 'Người dùng sẽ bị đăng xuất khỏi các phiên hiện tại và không thể đăng nhập mới. Lịch sử trò chuyện được giữ lại.'
        : 'Người dùng có thể đăng nhập lại. Các phiên đã bị thu hồi vẫn hết hiệu lực.'}</p>
      <label className="aw-reason-input">Lý do {intent.disabled ? 'khóa' : 'mở khóa'} <span aria-hidden="true">*</span>
        <textarea autoFocus required maxLength={500} rows={4} value={intent.reason} readOnly={unknown || busy}
          onChange={event => onReason(event.target.value)} placeholder="Ghi rõ lý do xử lý tài khoản này…" />
        <small>{intent.reason.length}/500 ký tự · Lý do sẽ được lưu trong nhật ký.</small></label>
      {error && <p className="aw-alert aw-alert--error" role="alert">{error}</p>}
      {unknown && <p className="aw-alert aw-alert--warning" role="status">Chưa nhận được kết quả. Kiểm tra lại thao tác này trước khi đưa ra quyết định mới.</p>}
      {!allowed && !unknown && <p className="aw-caption" role="status">Trạng thái hiện tại không cho phép thao tác này.</p>}
      <footer><button className="btn" type="button" disabled={busy} onClick={onClose}>{unknown || !allowed ? 'Đóng' : 'Hủy'}</button>
        {intent.mode === 'conflict' ? <button className="btn btn--primary" type="button" disabled={busy} onClick={onReload}>Tải lại thông tin</button>
          : <button className={`btn ${intent.disabled && !unknown ? 'aw-danger-button' : 'btn--primary'}`} type="submit"
            disabled={busy || !intent.reason.trim() || (!allowed && !unknown)}>
            {busy ? 'Đang xử lý…' : unknown ? 'Kiểm tra kết quả' : `Xác nhận ${intent.disabled ? 'khóa' : 'mở khóa'}`}</button>}</footer>
    </form>
  </dialog>
}

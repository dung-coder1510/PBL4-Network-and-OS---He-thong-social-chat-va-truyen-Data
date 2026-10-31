import { useEffect, useState } from 'react'
import { conversationsApi } from '../services/conversationsApi.js'
import { isFileActive } from '../services/fileTransfers.js'
import { useFileTransfers } from '../realtime/fileTransferContext.js'
import { useChatRealtime } from '../realtime/chatRealtimeContext.js'

const LABELS = {
  offered: 'Chờ chấp nhận', accepted: 'Đang kết nối', transferring: 'Đang truyền / chờ xác nhận',
  completed: 'Đã nhận đủ, SHA-256 khớp', rejected: 'Đã từ chối', cancelled: 'Đã hủy',
  expired: 'Lời mời hết hạn', failed: 'Thất bại',
}
const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024
  ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`

export default function FilesPage({ token, user, onSessionExpired }) {
  const files = useFileTransfers()
  const { reconnect } = useChatRealtime()
  const [conversations, setConversations] = useState([])
  const [conversationId, setConversationId] = useState('')
  const [selectedFile, setSelectedFile] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [selectionKey, setSelectionKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      const items = []
      let cursor
      do {
        const page = await conversationsApi.list(token, { cursor }, controller.signal)
        items.push(...page.items)
        cursor = page.nextCursor
      } while (cursor)
      if (!controller.signal.aborted) setConversations(items)
    }
    load().catch(failure => {
      if (failure.name === 'AbortError') return
      if (failure.status === 401 || failure.status === 403) onSessionExpired()
      else setError(failure.message)
    })
    return () => controller.abort()
  }, [token, onSessionExpired])

  async function perform(key, operation) {
    setBusy(key)
    setError('')
    try { await operation() }
    catch (failure) { setError(failure.message) }
    finally { setBusy('') }
  }

  return (
    <div className="page">
      <div className="page-header"><div><h1>Tệp đã chia sẻ</h1>
        <p>Gửi trực tiếp qua WebRTC. Hai bên cần giữ ứng dụng mở đến khi hoàn tất.</p>
      </div></div>
      <form className="file-send" onSubmit={event => {
        event.preventDefault()
        void perform('offer', async () => {
          await files.offer(conversationId, selectedFile)
          setSelectedFile(null)
          setSelectionKey(value => value + 1)
        })
      }}>
        <div className="file-field"><label htmlFor="file-recipient">Người nhận</label>
          <select id="file-recipient" required value={conversationId} onChange={event => setConversationId(event.target.value)}>
            <option value="">Chọn cuộc trò chuyện</option>
            {conversations.map(conversation => <option key={conversation.id} value={conversation.id}
              disabled={conversation.peer.isDisabled}>
              {conversation.peer.displayName} (@{conversation.peer.username})
            </option>)}
          </select>
        </div>
        <label>Chọn tệp (tối đa 100 MiB)
          <input key={selectionKey} type="file" required onChange={event => setSelectedFile(event.target.files[0] || null)} />
        </label>
        <button className="btn btn--primary" disabled={!!busy || files.connectionState !== 'connected'}>
          {busy === 'offer' ? 'Đang tính SHA-256…' : 'Gửi lời mời'}
        </button>
      </form>
      <p className="file-help">Chưa có người nhận trong danh sách? Mở cuộc trò chuyện từ mục Danh bạ trước.
        File không lưu trên server. Tải xuống trước khi đóng hoặc tải lại trang; tab giữ tối đa 2 tệp đã nhận.</p>
      {files.connectionState !== 'connected' && <p role="status">Đang chờ kết nối máy chủ…</p>}
      {files.connectionState === 'disconnected' && <button className="btn" onClick={reconnect}>Kết nối lại</button>}
      {error && <p className="auth-workspace-error" role="alert">{error}</p>}
      <div className="table-wrap"><table>
        <thead><tr><th>Tệp / người liên hệ</th><th>Thời gian</th><th>Trạng thái</th><th>Thao tác</th></tr></thead>
        <tbody>{files.items.map(transfer => {
          const sending = transfer.senderId === user.id
          const ownEndpoint = (sending ? transfer.senderConnectionId : transfer.receiverConnectionId) === files.connectionId
          const canRespond = !sending && transfer.status === 'offered'
          const active = isFileActive(transfer)
          const conversation = conversations.find(item => item.id === transfer.conversationId)
          const disabled = !!busy || files.connectionState !== 'connected'
          const act = method => void perform(transfer.id, () => files.action(method, transfer.id))
          return <tr key={transfer.id}>
            <td><strong>{transfer.fileName}</strong><div>{size(transfer.fileSizeBytes)} · {sending ? 'Gửi đến' : 'Nhận từ'}{' '}
              {conversation?.peer.displayName || `#${sending ? transfer.receiverId : transfer.senderId}`}</div></td>
            <td>{new Date(transfer.createdAt).toLocaleString('vi-VN')}</td>
            <td><span className={`pill pill--${transfer.status === 'completed' ? 'green' : 'gray'}`}>{LABELS[transfer.status]}</span>
              {active && transfer.transferredBytes !== undefined && <div>
                <progress max={transfer.fileSizeBytes || 1} value={transfer.transferredBytes} aria-label={`Tiến độ ${transfer.fileName}`} />
                <small>{size(transfer.transferredBytes)} / {size(transfer.fileSizeBytes)} · {size(transfer.bytesPerSecond || 0)}/s</small>
              </div>}
              {active && !canRespond && !ownEndpoint && <small>Đang xử lý ở tab khác.</small>}
              {transfer.error && <p role="status">{transfer.error}</p>}
            </td>
            <td><div className="file-actions">
              {canRespond && <>
                <button className="btn btn--primary" disabled={disabled} onClick={() => act('AcceptFile')}>Chấp nhận</button>
                <button className="btn" disabled={disabled} onClick={() => act('RejectFile')}>Từ chối</button>
              </>}
              {active && ownEndpoint && <button className="btn" disabled={disabled} onClick={() => act('CancelFile')}>Hủy</button>}
              {transfer.downloadUrl && <>
                <a className="btn btn--primary" href={transfer.downloadUrl} download={transfer.fileName}>Tải xuống</a>
                <button className="btn" onClick={() => files.forgetDownload(transfer.id)}>Giải phóng tệp</button>
              </>}
              {transfer.status === 'completed' && !sending && !transfer.downloadUrl && <small>Tệp không còn ở tab này; cần gửi lại nếu chưa lưu.</small>}
            </div></td>
          </tr>
        })}</tbody>
      </table>{files.items.length === 0 && <p className="file-help">Chưa có phiên truyền tệp.</p>}</div>
      {files.nextCursor && <button className="btn" disabled={!!busy}
        onClick={() => void perform('more', files.loadMore)}>Xem thêm</button>}
    </div>
  )
}

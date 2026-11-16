import { useEffect, useState } from 'react'
import { conversationsApi } from '../services/conversationsApi.js'
import { isFileActive } from '../services/fileTransfers.js'
import { canSaveFile } from '../services/fileStorage.js'
import { localFileStatus } from '../services/fileTransferState.js'
import { LEGACY_MAX_FILE_BYTES } from '../services/fileProtocol.js'
import { formatFileSize as size } from '../utils/chatTimeline.js'
import { useFileTransfers } from '../realtime/fileTransferContext.js'
import { useChatRealtime } from '../realtime/chatRealtimeContext.js'

const LABELS = {
  offered: 'Chờ chấp nhận', accepted: 'Đang kết nối', transferring: 'Đang truyền / chờ xác nhận',
  completed: 'Đã nhận đủ, SHA-256 khớp', rejected: 'Đã từ chối', cancelled: 'Đã hủy',
  expired: 'Lời mời hết hạn', failed: 'Thất bại',
}

export default function FilesPage({ token, user, onSessionExpired }) {
  const files = useFileTransfers()
  const { reconnect, subscribeSync } = useChatRealtime()
  const [conversations, setConversations] = useState([])
  const [conversationId, setConversationId] = useState('')
  const [selectedFile, setSelectedFile] = useState(null)
  const [busy, setBusy] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => subscribeSync(() => setRevision(value => value + 1)), [subscribeSync])
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
  }, [token, onSessionExpired, revision])

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
          if (!await files.offer(conversationId, selectedFile)) return
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
        <label>Chọn tệp (tối đa 10 GiB)
          <input key={selectionKey} type="file" required onChange={event => setSelectedFile(event.target.files[0] || null)} />
        </label>
        <button className="btn btn--primary" disabled={!!busy || files.connectionState !== 'connected'}>
          {busy === 'offer' ? 'Đang chuẩn bị…' : 'Gửi lời mời'}
        </button>
      </form>
      <p className="file-help">Chưa có người nhận trong danh sách? Mở cuộc trò chuyện từ mục Danh bạ trước.
        Khi nhận, chọn tên và vị trí lưu, giữ nguyên đuôi tệp. Với cách nhận để tải xuống,
        hãy tải trước khi đóng trang, tab giữ tối đa 2 tệp.</p>
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
          const act = (method, extra) => void perform(transfer.id, () => files.action(method, transfer.id, extra))
          return <tr key={transfer.id}>
            <td><strong>{transfer.fileName}</strong><div>{size(transfer.fileSizeBytes)} · {sending ? 'Gửi đến' : 'Nhận từ'}{' '}
              {conversation?.peer.displayName || `#${sending ? transfer.receiverId : transfer.senderId}`}</div></td>
            <td>{new Date(transfer.createdAt).toLocaleString('vi-VN')}</td>
            <td><span className={`pill pill--${transfer.status === 'completed' ? 'green' : 'gray'}`}>{localFileStatus(transfer) || LABELS[transfer.status]}</span>
              {transfer.savedLocally && <small>Đã lưu thành {transfer.savedName}.</small>}
              {active && transfer.transferredBytes !== undefined && <div>
                <progress max={transfer.fileSizeBytes || 1} value={transfer.transferredBytes} aria-label={`Tiến độ ${transfer.fileName}`} />
                <small>{size(transfer.transferredBytes)} / {size(transfer.fileSizeBytes)} · {size(transfer.bytesPerSecond || 0)}/s</small>
              </div>}
              {files.developerMode && transfer.acceptedAt && transfer.channelCount > 0 && <small>
                {transfer.channelCount} kênh{!active && transfer.bytesPerSecond > 0 ? ` · ${size(transfer.bytesPerSecond)}/s` : ''}
              </small>}
              {active && !canRespond && !ownEndpoint && <small>Đang xử lý ở tab khác.</small>}
              {transfer.error && <p role="status">{transfer.error}</p>}
            </td>
            <td><div className="file-actions">
              {canRespond && <>
                <button className="btn btn--primary" disabled={disabled} onClick={() => act('AcceptFile')}>Chấp nhận</button>
                {canSaveFile(transfer) && transfer.fileSizeBytes <= LEGACY_MAX_FILE_BYTES && <button className="btn" disabled={disabled}
                  onClick={() => act('AcceptFile', { legacy: true })}>Nhận để tải xuống</button>}
                <button className="btn" disabled={disabled} onClick={() => act('RejectFile')}>Từ chối</button>
              </>}
              {active && ownEndpoint && !transfer.savedLocally && <button className="btn" disabled={disabled} onClick={() => act('CancelFile')}>Hủy</button>}
              {transfer.downloadUrl && <>
                <a className="btn btn--primary" href={transfer.downloadUrl} download={transfer.fileName}>Tải xuống</a>
                <button className="btn" onClick={() => files.forgetDownload(transfer.id)}>Giải phóng tệp</button>
              </>}
              {transfer.status === 'completed' && !sending && !transfer.downloadUrl && !transfer.savedLocally &&
                <small>Kiểm tra thư mục lưu hoặc tệp đã tải xuống. Nếu chưa lưu, cần gửi lại.</small>}
            </div></td>
          </tr>
        })}</tbody>
      </table>{files.items.length === 0 && <p className="file-help">Chưa có phiên truyền tệp.</p>}</div>
      {files.nextCursor && <button className="btn" disabled={!!busy}
        onClick={() => void perform('more', files.loadMore)}>Xem thêm</button>}
    </div>
  )
}

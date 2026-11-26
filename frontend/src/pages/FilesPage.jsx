import { useEffect, useMemo, useState } from 'react'
import Avatar from '../components/Avatar.jsx'
import Icon from '../components/Icon.jsx'
import FileTransferDetailModal from '../components/files/FileTransferDetailModal.jsx'
import { conversationsApi } from '../services/conversationsApi.js'
import { isFileActive } from '../services/fileTransfers.js'
import { canSaveFile } from '../services/fileStorage.js'
import { localFileStatus } from '../services/fileTransferState.js'
import { LEGACY_MAX_FILE_BYTES } from '../services/fileProtocol.js'
import { fileTypeLabel, formatFileSize as size, formatTimeDivider } from '../utils/chatTimeline.js'
import { formatUserError } from '../utils/errorMessage.js'
import { FILE_CATEGORY_OPTIONS, fileCategory, transferStatusLabel } from '../utils/fileDetails.js'
import { useFileTransfers } from '../realtime/fileTransferContext.js'
import { useChatRealtime } from '../realtime/chatRealtimeContext.js'

function rowHighlightClass(transfer, sending) {
  const active = isFileActive(transfer)
  if (!sending && (active || !!transfer.downloadUrl)) return 'file-row--receiving'
  if (sending && active) return 'file-row--sending'
  return ''
}

function pillToneClass(transfer, sending, active) {
  if (!sending && (active || !!transfer.downloadUrl)) return 'pill--receiving'
  if (sending && active) return 'pill--pending'
  if (transfer.status === 'completed') return 'pill--success'
  if (transfer.status === 'failed' || transfer.status === 'rejected') return 'pill--danger'
  return ''
}

export default function FilesPage({ token, user, onSessionExpired, onOpenConversation, onOpenContacts }) {
  const files = useFileTransfers()
  const { reconnect, subscribeSync } = useChatRealtime()
  const [conversations, setConversations] = useState([])
  const [conversationId, setConversationId] = useState('')
  const [selectedFile, setSelectedFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => subscribeSync(() => setRevision(value => value + 1)), [subscribeSync])
  const [error, setError] = useState('')
  const [selectionKey, setSelectionKey] = useState(0)
  const [directionFilter, setDirectionFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [detailTransferId, setDetailTransferId] = useState(null)

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
      else setError(formatUserError(failure, 'Chưa tải được danh sách cuộc trò chuyện.'))
    })
    return () => controller.abort()
  }, [token, onSessionExpired, revision])

  async function perform(key, operation) {
    setBusy(key)
    setError('')
    try { await operation() }
    catch (failure) { setError(formatUserError(failure, 'Chưa thực hiện được thao tác. Bạn thử lại nhé.')) }
    finally { setBusy('') }
  }

  function clearSelectedFile() {
    setSelectedFile(null)
    setSelectionKey(value => value + 1)
  }

  function clearFilters() {
    setDirectionFilter('all')
    setCategoryFilter('all')
    setQuery('')
  }

  const conversationsById = useMemo(() => new Map(conversations.map(item => [item.id, item])), [conversations])

  const counts = useMemo(() => {
    let activeCount = 0
    let sentCount = 0
    let receivedCount = 0
    for (const transfer of files.items) {
      if (isFileActive(transfer)) activeCount++
      if (transfer.senderId === user.id) sentCount++
      else receivedCount++
    }
    return { total: files.items.length, activeCount, sentCount, receivedCount }
  }, [files.items, user.id])

  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return files.items.filter(transfer => {
      const sending = transfer.senderId === user.id
      if (directionFilter === 'active' && !isFileActive(transfer)) return false
      if (directionFilter === 'sent' && !sending) return false
      if (directionFilter === 'received' && sending) return false
      if (categoryFilter !== 'all' && fileCategory(transfer.fileName) !== categoryFilter) return false
      if (!keyword) return true
      const conversation = conversationsById.get(transfer.conversationId)
      const peerName = conversation?.peer.displayName || `#${sending ? transfer.receiverId : transfer.senderId}`
      const peerUsername = conversation?.peer.username || ''
      return transfer.fileName.toLowerCase().includes(keyword) ||
        peerName.toLowerCase().includes(keyword) ||
        peerUsername.toLowerCase().includes(keyword)
    })
  }, [files.items, user.id, directionFilter, categoryFilter, query, conversationsById])

  const detailTransfer = useMemo(
    () => (detailTransferId ? files.items.find(item => item.id === detailTransferId) || null : null),
    [files.items, detailTransferId]
  )

  const hasFilters = directionFilter !== 'all' || categoryFilter !== 'all' || query.trim() !== ''
  const selectedType = selectedFile ? fileTypeLabel(selectedFile.name) : ''
  const connTone = files.connectionState === 'connected' ? 'online'
    : files.connectionState === 'connecting' ? 'reconnecting' : 'offline'
  const connLabel = files.connectionState === 'connected' ? 'Sẵn sàng'
    : files.connectionState === 'connecting' ? 'Đang kết nối…' : 'Mất kết nối'

  const tabs = [
    ['all', 'Tất cả', counts.total],
    ['received', 'Đã nhận', counts.receivedCount],
    ['sent', 'Đã gửi', counts.sentCount],
    ...(counts.activeCount > 0 || directionFilter === 'active' ? [['active', 'Đang xử lý', counts.activeCount]] : []),
  ]

  return (
    <div className="page files-page">
      <div className="page-header files-page-header">
        <div>
          <h1>Tệp đã chia sẻ</h1>
          <p>Quản lý tệp đã gửi và nhận trong các cuộc trò chuyện.</p>
        </div>
        <div className="files-header-meta">
          <span className="files-conn-pill" role="status">
            <span className={`status-dot-pulse ${connTone}`} aria-hidden="true" />
            <span>{connLabel}</span>
          </span>
          {files.connectionState === 'disconnected' && (
            <button className="btn" type="button" onClick={reconnect}>Kết nối lại</button>
          )}
        </div>
      </div>

      <section className="files-send-bar" aria-label="Gửi tệp mới">
        <form className="file-send" onSubmit={event => {
          event.preventDefault()
          const transport = event.nativeEvent.submitter?.value
          void perform('offer', async () => {
            if (!await files.offer(conversationId, selectedFile, transport)) return
            clearSelectedFile()
          })
        }}>
          <div className="file-field">
            <label className="files-sr-only" htmlFor="file-recipient">Người nhận</label>
            <select id="file-recipient" required value={conversationId} onChange={event => setConversationId(event.target.value)}>
              <option value="">Chọn người nhận…</option>
              {conversations.map(conversation => <option key={conversation.id} value={conversation.id}
                disabled={conversation.peer.isDisabled}>
                {conversation.peer.displayName} (@{conversation.peer.username})
              </option>)}
            </select>
          </div>

          <div className="file-dropzone-wrap">
            <label
              className={`file-dropzone${selectedFile ? ' has-file' : ''}${dragging ? ' is-dragging' : ''}`}
              onDragOver={event => { event.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={event => {
                event.preventDefault()
                setDragging(false)
                const dropped = event.dataTransfer.files?.[0]
                if (dropped) setSelectedFile(dropped)
              }}
            >
              <input key={selectionKey} type="file" required={!selectedFile} aria-label="Chọn tệp"
                onChange={event => setSelectedFile(event.target.files[0] || null)} />
              {selectedFile ? (
                <span className={`file-type-badge type-${selectedType.toLowerCase()}`} aria-hidden="true">{selectedType}</span>
              ) : (
                <span className="file-dropzone-icon" aria-hidden="true"><Icon name="folder" size="ico-sm" /></span>
              )}
              <span className="file-dropzone-text">
                <strong>{selectedFile ? selectedFile.name : 'Chọn hoặc kéo thả tệp…'}</strong>
                {selectedFile && <small>{size(selectedFile.size)}</small>}
              </span>
            </label>
            {selectedFile && (
              <button className="file-dropzone-clear" type="button" onClick={clearSelectedFile} aria-label="Bỏ chọn tệp">
                <Icon name="close" size="ico-sm" />
              </button>
            )}
          </div>

          <div className="file-send-actions">
            <button className="btn btn--primary" disabled={!!busy || files.connectionState !== 'connected'}>
              {busy === 'offer' ? 'Đang gửi…' : 'Gửi lời mời'}
            </button>
            {files.relayAvailable && <button className="btn" disabled={!!busy} value="https">
              Gửi qua máy chủ
            </button>}
          </div>
        </form>

        {conversations.length === 0 && onOpenContacts && (
          <p className="files-empty-contacts">
            Chưa có cuộc trò chuyện nào — <button className="files-inline-link" type="button" onClick={onOpenContacts}>Mở Danh bạ</button> để thêm liên hệ.
          </p>
        )}
      </section>

      {error && (
        <div className="files-alert" role="alert">
          <Icon name="info" size="ico-sm" />
          <span className="files-alert-text">{error}</span>
          <button className="files-alert-close" type="button" onClick={() => setError('')} aria-label="Đóng thông báo lỗi">
            <Icon name="close" size="ico-sm" />
          </button>
        </div>
      )}

      <div className="files-toolbar">
        <div className="files-tabs" role="tablist" aria-label="Lọc theo chiều truyền">
          {tabs.map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={directionFilter === id}
              className={`files-tab${directionFilter === id ? ' active' : ''}${id === 'active' && counts.activeCount > 0 ? ' is-live' : ''}`}
              onClick={() => setDirectionFilter(id)}
            >
              <span>{label}</span>
              <span className="files-tab-count">{count}</span>
            </button>
          ))}
        </div>

        <div className="files-filters">
          <div className="field-wrap files-search">
            <Icon name="search" size="ico-sm" />
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Tìm tên tệp hoặc người liên hệ…"
              aria-label="Tìm tệp hoặc người liên hệ"
            />
          </div>
          <select
            className="files-category-select"
            value={categoryFilter}
            onChange={event => setCategoryFilter(event.target.value)}
            aria-label="Lọc theo loại tệp"
          >
            {FILE_CATEGORY_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          {hasFilters && (
            <button className="btn btn--ghost files-clear-filter" type="button" onClick={clearFilters}>
              Xóa lọc
            </button>
          )}
        </div>
      </div>

      <div className="table-wrap files-table-wrap">
        <table className="files-table">
          <thead>
            <tr>
              <th>Tệp</th>
              <th>Người liên hệ</th>
              <th>Thời gian</th>
              <th>Trạng thái</th>
              <th>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map(transfer => {
              const sending = transfer.senderId === user.id
              const relay = transfer.transport === 'https'
              const ownEndpoint = relay ? transfer.localRelayEndpoint
                : (sending ? transfer.senderConnectionId : transfer.receiverConnectionId) === files.connectionId
              const canRespond = !sending && transfer.status === 'offered'
              const active = isFileActive(transfer)
              const conversation = conversationsById.get(transfer.conversationId)
              const peerName = conversation?.peer.displayName || `#${sending ? transfer.receiverId : transfer.senderId}`
              const peerId = conversation?.peer.id ?? (sending ? transfer.receiverId : transfer.senderId)
              const type = fileTypeLabel(transfer.fileName)
              const disabled = !!busy || (!relay && files.connectionState !== 'connected')
              const act = (method, extra) => void perform(transfer.id, () => files.action(method, transfer.id, extra))
              const cleanTransferError = transfer.error ? formatUserError(transfer.error, '') : ''
              const localText = localFileStatus(transfer)
              const baseLabel = transferStatusLabel(transfer, sending)
              const percent = transfer.fileSizeBytes > 0 && Number.isFinite(transfer.transferredBytes)
                ? Math.min(100, Math.round((transfer.transferredBytes / transfer.fileSizeBytes) * 100))
                : 0
              const pillLabel = localText || (
                transfer.status === 'transferring' && transfer.transferredBytes !== undefined && transfer.fileSizeBytes > 0
                  ? `${baseLabel} (${percent}%)`
                  : baseLabel
              )

              return (
                <tr key={transfer.id} className={rowHighlightClass(transfer, sending) || undefined}>
                  <td>
                    <div className="files-file-cell">
                      <span className={`file-type-badge type-${type.toLowerCase()}`} aria-hidden="true">{type}</span>
                      <div className="files-file-meta">
                        <strong className="files-file-name" title={transfer.fileName}>{transfer.fileName}</strong>
                        <small className="files-file-sub">
                          <span>{size(transfer.fileSizeBytes)}</span>
                          {relay && <span className="files-transport-chip">Qua máy chủ</span>}
                        </small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="files-peer-cell">
                      <Avatar person={{ id: peerId, name: peerName }} size="sm" />
                      <div className="files-peer-meta">
                        <strong className="files-peer-name">{peerName}</strong>
                        <small className={`files-dir-tag${sending ? ' is-out' : ' is-in'}`}>
                          <Icon name={sending ? 'arrow_up_right' : 'arrow_down_left'} size="ico-sm" />
                          <span>{sending ? 'Gửi đến' : 'Nhận từ'}</span>
                        </small>
                      </div>
                    </div>
                  </td>
                  <td className="files-time-cell">{formatTimeDivider(transfer.createdAt)}</td>
                  <td className="files-status-cell">
                    <span className={`pill ${pillToneClass(transfer, sending, active)}`.trim()}>
                      {active && <span className="files-live-dot" aria-hidden="true" />}
                      <span>{pillLabel}</span>
                    </span>
                    {active && transfer.transferredBytes !== undefined && (
                      <div className="files-progress-box">
                        <progress max={transfer.fileSizeBytes || 1} value={transfer.transferredBytes} aria-label={`Tiến độ ${transfer.fileName}`} />
                        <small>{size(transfer.transferredBytes)} / {size(transfer.fileSizeBytes)} - {size(transfer.bytesPerSecond || 0)}/s</small>
                      </div>
                    )}
                    {cleanTransferError && <p className="files-row-error" role="status">{cleanTransferError}</p>}
                  </td>
                  <td>
                    <div className="file-actions">
                      {canRespond && <>
                        <button className="btn btn--primary" disabled={disabled} onClick={() => act('AcceptFile')}>Chấp nhận</button>
                        {!relay && canSaveFile(transfer) && transfer.fileSizeBytes <= LEGACY_MAX_FILE_BYTES && (
                          <button className="btn" disabled={disabled} onClick={() => act('AcceptFile', { legacy: true })}>Nhận để tải xuống</button>
                        )}
                        <button className="btn" disabled={disabled} onClick={() => act('RejectFile')}>Từ chối</button>
                      </>}
                      {active && ownEndpoint && !transfer.savedLocally && (
                        <button className="btn" disabled={disabled} onClick={() => act('CancelFile')}>Hủy</button>
                      )}
                      {transfer.downloadUrl && <>
                        <a className="btn btn--primary" href={transfer.downloadUrl} download={transfer.fileName}>Tải xuống</a>
                        <button className="btn" onClick={() => files.forgetDownload(transfer.id)}>Giải phóng tệp</button>
                      </>}
                      <button
                        className="btn btn--ghost files-detail-btn"
                        type="button"
                        onClick={() => setDetailTransferId(transfer.id)}
                        aria-label={`Xem chi tiết tệp ${transfer.fileName}`}
                      >
                        <Icon name="info" size="ico-sm" />
                        <span>Chi tiết</span>
                      </button>
                      {onOpenConversation && transfer.conversationId && (
                        <button
                          className="btn btn--ghost files-chat-btn"
                          type="button"
                          onClick={() => onOpenConversation(transfer.conversationId)}
                          aria-label={`Mở chat cho tệp ${transfer.fileName}`}
                          title="Mở cuộc trò chuyện"
                        >
                          <Icon name="chat" size="ico-sm" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {filteredItems.length === 0 && (
          <div className="files-empty">
            <span className="empty-icon-ring" aria-hidden="true"><Icon name="folder" size="ico-lg" /></span>
            <h3>{files.items.length === 0 ? 'Chưa có tệp nào' : 'Không tìm thấy tệp phù hợp'}</h3>
            <p>{files.items.length === 0
              ? 'Các tệp bạn gửi hoặc nhận trong cuộc trò chuyện sẽ xuất hiện ở đây.'
              : 'Thử đổi từ khóa tìm kiếm hoặc bỏ bộ lọc hiện tại.'}</p>
            {hasFilters && (
              <button className="btn" type="button" onClick={clearFilters}>Xóa lọc</button>
            )}
          </div>
        )}
      </div>

      {files.items.length > 0 && (
        <div className="files-table-footer">
          <span>Hiển thị {filteredItems.length} / {files.items.length} tệp</span>
          {files.nextCursor && (
            <button className="btn" type="button" disabled={!!busy} onClick={() => void perform('more', files.loadMore)}>
              Xem thêm
            </button>
          )}
        </div>
      )}

      <FileTransferDetailModal
        transfer={detailTransfer}
        userId={user.id}
        conversation={detailTransfer ? conversationsById.get(detailTransfer.conversationId) : null}
        connectionId={files.connectionId}
        connectionState={files.connectionState}
        developerMode={files.developerMode}
        busy={busy}
        onAction={(method, id, extra) => void perform(id, () => files.action(method, id, extra))}
        onForgetDownload={id => files.forgetDownload(id)}
        onOpenConversation={onOpenConversation}
        onClose={() => setDetailTransferId(null)}
      />
    </div>
  )
}

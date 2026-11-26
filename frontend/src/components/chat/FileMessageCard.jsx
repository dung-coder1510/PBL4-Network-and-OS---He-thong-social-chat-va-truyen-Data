import { useState } from 'react'
import Icon from '../Icon.jsx'
import { useFileTransfers } from '../../realtime/fileTransferContext.js'
import { isFileActive } from '../../services/fileTransfers.js'
import { canSaveFile } from '../../services/fileStorage.js'
import { HIGH_SPEED_PROTOCOL, LEGACY_MAX_FILE_BYTES, PARALLEL_CONNECTIONS_PROTOCOL } from '../../services/fileProtocol.js'
import { localFileStatus } from '../../services/fileTransferState.js'
import { fileTypeLabel, formatFileSize } from '../../utils/chatTimeline.js'
import { formatUserError } from '../../utils/errorMessage.js'
import FileRtcDiagnostics from '../files/FileRtcDiagnostics.jsx'

// Mot the duy nhat cho moi TransferId; dung lai controller P2P cua trang Tep.
export default function FileMessageCard({ transfer, currentUserId }) {
  const files = useFileTransfers()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sending = transfer.senderId === currentUserId
  const relay = transfer.transport === 'https'
  const ownEndpoint = relay ? transfer.localRelayEndpoint
    : (sending ? transfer.senderConnectionId : transfer.receiverConnectionId) === files.connectionId
  const active = isFileActive(transfer)
  const canRespond = !sending && transfer.status === 'offered'
  const disabled = busy || (!relay && files.connectionState !== 'connected') || transfer.localFailure
  const labels = {
    offered: sending ? 'Chờ người nhận' : 'Lời mời nhận tệp', accepted: 'Đang kết nối…',
    transferring: sending ? 'Đang gửi…' : 'Đang nhận…',
    completed: sending ? 'Đã gửi' : transfer.downloadUrl ? 'Sẵn sàng tải xuống' : 'Đã nhận',
    rejected: 'Đã từ chối', cancelled: 'Đã hủy', expired: 'Lời mời hết hạn', failed: 'Truyền tệp thất bại',
  }
  const progress = Math.min(transfer.fileSizeBytes, Math.max(0, transfer.transferredBytes || 0))
  const percent = transfer.fileSizeBytes ? Math.floor(progress / transfer.fileSizeBytes * 100) : 0
  const type = fileTypeLabel(transfer.fileName)
  const canCancel = active && ownEndpoint && !transfer.savedLocally
  const hasActions = canRespond || canCancel || transfer.downloadUrl

  // Bat loi thao tac ngay tren the va chan bam lap; trang thai cuoi van do server quyet dinh.
  async function act(method, extra) {
    if (busy) return
    setBusy(true)
    setError('')
    try { await files.action(method, transfer.id, extra) }
    catch (failure) { setError(formatUserError(failure, 'Chưa thực hiện được thao tác. Bạn thử lại nhé.')) }
    finally { setBusy(false) }
  }

  return <>
    <article className={`bubble file-message-card${sending ? ' outgoing' : ''}`}
    data-transfer-id={transfer.id} data-status={transfer.status} data-transport={transfer.transport}
    data-relay-connections={transfer.relayConnectionCount}
    aria-label={`Tệp ${transfer.fileName}`}>
    <div className="file-message-main">
      <span className={`file-message-icon type-${type.toLowerCase()}`} aria-hidden="true">{type}</span>
      <div className="file-message-info">
        <strong className="file-message-name" title={transfer.fileName}>{transfer.fileName}</strong>
        <span className="file-message-size">{formatFileSize(transfer.fileSizeBytes)}</span>
        {relay && <span className="file-message-size">Qua máy chủ</span>}
      </div>
    </div>
    {active && transfer.transferredBytes !== undefined && <div className="file-message-progress">
      <progress value={progress} max={transfer.fileSizeBytes || 1} aria-label={`Tiến độ ${transfer.fileName}`} />
      <span>{percent}% - {formatFileSize(progress)} / {formatFileSize(transfer.fileSizeBytes)}
        {transfer.bytesPerSecond > 0 ? ` - ${formatFileSize(transfer.bytesPerSecond)}/s` : ''}</span>
    </div>}
    {!relay && files.developerMode && transfer.acceptedAt && transfer.channelCount > 0 && <p className="file-message-hint">
      {transfer.protocolVersion === PARALLEL_CONNECTIONS_PROTOCOL ||
        (transfer.protocolVersion === HIGH_SPEED_PROTOCOL && transfer.channelCount > 1)
        ? `${transfer.channelCount} kết nối riêng` : `${transfer.channelCount} kênh`}
      {transfer.protocolVersion === HIGH_SPEED_PROTOCOL ? ' - v7' : ''}
      {!active && (transfer.averageBytesPerSecond || transfer.bytesPerSecond) > 0
        ? ` - ${formatFileSize(transfer.averageBytesPerSecond || transfer.bytesPerSecond)}/s` : ''}
    </p>}
    {relay && files.developerMode && transfer.relayConnectionCount > 1 &&
      <p className="file-message-hint">{transfer.relayMode === 'multipart'
        ? `${transfer.relayConnectionCount} kết nối HTTPS (tải lên & xuống)`
        : `${transfer.relayConnectionCount} kết nối tải lên HTTPS`}</p>}
    {!relay && <FileRtcDiagnostics stats={transfer.rtcDiagnostics} developerMode={files.developerMode} />}
    {active && !canRespond && !ownEndpoint && <p className="file-message-hint">Đang xử lý ở tab khác.</p>}
    {transfer.savedLocally && <p className="file-message-hint">Đã lưu thành {transfer.savedName}.</p>}
    {transfer.status === 'completed' && !sending && !transfer.downloadUrl && !transfer.savedLocally &&
      <p className="file-message-hint">Kiểm tra thư mục lưu hoặc tệp đã tải xuống. Nếu chưa lưu, cần gửi lại.</p>}
    {(error || transfer.error) && <p className="file-message-error" role="alert">{formatUserError(error || transfer.error, '')}</p>}
    {hasActions && <div className="file-message-actions">
      {canRespond && <>
        <button type="button" className="file-card-button primary" disabled={disabled}
          onClick={() => act('AcceptFile')}>Nhận file</button>
        {!relay && canSaveFile(transfer) && transfer.fileSizeBytes <= LEGACY_MAX_FILE_BYTES && <button type="button" className="file-card-button" disabled={disabled}
          onClick={() => act('AcceptFile', { legacy: true })}>Nhận để tải xuống</button>}
        <button type="button" className="file-card-button" disabled={disabled}
          onClick={() => act('RejectFile')}>Từ chối</button>
      </>}
      {canCancel && <button type="button" className="file-card-button" disabled={disabled}
        onClick={() => act('CancelFile')}>{transfer.status === 'offered' ? 'Hủy gửi' : 'Hủy'}</button>}
      {transfer.downloadUrl && <a className="file-card-button" href={transfer.downloadUrl}
        download={transfer.fileName}><Icon name="download" size="ico-sm" />Tải xuống</a>}
    </div>}
    </article>
    <div className="msg-meta file-message-meta">
      <time dateTime={transfer.createdAt}>{new Date(transfer.createdAt).toLocaleTimeString('vi-VN',
        { hour: '2-digit', minute: '2-digit' })}</time>
      <span role="status">{localFileStatus(transfer) || labels[transfer.status] || transfer.status}</span>
    </div>
  </>
}

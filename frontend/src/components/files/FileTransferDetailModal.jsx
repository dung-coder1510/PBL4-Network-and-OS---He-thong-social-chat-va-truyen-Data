import { useEffect } from 'react'
import Avatar from '../Avatar.jsx'
import Icon from '../Icon.jsx'
import FileRtcDiagnostics from './FileRtcDiagnostics.jsx'
import { isFileActive } from '../../services/fileTransfers.js'
import { canSaveFile } from '../../services/fileStorage.js'
import { localFileStatus } from '../../services/fileTransferState.js'
import { LEGACY_MAX_FILE_BYTES } from '../../services/fileProtocol.js'
import { fileTypeLabel, formatFileSize, formatTimeDivider } from '../../utils/chatTimeline.js'
import { formatUserError } from '../../utils/errorMessage.js'
import {
  describeTransferMethod,
  estimateRemainingMs,
  formatDuration,
  shortHash,
  transferStatusLabel,
  transferStatusSummary,
  transferStepIndex,
} from '../../utils/fileDetails.js'

const STEPS = ['Tạo lời mời', 'Đang truyền', 'Hoàn tất']

function statusCardTone(transfer, sending) {
  if (!transfer) return ''
  if (!sending && (isFileActive(transfer) || transfer.downloadUrl)) return 'is-receiving'
  if (sending && isFileActive(transfer)) return 'is-sending'
  if (transfer.status === 'completed') return 'is-success'
  if (transfer.status === 'failed' || transfer.status === 'rejected') return 'is-danger'
  return ''
}

function resolveSessionDetail(transfer, sending, canRespond, ownEndpoint) {
  if (isFileActive(transfer) && !canRespond && !ownEndpoint) return 'Đang xử lý ở tab khác'
  if (transfer.localPhase === 'verifying') return 'Đang xác minh mã băm SHA-256'
  if (transfer.localPhase === 'saving') return 'Đang ghi tệp xuống đĩa'
  return localFileStatus(transfer) || transferStatusLabel(transfer, sending)
}

function resolveStorageText(transfer, sending) {
  if (transfer.savedLocally) return `Đã lưu vào máy: ${transfer.savedName}`
  if (transfer.downloadUrl) return 'Đã tải vào tab hiện tại — hãy bấm Tải xuống trước khi đóng trang.'
  if (transfer.status === 'completed' && !sending) {
    return 'Tệp truyền trực tiếp không lưu trên máy chủ; kiểm tra thư mục lưu trên máy nếu cần mở lại.'
  }
  if (transfer.status === 'completed' && sending) return 'Đã gửi thành công đến người nhận.'
  return 'Không lưu trên máy chủ sau khi kết thúc.'
}

/** Hộp thoại hiển thị trực tiếp trạng thái, tiến độ, cách thức truyền và chi tiết toàn vẹn của một tệp. */
export default function FileTransferDetailModal({
  transfer,
  userId,
  conversation,
  connectionId,
  connectionState,
  developerMode,
  busy,
  onAction,
  onForgetDownload,
  onOpenConversation,
  onClose,
}) {
  useEffect(() => {
    if (!transfer) return
    function onKeyDown(event) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [transfer, onClose])

  if (!transfer) return null

  const sending = transfer.senderId === userId
  const relay = transfer.transport === 'https'
  const active = isFileActive(transfer)
  const canRespond = !sending && transfer.status === 'offered'
  const ownEndpoint = relay
    ? transfer.localRelayEndpoint
    : (sending ? transfer.senderConnectionId : transfer.receiverConnectionId) === connectionId
  const disabled = !!busy || (!relay && connectionState !== 'connected')

  const peerName = conversation?.peer.displayName || `#${sending ? transfer.receiverId : transfer.senderId}`
  const peerUsername = conversation?.peer.username || ''
  const peerId = conversation?.peer.id ?? (sending ? transfer.receiverId : transfer.senderId)
  const type = fileTypeLabel(transfer.fileName)
  const stepIndex = transferStepIndex(transfer)
  const remainingMs = active ? estimateRemainingMs(transfer) : null
  const percent = transfer.fileSizeBytes > 0 && Number.isFinite(transfer.transferredBytes)
    ? Math.min(100, Math.round((transfer.transferredBytes / transfer.fileSizeBytes) * 100))
    : 0
  const cleanError = transfer.error ? formatUserError(transfer.error, '') : ''
  const hashHex = transfer.verifiedSha256Hex || transfer.sha256Hex
  const finishedDurationMs = transfer.acceptedAt && transfer.finishedAt
    ? Date.parse(transfer.finishedAt) - Date.parse(transfer.acceptedAt)
    : null
  const durationLabel = formatDuration(finishedDurationMs)
  const avgSpeed = transfer.status === 'completed' && finishedDurationMs > 0 && transfer.fileSizeBytes > 0
    ? (transfer.fileSizeBytes / (finishedDurationMs / 1000))
    : null

  return (
    <div className="file-detail-backdrop" onClick={onClose}>
      <div
        className="file-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-detail-title"
        onClick={event => event.stopPropagation()}
      >
        <div className="file-detail-header">
          <div className="file-detail-title-group">
            <span className={`file-type-badge type-${type.toLowerCase()}`} aria-hidden="true">{type}</span>
            <div className="file-detail-heading">
              <h2 id="file-detail-title" title={transfer.fileName}>{transfer.fileName}</h2>
              <p className="file-detail-sub">
                {formatFileSize(transfer.fileSizeBytes)} - {sending ? 'Bạn gửi đi' : 'Gửi tới bạn'}
              </p>
            </div>
          </div>
          <button className="file-detail-close" type="button" onClick={onClose} aria-label="Đóng chi tiết tệp">
            <Icon name="close" size="ico-sm" />
          </button>
        </div>

        <div className={`file-detail-status ${statusCardTone(transfer, sending)}`.trim()}>
          <div className="file-detail-status-head">
            <span className={`pill ${!sending && (active || transfer.downloadUrl)
              ? 'pill--receiving'
              : sending && active
                ? 'pill--pending'
                : transfer.status === 'completed'
                  ? 'pill--success'
                  : transfer.status === 'failed' || transfer.status === 'rejected'
                    ? 'pill--danger'
                    : ''}`.trim()}>
              {localFileStatus(transfer) || transferStatusLabel(transfer, sending)}
            </span>
            {active && transfer.transferredBytes !== undefined && (
              <span className="file-detail-percent">{percent}%</span>
            )}
          </div>
          <p className="file-detail-summary">{transferStatusSummary(transfer, sending)}</p>

          {stepIndex >= 0 && (
            <ol className="file-detail-steps" aria-label="Tiến trình phiên truyền">
              {STEPS.map((label, index) => {
                const done = index < stepIndex || stepIndex === 2
                const current = index === stepIndex && stepIndex < 2
                return (
                  <li key={label} className={`file-detail-step${done ? ' is-done' : ''}${current ? ' is-current' : ''}`}>
                    <span className="file-detail-step-dot" aria-hidden="true" />
                    <span>{label}</span>
                  </li>
                )
              })}
            </ol>
          )}

          {active && transfer.transferredBytes !== undefined && (
            <div className="file-detail-progress">
              <progress max={transfer.fileSizeBytes || 1} value={transfer.transferredBytes} />
              <div className="file-detail-progress-meta">
                <span>{formatFileSize(transfer.transferredBytes)} / {formatFileSize(transfer.fileSizeBytes)}</span>
                <span>
                  {formatFileSize(transfer.bytesPerSecond || 0)}/s
                  {remainingMs ? ` - còn khoảng ${formatDuration(remainingMs)}` : ''}
                </span>
              </div>
            </div>
          )}

          {cleanError && <p className="file-detail-error" role="status">{cleanError}</p>}
        </div>

        <dl className="file-detail-list">
          <div>
            <dt>Người liên hệ</dt>
            <dd>
              <div className="file-detail-peer">
                <Avatar person={{ id: peerId, name: peerName }} size="sm" />
                <span>{peerName}</span>
                {peerUsername && <small>@{peerUsername}</small>}
                <span className={`files-dir-tag${sending ? ' is-out' : ' is-in'}`}>
                  {sending ? 'Gửi đến' : 'Nhận từ'}
                </span>
              </div>
            </dd>
          </div>

          <div>
            <dt>Cách thức truyền</dt>
            <dd>{describeTransferMethod(transfer)}</dd>
          </div>

          <div>
            <dt>Trạng thái phiên</dt>
            <dd>{resolveSessionDetail(transfer, sending, canRespond, ownEndpoint)}</dd>
          </div>

          <div>
            <dt>Toàn vẹn SHA-256</dt>
            <dd>
              {transfer.verifiedSha256Hex || transfer.status === 'completed' ? (
                <span className="file-detail-hash">
                  <span>Đã khớp SHA-256</span>
                  {hashHex && <code title={hashHex}>{shortHash(hashHex)}</code>}
                </span>
              ) : transfer.localPhase === 'verifying' ? (
                'Đang kiểm tra mã băm SHA-256…'
              ) : active ? (
                'Tự động kiểm tra khi nhận xong'
              ) : (
                'Chưa xác minh'
              )}
            </dd>
          </div>

          <div>
            <dt>Lưu trữ</dt>
            <dd>{resolveStorageText(transfer, sending)}</dd>
          </div>

          <div>
            <dt>Thời gian</dt>
            <dd className="file-detail-times">
              <span className="file-detail-time-label">Tạo lúc:</span>
              <span><time dateTime={transfer.createdAt}>{formatTimeDivider(transfer.createdAt)}</time></span>
              {transfer.acceptedAt && <>
                <span className="file-detail-time-label">Chấp nhận:</span>
                <span><time dateTime={transfer.acceptedAt}>{formatTimeDivider(transfer.acceptedAt)}</time></span>
              </>}
              {transfer.finishedAt && (
                <>
                  <span className="file-detail-time-label">Kết thúc:</span>
                  <span>
                    <time dateTime={transfer.finishedAt}>{formatTimeDivider(transfer.finishedAt)}</time>
                    {durationLabel && (
                      <small className="file-detail-time-note">
                        Mất {durationLabel}{avgSpeed ? ` - TB ${formatFileSize(avgSpeed)}/s` : ''}
                      </small>
                    )}
                  </span>
                </>
              )}
            </dd>
          </div>
        </dl>

        {!relay && transfer.rtcDiagnostics?.connections?.length > 0 && (
          <div className="file-detail-rtc">
            <FileRtcDiagnostics stats={transfer.rtcDiagnostics} developerMode={developerMode} />
          </div>
        )}

        <footer className="file-detail-footer">
          <div className="file-detail-actions">
            {canRespond && <>
              <button className="btn btn--primary" type="button" disabled={disabled} onClick={() => onAction('AcceptFile', transfer.id)}>
                Chấp nhận
              </button>
              {!relay && canSaveFile(transfer) && transfer.fileSizeBytes <= LEGACY_MAX_FILE_BYTES && (
                <button className="btn" type="button" disabled={disabled} onClick={() => onAction('AcceptFile', transfer.id, { legacy: true })}>
                  Nhận để tải xuống
                </button>
              )}
              <button className="btn" type="button" disabled={disabled} onClick={() => onAction('RejectFile', transfer.id)}>
                Từ chối
              </button>
            </>}

            {active && ownEndpoint && !transfer.savedLocally && (
              <button className="btn btn--danger" type="button" disabled={disabled} onClick={() => onAction('CancelFile', transfer.id)}>
                Hủy truyền
              </button>
            )}

            {transfer.downloadUrl && <>
              <a className="btn btn--primary" href={transfer.downloadUrl} download={transfer.fileName}>
                Tải xuống
              </a>
              <button className="btn" type="button" onClick={() => onForgetDownload(transfer.id)}>
                Giải phóng tệp
              </button>
            </>}

            {onOpenConversation && transfer.conversationId && (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  onClose()
                  onOpenConversation(transfer.conversationId)
                }}
              >
                <Icon name="chat" size="ico-sm" />
                <span>Mở cuộc trò chuyện</span>
              </button>
            )}
          </div>
          <button className="btn btn--ghost" type="button" onClick={onClose}>Đóng</button>
        </footer>
      </div>
    </div>
  )
}

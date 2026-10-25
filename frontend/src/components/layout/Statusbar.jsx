import { useChatRealtime } from '../../realtime/chatRealtimeContext.js'
import { useFileTransfers } from '../../realtime/fileTransferContext.js'

function Statusbar() {
  const { connectionState } = useChatRealtime()
  const files = useFileTransfers()
  const transmitting = files?.items.filter(transfer => transfer.status === 'transferring' &&
    (transfer.senderConnectionId === files.connectionId || transfer.receiverConnectionId === files.connectionId)).length || 0
  return (
    <footer className="statusbar" aria-label="Thanh trạng thái ứng dụng">
      <div className="statusbar-left">
        <span className="status-item muted">SignalR: {connectionState === 'connected' ? 'Đã kết nối' : connectionState === 'connecting' ? 'Đang kết nối' : 'Đã ngắt'}</span>
        <span className="status-divider">|</span>
        <span className="status-item muted">Tệp P2P: {transmitting ? `${transmitting} phiên đang truyền` : 'Không có phiên đang truyền'}</span>
      </div>
      <div className="statusbar-right">
        <span className="status-item muted">PBL4 · Web Client</span>
      </div>
    </footer>
  )
}

export default Statusbar

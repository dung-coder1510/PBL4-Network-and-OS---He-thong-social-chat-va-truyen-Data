import { formatFileSize } from '../../utils/chatTimeline.js'

const routeLabel = route => route === 'direct' ? 'WebRTC trực tiếp'
  : route === 'turn' ? 'WebRTC qua TURN' : 'WebRTC · đang xác định đường truyền'
const milliseconds = value => `${Math.round(value)} ms`

export default function FileRtcDiagnostics({ stats, developerMode }) {
  if (!stats?.connections?.length) return null
  return <div className="file-rtc-info" aria-live="off">
    <p className="file-message-hint">{[...new Set(stats.connections.map(item => routeLabel(item.route)))].join(' · ')}</p>
    {developerMode && <details className="file-rtc-diagnostics">
      <summary>Thống kê WebRTC</summary>
      <dl>
        {stats.connections.map((connection, index) => <div key={index}>
          <dt>Kết nối {index + 1}</dt>
          <dd>{routeLabel(connection.route)}
            {connection.protocol ? ` · ICE ${connection.protocol.toUpperCase()}` : ''}
            {connection.relayProtocol ? ` · đến TURN bằng ${connection.relayProtocol.toUpperCase()}` : ''}
            {connection.roundTripMs !== null ? ` · RTT ${milliseconds(connection.roundTripMs)}` : ''}
            {connection.bytesPerSecond !== null ? ` · ${formatFileSize(connection.bytesPerSecond)}/s trên mạng` : ''}
          </dd>
        </div>)}
        {stats.windowBytes !== undefined && <div><dt>Cửa sổ chờ ACK</dt>
          <dd>{formatFileSize(stats.windowBytes)} · {stats.adaptive ? 'Tự điều chỉnh' : 'Cố định'}</dd></div>}
        {stats.maximumWindowBytes !== undefined && <div><dt>Giới hạn máy nhận</dt>
          <dd>{formatFileSize(stats.maximumWindowBytes)}</dd></div>}
        {stats.inFlightBytes !== undefined && <div><dt>Chưa được ACK</dt><dd>{formatFileSize(stats.inFlightBytes)}</dd></div>}
        {stats.queuedBytes !== undefined && <div><dt>Đang chờ ghi</dt><dd>{formatFileSize(stats.queuedBytes)}</dd></div>}
        {stats.bufferedBytes !== undefined && <div><dt>Đệm gửi của trình duyệt</dt><dd>{formatFileSize(stats.bufferedBytes)}</dd></div>}
        {stats.ackWaitMs !== undefined && <div><dt>Tổng thời gian chờ cửa sổ ACK</dt><dd>{milliseconds(stats.ackWaitMs)}</dd></div>}
        {stats.bufferWaitMs !== undefined && <div><dt>Tổng thời gian chờ đệm gửi</dt><dd>{milliseconds(stats.bufferWaitMs)}</dd></div>}
        {stats.receiverWriteMs != null && <div><dt>Thời gian ghi mỗi lô</dt><dd>{milliseconds(stats.receiverWriteMs)}</dd></div>}
      </dl>
      <p>Trong lúc truyền, số đo của tab này cập nhật mỗi giây. Bộ đệm trình duyệt và hệ điều hành có thể dùng thêm RAM.</p>
    </details>}
  </div>
}

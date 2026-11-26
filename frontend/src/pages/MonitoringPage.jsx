import { useEffect, useState } from 'react'
import { request } from '../services/apiClient.js'
import '../styles/monitoring.css'

const number = value => value == null ? 'Chưa đo' : Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 1 })
const time = value => value ? new Date(value).toLocaleString('vi-VN') : '—'

// Tuổi mẫu khác độ trễ mạng. Giữ timestamp từng nguồn, không làm mới nó khi poll dashboard.
function Freshness({ seconds }) {
  const level = seconds == null ? 'unknown' : seconds <= 10 ? 'fresh' : seconds <= 20 ? 'late' : 'stale'
  return <span className={`monitor-age ${level}`} role="status">
    {seconds == null ? 'Đang chờ mẫu đầu tiên' : `Chưa cập nhật ${Math.floor(seconds)} giây`}
  </span>
}

function RequestChart({ series, kind, generatedAt }) {
  const end = Math.floor(Date.parse(generatedAt) / 5000) * 5000
  const values = Array.from({ length: 60 }, (_, index) =>
    series.find(point => point.kind === kind && Date.parse(point.at) === end - (59 - index) * 5000)?.requestsPerSecond || 0)
  const max = Math.max(1, ...values)
  return <figure className="monitor-chart"><figcaption>{kind} — request/giây, 5 phút gần nhất (đỉnh {number(Math.max(...values))})</figcaption>
    <svg viewBox="0 0 590 100" role="img" aria-label={`Biểu đồ ${kind}: ${values.join(', ')}`}>
      <line x1="0" y1="90" x2="590" y2="90" stroke="currentColor" opacity=".3" />
      <polyline points={values.map((value, index) => `${index * 10},${90 - value / max * 80}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2" />
    </svg></figure>
}

export default function MonitoringPage({ token }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [receivedAt, setReceivedAt] = useState(null)
  const [tick, setTick] = useState(0)
  const [userCursor, setUserCursor] = useState(0)
  const [fileCursor, setFileCursor] = useState(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(null)

  // Một poll cho cả trang, không chồng request. Hủy khi unmount/đổi trang dữ liệu;
  // ngừng khi 401/403, backoff khi lỗi và không phát request mới khi tab bị ẩn.
  useEffect(() => {
    const controller = new AbortController()
    let timer
    let failures = 0
    async function poll() {
      if (controller.signal.aborted) return
      try {
        if (document.visibilityState !== 'hidden') {
          const params = new URLSearchParams({ afterUserId: String(userCursor) })
          if (fileCursor) params.set('beforeFileId', fileCursor)
          const result = await request('/admin/monitoring?' + params, { token, signal: controller.signal })
          if (controller.signal.aborted) return
          const now = performance.now()
          setData(result); setReceivedAt(now); setTick(now); setError(''); failures = 0
        }
      } catch (failure) {
        if (controller.signal.aborted) return
        setError(failure.message)
        if (failure.status === 401 || failure.status === 403) return
        failures++
      }
      timer = setTimeout(poll, Math.min(30000, 5000 * 2 ** failures))
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [token, userCursor, fileCursor])
  useEffect(() => {
    const timer = setInterval(() => setTick(performance.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const elapsed = receivedAt == null ? null : Math.max(0, (tick - receivedAt) / 1000)
  const metrics = data?.metrics
  const connections = metrics?.connections || []
  const events = metrics?.fileEvents || []
  const age = event => Math.max(0, (Date.parse(metrics.generatedAt) - Date.parse(event.at)) / 1000 + (elapsed || 0))
  return <div className="page monitoring">
    <h1>Giám sát hệ thống</h1><Freshness seconds={elapsed} />
    {error && <p role="alert">{error}</p>}
    <p>Một backend instance. Mẫu request: tối đa 15 phút / 20.000 mẫu; ghi snapshot mỗi 30 giây.
      Byte HTTP là payload thực đọc/ghi; không gồm TLS, header hoặc file WebRTC.
      Byte SignalR là ước tính JSON arguments/result, không gồm envelope và sự kiện broadcast.</p>
    {metrics && <>
      {metrics.droppedSamples > 0 && <p role="status">Đã loại {metrics.droppedSamples} mẫu do giới hạn bộ nhớ.
        Biểu đồ và thống kê chỉ phản ánh mẫu còn giữ từ {time(metrics.sampleWindowStart)}, không phải toàn bộ lưu lượng.</p>}
      <p><strong>{metrics.totalConnections}</strong> kết nối SignalR - <strong>{metrics.connectedUsers}</strong> tài khoản có kết nối.
        Hiển thị tối đa {metrics.connectionLimit} kết nối thuộc trang người dùng này.</p>
      <h2>1. Tài khoản và kết nối</h2>
      <label>Tìm trong trang hiện tại <input value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="table-wrap"><table><thead><tr><th>Tài khoản</th><th>Vai trò / trạng thái</th><th>Kết nối hiện tại</th></tr></thead>
        <tbody>{data.users.filter(user => `${user.username} ${user.displayName}`.toLowerCase().includes(query.toLowerCase())).map(user => <tr key={user.id}>
          <td>{user.displayName}<small>@{user.username} - #{user.id}</small></td><td>{user.role} - {user.isDisabled ? 'Bị khóa' : 'Hoạt động'}</td><td>
            {connections.filter(link => link.userId === String(user.id)).map(link => <div key={link.id}>
              <code>{link.id.slice(0, 10)}…</code> - mở {time(link.connectedAt)} - heartbeat {time(link.lastHeartbeatAt)}
            </div>)}
            {!connections.some(link => link.userId === String(user.id)) && 'Không có kết nối được ghi nhận'}
          </td></tr>)}</tbody></table></div>
      <button className="btn" disabled={!userCursor} onClick={() => setUserCursor(0)}>Trang người dùng đầu</button>
      <button className="btn" disabled={!data.nextUserId} onClick={() => setUserCursor(data.nextUserId)}>Người dùng tiếp theo</button>
      <h2>2. Request API / SignalR</h2>
      <div className="monitor-charts">{['HTTP', 'SignalR'].map(kind => <RequestChart key={kind} kind={kind} series={metrics.series} generatedAt={metrics.generatedAt} />)}</div>
      <h2>3. Lưu lượng và thời gian xử lý backend</h2>
      <p>Đang xử lý: {metrics.activeHttp ?? 0} HTTP - {metrics.activeHub ?? 0} lời gọi Hub.</p>
      <p>Thời gian gồm xử lý và chờ trong pipeline/phương thức; không phải độ trễ mạng. Heartbeat được liệt kê riêng.</p>
      <div className="table-wrap"><table><thead><tr><th>Loại / thao tác</th><th>Số mẫu</th><th>Lỗi / từ chối / hủy</th><th>TB / p95 (ms)</th><th>Byte vào / ra</th></tr></thead>
        <tbody>{metrics.operations.map(op => <tr key={op.kind + op.operation}><td>{op.kind} - {op.operation}</td><td>{op.count}</td>
          <td>{op.errors} / {op.rejected} / {op.cancelled}</td><td>{number(op.averageMs)} / {number(op.p95Ms)}</td><td>{number(op.inBytes)} / {number(op.outBytes)}</td></tr>)}</tbody></table></div>
      <h2>4. Phiên truyền file</h2>
      <p>Trạng thái do backend quyết định. Client báo giai đoạn/tiến độ để chẩn đoán; màu đỏ không tự đánh dấu phiên thất bại.</p>
      <div className="table-wrap"><table><thead><tr><th>Phiên / hai bên</th><th>Kích thước</th><th>Trạng thái</th><th>Báo cáo gần nhất</th><th>Lý do được báo</th></tr></thead>
        <tbody>{data.files.map(file => {
          const reports = events.filter(event => event.transferId === file.id)
          const last = reports.filter(event => event.source !== 'backend').at(-1)
          const failure = reports.findLast(event => event.stage === 'failure-report')
          const active = ['offered', 'accepted', 'transferring'].includes(file.status)
          return <tr key={file.id}><td><button className="btn" onClick={() => setSelected(file.id)}>#{file.id}</button> {file.senderId} → {file.receiverId}</td>
            <td>{number(file.fileSizeBytes)} byte</td><td>{file.status}</td><td>{last ? <>{last.source}: {last.stage} - {number(last.bytes)} byte
              {active && <Freshness seconds={age(last)} />}</> : 'Chưa có báo cáo client'}</td>
            <td>{failure ? `${failure.reason} (${failure.source})` : file.status === 'failed' ? 'UNKNOWN — chưa đủ bằng chứng' : '—'}</td></tr>
        })}</tbody></table></div>
      <button className="btn" disabled={!fileCursor} onClick={() => setFileCursor(null)}>Phiên mới nhất</button>
      <button className="btn" disabled={!data.nextFileId} onClick={() => setFileCursor(data.nextFileId)}>Phiên cũ hơn</button>
      {selected && <section><h3>Dòng thời gian phiên #{selected}</h3><p>Tối đa 24 giờ / 5.000 sự kiện; hiển thị tối đa 500 sự kiện cho trang hiện tại. Có thể thiếu mẫu cuối khi tiến trình dừng đột ngột.</p>
        <ol>{events.filter(event => event.transferId === selected).map((event, index) => <li key={index}>
          {time(event.at)} — {event.source} — {event.stage} {event.reason || ''}
        </li>)}</ol></section>}
    </>}
  </div>
}

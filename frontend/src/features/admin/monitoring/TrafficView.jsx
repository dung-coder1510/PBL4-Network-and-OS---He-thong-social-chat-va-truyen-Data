import { useState } from 'react'
import { bytes, number } from '../format.js'
import { Empty } from '../AdminUi.jsx'

function RequestGraph({ metrics }) {
  const end = Math.floor(Date.parse(metrics.generatedAt) / 5000) * 5000
  const values = ['HTTP', 'SignalR'].map(kind => Array.from({ length: 60 }, (_, i) =>
    metrics.series.find(point => point.kind === kind && Date.parse(point.at) === end - (59 - i) * 5000)?.requestsPerSecond || 0))
  const peak = Math.max(1, ...values.flat())
  return <figure className="aw-traffic-graph"><figcaption><div><h3>Nhịp request</h3><p>Số request mỗi giây trong 5 phút gần nhất</p></div>
    <div className="aw-graph-legend"><span><i className="aw-http-key" />HTTP</span><span><i className="aw-hub-key" />SignalR</span></div></figcaption>
    <div className="aw-graph-body"><div className="aw-graph-scale"><span>{number(peak)}</span><span>{number(peak / 2)}</span><span>0</span></div>
      <svg viewBox="0 0 590 150" preserveAspectRatio="none" role="img" aria-label={`Biểu đồ request: đỉnh HTTP ${number(Math.max(...values[0]))}, SignalR ${number(Math.max(...values[1]))} request mỗi giây`}>
        {[10, 75, 140].map(y => <line key={y} x1="0" y1={y} x2="590" y2={y} className="aw-graph-grid" />)}
        {values.map((points, i) => <polyline key={i} className={i ? 'aw-hub-line' : 'aw-http-line'}
          points={points.map((value, j) => `${j * 10},${140 - value / peak * 130}`).join(' ')} fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
      </svg></div><div className="aw-graph-axis"><span>5 phút trước</span><span>Hiện tại</span></div>
  </figure>
}

export default function TrafficView({ metrics }) {
  const [kind, setKind] = useState('')
  const rows = metrics.operations.filter(item => !kind || item.kind === kind)
  return <><RequestGraph metrics={metrics} />
    <div className="aw-subheading"><div><h3>Thời gian xử lý và lưu lượng</h3><p>Thống kê các mẫu còn giữ, tối đa 15 phút gần nhất.</p></div>
      <label className="aw-inline-select">Loại request<select aria-label="Loại request" value={kind} onChange={event => setKind(event.target.value)}><option value="">Tất cả</option><option>HTTP</option><option>SignalR</option></select></label></div>
    <div className="aw-table-wrap"><table><thead><tr><th>Thao tác</th><th>Số mẫu</th><th>Lỗi / Từ chối / Hủy</th><th>TB / p95</th><th>Dữ liệu vào / ra</th></tr></thead>
      <tbody>{rows.map(op => <tr key={op.kind + op.operation}><td><span className={`aw-protocol ${op.kind === 'HTTP' ? 'is-http' : 'is-hub'}`}>{op.kind}</span>
        <code className="aw-operation-name">{op.operation}</code></td><td>{number(op.count)}</td>
        <td><span className={op.errors ? 'aw-error' : ''}>{number(op.errors)}</span> / {number(op.rejected)} / {number(op.cancelled)}</td>
        <td>{number(op.averageMs)} / {number(op.p95Ms)} <small>ms</small></td><td>{bytes(op.inBytes)} / {bytes(op.outBytes)}</td></tr>)}</tbody></table>
      {!rows.length && <Empty icon="activity" title="Chưa có mẫu request">Dữ liệu sẽ xuất hiện khi ứng dụng có hoạt động.</Empty>}</div>
    <details className="aw-measurement-note"><summary>Cách đọc số liệu</summary><p>Thời gian xử lý gồm thời gian chạy và chờ ở backend. p95 là thời gian mà 95% mẫu không vượt quá; đây không phải độ trễ mạng.</p>
      <p>HTTP đo payload đọc và ghi. SignalR ước tính kích thước JSON của lời gọi; không tính sự kiện phát đi. Tệp truyền qua WebRTC không đi qua các bộ đếm này.</p>
      <p>Giữ tối đa 20.000 mẫu. {metrics.droppedSamples > 0 ? `Đã loại ${number(metrics.droppedSamples)} mẫu khi đạt giới hạn; thống kê có thể không phản ánh toàn bộ lưu lượng.` : 'Heartbeat được ghi nhận riêng trong danh sách thao tác.'}</p></details>
  </>
}

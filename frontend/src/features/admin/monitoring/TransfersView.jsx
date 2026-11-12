import { useEffect, useRef, useState } from 'react'
import Icon from '../../../components/Icon.jsx'
import { Empty, Freshness, Pager } from '../AdminUi.jsx'
import { bytes, fileStatus, sourceName, stageName, time } from '../format.js'

const liveStatuses = ['offered', 'accepted', 'transferring']
function TransferTimeline({ file, events, onClose }) {
  const heading = useRef(null)
  useEffect(() => { heading.current?.focus() }, [file.id])
  return <aside className="aw-transfer-detail" aria-labelledby="aw-transfer-title" onKeyDown={event => { if (event.key === 'Escape') onClose() }}>
    <header><div><h3 id="aw-transfer-title" ref={heading} tabIndex={-1}>Dòng thời gian phiên #{file.id}</h3>
    <p>{file.senderId} → {file.receiverId} · {bytes(file.fileSizeBytes)}</p></div>
    <button className="icon-btn" type="button" aria-label="Đóng dòng thời gian" onClick={onClose}><Icon name="close" /></button></header>
    <ol className="aw-transfer-timeline">{events.map((event, index) => <li key={index} className={['failure-report', 'failed'].includes(event.stage) ? 'has-error' : ''}>
      <span className="aw-timeline-point" /><div><span className="aw-source">{sourceName(event.source)}</span><br /><strong>{stageName(event.stage)}</strong><time dateTime={event.at}>{time(event.at)}</time>
        {event.bytes != null && <p>{bytes(event.bytes)}</p>}
        {event.reason && <p className="aw-error">{event.reason}</p>}</div></li>)}</ol>
    {!events.length && <Empty icon="history" title="Chưa có sự kiện">Chưa có mẫu của phiên này trong dữ liệu hiện có.</Empty>}
    <p className="aw-footnote">Hiển thị những sự kiện còn lưu trong 24 giờ, tối đa 500 sự kiện trên trang. Có thể thiếu báo cáo cuối nếu kết nối dừng đột ngột.</p>
  </aside>
}

export default function TransfersView({ data, loading, page, age, onPrevious, onNext }) {
  const [selectedId, setSelectedId] = useState(null)
  const trigger = useRef(null)
  const events = data.metrics.fileEvents
  const selected = data.files.find(file => file.id === selectedId)
  return <><div className="aw-subheading"><div><h3>Phiên truyền tệp</h3><p>Đối chiếu trạng thái trên máy chủ với báo cáo của hai bên.</p></div></div>
    <div className="aw-table-wrap"><table><thead><tr><th>Phiên / Hai bên</th><th>Kích thước</th><th>Trạng thái máy chủ</th><th>Báo cáo gần nhất</th></tr></thead>
      <tbody>{data.files.map(file => {
        const reports = events.filter(event => event.transferId === file.id)
        const last = reports.findLast(event => event.source !== 'backend')
        const failure = reports.findLast(event => ['failure-report', 'failed'].includes(event.stage))
        const progress = last?.bytes != null && file.fileSizeBytes > 0 ? Math.min(100, Math.max(0, last.bytes / file.fileSizeBytes * 100)) : null
        return <tr key={file.id} className={selectedId === file.id ? 'is-selected' : ''}><td><button className="aw-link" type="button" disabled={loading}
          onClick={event => { trigger.current = event.currentTarget; setSelectedId(file.id) }}>#{file.id}</button><small>{file.senderId} → {file.receiverId}</small></td>
          <td>{bytes(file.fileSizeBytes)}</td><td><span className={`aw-state aw-file-state--${file.status}`}>{fileStatus(file.status)}</span>
            {failure && <small className="aw-error">{failure.reason || 'Có báo cáo lỗi'} ({sourceName(failure.source)})</small>}
            {!failure && file.status === 'failed' && <small>Chưa đủ dữ liệu xác định nguyên nhân</small>}</td>
          <td>{last ? <div className="aw-file-report"><strong>{stageName(last.stage)}</strong><small>{sourceName(last.source)} · {bytes(last.bytes)}</small>
            {progress != null && <progress aria-label={`Tiến độ client báo cho phiên #${file.id}`} value={progress} max={100} />}
            {liveStatuses.includes(file.status) && <Freshness seconds={age(last)} label="Mẫu" />}</div> : <span className="aw-caption">Chưa có báo cáo client</span>}</td></tr>
      })}</tbody></table>{!data.files.length && <Empty icon="folder" title="Chưa có phiên truyền tệp">Các phiên truyền tệp sẽ được theo dõi tại đây.</Empty>}</div>
    <Pager page={page} loading={loading} hasNext={!!data.nextFileId} onPrevious={() => { setSelectedId(null); onPrevious() }}
      onNext={() => { setSelectedId(null); onNext() }} />
    {selected && <TransferTimeline file={selected} events={events.filter(event => event.transferId === selectedId)} onClose={() => { setSelectedId(null); trigger.current?.focus() }} />}
    <p className="aw-footnote">Báo cáo client phục vụ chẩn đoán; mẫu cũ hoặc báo lỗi không tự thay đổi trạng thái phiên trên máy chủ.</p>
  </>
}

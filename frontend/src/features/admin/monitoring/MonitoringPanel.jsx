import { useState } from 'react'
import { Feedback, Freshness } from '../AdminUi.jsx'
import { number, queryString } from '../format.js'
import { useAdminQuery, useElapsed } from '../useAdminQuery.js'
import ConnectionsView from './ConnectionsView.jsx'
import TrafficView from './TrafficView.jsx'
import TransfersView from './TransfersView.jsx'

const views = [['connections', 'Kết nối'], ['traffic', 'Lưu lượng'], ['transfers', 'Truyền tệp']]

export default function MonitoringPanel({ token, active = true, onFailure, onUser }) {
  const [view, setView] = useState('connections')
  const [userPages, setUserPages] = useState([0])
  const [filePages, setFilePages] = useState([''])
  const [refresh, setRefresh] = useState(0)
  const resource = useAdminQuery('/admin/monitoring?' + queryString({ afterUserId: userPages.at(-1), beforeFileId: filePages.at(-1) }),
    { token, active, interval: 5000, revision: refresh, onFailure })
  const elapsed = useElapsed(resource.receivedAt, active)
  const data = resource.data
  const metrics = data?.metrics
  const age = event => Math.max(0, (Date.parse(metrics.generatedAt) - Date.parse(event.at)) / 1000 + (elapsed || 0))
  function keyboard(event, index) {
    let next
    if (event.key === 'ArrowRight') next = (index + 1) % views.length
    if (event.key === 'ArrowLeft') next = (index + views.length - 1) % views.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = views.length - 1
    if (next == null) return
    event.preventDefault(); setView(views[next][0]); document.getElementById(`aw-monitor-tab-${views[next][0]}`).focus()
  }
  return <>
    <header className="aw-section-heading"><div><h2>Hoạt động hệ thống</h2><p>Kiểm tra kết nối, lưu lượng và diễn biến truyền tệp.</p></div>
      <button className="btn" type="button" disabled={resource.loading || [401, 403].includes(resource.status)} onClick={() => setRefresh(value => value + 1)}>Làm mới</button></header>
    <div className="aw-monitor-strip"><dl><div><dt>Kết nối mở</dt><dd>{metrics ? number(metrics.totalConnections) : '—'}</dd></div>
      <div><dt>Tài khoản có kết nối</dt><dd>{metrics ? number(metrics.connectedUsers) : '—'}</dd></div>
      <div><dt>Đang xử lý</dt><dd>{metrics ? `${number(metrics.activeHttp ?? 0)} HTTP / ${number(metrics.activeHub ?? 0)} Hub` : '—'}</dd></div></dl>
      <Freshness seconds={elapsed} /></div>
    <Feedback resource={resource} onRetry={() => setRefresh(value => value + 1)} />
    <div className="aw-monitor-tabs" role="tablist" aria-label="Nội dung giám sát">{views.map(([key, label], index) =>
      <button key={key} id={`aw-monitor-tab-${key}`} role="tab" type="button" aria-selected={view === key} tabIndex={view === key ? 0 : -1}
        aria-controls={`aw-monitor-panel-${key}`} onClick={() => setView(key)} onKeyDown={event => keyboard(event, index)}>{label}</button>)}</div>
    {data && <><section id="aw-monitor-panel-connections" role="tabpanel" aria-labelledby="aw-monitor-tab-connections" hidden={view !== 'connections'}>
      <ConnectionsView data={data} loading={resource.loading} page={userPages.length} age={age} onUser={onUser}
        onPrevious={() => setUserPages(values => values.slice(0, -1))} onNext={() => setUserPages(values => [...values, data.nextUserId])} /></section>
      <section id="aw-monitor-panel-traffic" role="tabpanel" aria-labelledby="aw-monitor-tab-traffic" hidden={view !== 'traffic'}><TrafficView metrics={metrics} /></section>
      <section id="aw-monitor-panel-transfers" role="tabpanel" aria-labelledby="aw-monitor-tab-transfers" hidden={view !== 'transfers'}>
        <TransfersView data={data} loading={resource.loading} page={filePages.length} age={age}
          onPrevious={() => setFilePages(values => values.slice(0, -1))} onNext={() => setFilePages(values => [...values, data.nextFileId])} /></section>
    </>}
  </>
}

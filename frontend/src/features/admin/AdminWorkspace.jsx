import { useCallback, useState } from 'react'
import Icon from '../../components/Icon.jsx'
import AccountsPanel from './accounts/AccountsPanel.jsx'
import AuditPanel from './audit/AuditPanel.jsx'
import MonitoringPanel from './monitoring/MonitoringPanel.jsx'
import { useAdminQuery } from './useAdminQuery.js'
import { number, time } from './format.js'
import './admin.css'

const sections = [
  ['users', 'Tài khoản', 'users', 'Tra cứu & quản lý quyền'],
  ['monitoring', 'Hoạt động hệ thống', 'activity', 'Kết nối - Truyền tệp - Lưu lượng'],
  ['logs', 'Nhật ký', 'history', 'Lịch sử xử lý tài khoản'],
]

function Overview({ token, active, revision, onFailure }) {
  const overview = useAdminQuery('/admin/overview', { token, active, revision, onFailure, interval: 15000 })
  const data = overview.data
  return <section className="aw-overview" aria-label="Tổng quan tài khoản"><h2 className="aw-sr-only">Tài khoản trên Nối</h2>
    <dl><div className="aw-total"><dt>Tổng tài khoản</dt><dd>{data ? number(data.total) : '—'}</dd></div>
      <div><dt><i className="aw-dot aw-dot--good" />Được truy cập</dt><dd>{data ? number(data.enabled) : '—'}</dd></div>
      <div><dt><i className="aw-dot aw-dot--danger" />Bị khóa</dt><dd>{data ? number(data.disabled) : '—'}</dd></div>
      <div><dt><i className="aw-dot aw-dot--online" />Đang online</dt><dd>{data ? number(data.online) : '—'}</dd></div></dl>
    <p className={`aw-overview-update ${overview.error ? 'aw-error' : ''}`} role="status">
      {overview.error ? `Chưa cập nhật được: ${overview.error}` : data ? `Cập nhật ${time(data.updatedAt)}` : 'Đang tải tổng quan…'}</p>
  </section>
}

export default function AdminWorkspace({ token, onSessionExpired, onAccessLost }) {
  const [section, setSection] = useState('users')
  const [revision, setRevision] = useState(0)
  const [logTarget, setLogTarget] = useState(null)
  const [selectedUser, setSelectedUser] = useState(null)
  const fail = useCallback(error => {
    if (error.status === 401) onSessionExpired?.()
    else if (error.status === 403) onAccessLost?.()
  }, [onSessionExpired, onAccessLost])
  const changed = useCallback(() => setRevision(value => value + 1), [])
  function showUser(id) { setSelectedUser(id); setSection('users') }
  function navigateByKey(event, index) {
    let next
    if (['ArrowDown', 'ArrowRight'].includes(event.key)) next = (index + 1) % sections.length
    if (['ArrowUp', 'ArrowLeft'].includes(event.key)) next = (index + sections.length - 1) % sections.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = sections.length - 1
    if (next == null) return
    event.preventDefault(); setSection(sections[next][0]); document.getElementById(`aw-tab-${sections[next][0]}`).focus()
  }
  return <div className="page admin-workspace">
    <header className="aw-header"><div><h1>Quản trị hệ thống</h1></div>
      <span className="aw-admin-mark"><Icon name="shield" />Quản trị viên</span></header>
    <div className="aw-layout">
      <div className="aw-navigation" role="tablist" aria-label="Chức năng quản trị" aria-orientation="horizontal">
        {sections.map(([key, label, icon, description], index) => <button key={key} id={`aw-tab-${key}`} role="tab" type="button"
          aria-label={label} aria-describedby={`aw-nav-description-${key}`} aria-selected={section === key} aria-controls={`aw-panel-${key}`} tabIndex={section === key ? 0 : -1}
          onKeyDown={event => navigateByKey(event, index)} onClick={() => setSection(key)}>
          <Icon name={icon} /><span><strong>{key === 'monitoring' ? <><span className="aw-nav-full">{label}</span><span className="aw-nav-short">Hoạt động</span></> : label}</strong><span className="aw-sr-only" id={`aw-nav-description-${key}`}>{description}</span></span></button>)}
      </div>
      <div className="aw-main">
        <section id="aw-panel-users" role="tabpanel" aria-labelledby="aw-tab-users" hidden={section !== 'users'}>
          <Overview token={token} active={section === 'users'} revision={revision} onFailure={fail} />
          <AccountsPanel token={token} active={section === 'users'} revision={revision} onFailure={fail} onChanged={changed}
            selected={selectedUser} onSelected={setSelectedUser} onLogs={user => { setLogTarget(user); setSection('logs') }} /></section>
        <section id="aw-panel-monitoring" role="tabpanel" aria-labelledby="aw-tab-monitoring" hidden={section !== 'monitoring'}>
          <MonitoringPanel token={token} active={section === 'monitoring'} onFailure={fail} onUser={showUser} /></section>
        <section id="aw-panel-logs" role="tabpanel" aria-labelledby="aw-tab-logs" hidden={section !== 'logs'}>
          <AuditPanel token={token} active={section === 'logs'} revision={revision} onFailure={fail} target={logTarget}
            onClearTarget={() => setLogTarget(null)} onUser={showUser} /></section>
      </div>
    </div>
  </div>
}

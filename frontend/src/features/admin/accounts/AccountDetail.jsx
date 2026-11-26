import { useEffect, useRef } from 'react'
import Avatar from '../../../components/Avatar.jsx'
import Icon from '../../../components/Icon.jsx'
import { AccountState, Feedback, Freshness } from '../AdminUi.jsx'
import { actionName, time } from '../format.js'
import { useAdminQuery, useElapsed } from '../useAdminQuery.js'

export default function AccountDetail({ token, active, revision, onFailure, resource, selected, busy, onRetry, onClose, onChange, onLogs }) {
  const heading = useRef(null)
  useEffect(() => { heading.current?.focus() }, [selected])
  const connections = useAdminQuery(`/admin/users/${selected}/connections`,
    { token, active, revision, onFailure, interval: 5000 })
  const age = useElapsed(connections.receivedAt, active)
  const snapshot = connections.data?.userId === selected ? connections.data : null
  const detail = resource.data?.user.id === selected ? resource.data : null
  const user = detail?.user
  return <aside className="aw-account-detail" aria-labelledby="aw-detail-title"
    onKeyDown={event => { if (event.key === 'Escape') onClose() }}>
    <header><h2 id="aw-detail-title" ref={heading} tabIndex={-1}>Chi tiết tài khoản</h2>
      <button className="aw-detail-close" type="button" aria-label="Đóng chi tiết tài khoản" onClick={onClose}>
        <span>Quay lại</span><Icon name="close" /></button></header>
    <Feedback resource={resource} onRetry={onRetry} />
    {user && <><div className="aw-profile"><Avatar size="lg" person={{ id: user.id, name: user.displayName }} />
      <h3>{user.displayName}</h3><p>@{user.username} - #{user.id}</p><AccountState user={user} /></div>
      <dl className="aw-facts"><div><dt>Vai trò</dt><dd>{user.role}</dd></div>
        <div><dt>Hiện diện</dt><dd><span className={`aw-presence ${user.isOnline ? 'online' : ''}`}>{user.isOnline ? 'Online' : 'Offline'}</span></dd></div>
        <div><dt>Ngày tạo</dt><dd>{time(user.createdAt)}</dd></div>
        <div><dt>Ghi nhận offline gần nhất</dt><dd>{time(user.lastSeenAt)}</dd></div></dl>
      <section className="aw-profile-connections" aria-label="Kết nối hiện tại">
        <div className="aw-detail-section-heading"><h3>Kết nối hiện tại</h3>
          {snapshot && <span className="aw-count">{snapshot.total}</span>}</div>
        <Feedback resource={{ ...connections, data: snapshot }} />
        {snapshot && <>
          <Freshness seconds={age} />
          {snapshot.connections.length ? <ul>{snapshot.connections.map(link => <li key={link.id}>
            <code title={link.id}>{link.id.slice(0, 12)}…</code>
            <dl><div><dt>Mở lúc</dt><dd>{time(link.connectedAt)}</dd></div>
              <div><dt>Heartbeat</dt><dd>{time(link.lastHeartbeatAt)}</dd></div></dl>
          </li>)}</ul> : <p className="aw-caption">Chưa ghi nhận kết nối SignalR đang mở.</p>}
          {snapshot.total > snapshot.connections.length && <p className="aw-caption">Hiển thị {snapshot.connections.length} / {snapshot.total} kết nối.</p>}
        </>}
      </section>
      {user.role === 'User' && <button className={`btn aw-wide ${user.isDisabled ? 'btn--primary' : 'btn--danger'}`} type="button"
        disabled={busy || resource.loading} onClick={() => onChange(user, !user.isDisabled)}>
        <Icon name={user.isDisabled ? 'unlock' : 'lock'} />{user.isDisabled ? 'Mở khóa tài khoản' : 'Khóa tài khoản'}</button>}
      <section className="aw-recent-history"><h3>Xử lý gần đây</h3>
        {detail.recentLogs.length ? <ol>{detail.recentLogs.map(log => <li key={log.id}>
          <strong>{actionName(log.action)} bởi @{log.adminUsername}</strong><time>{time(log.createdAt)}</time><p>{log.reason}</p></li>)}</ol>
          : <p className="aw-caption">Chưa có thao tác quản trị được ghi nhận.</p>}
        <button className="aw-link" type="button" onClick={() => onLogs(user)}>Xem nhật ký của tài khoản</button></section></>}
  </aside>
}

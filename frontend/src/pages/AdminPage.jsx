import { useState } from 'react'
import Avatar from '../components/Avatar.jsx'
import Icon from '../components/Icon.jsx'
import { AUDIT_LOGS, CURRENT_USER, PEOPLE } from '../data/mockData.js'

function AdminPage() {
  const [tab, setTab] = useState('users')
  const [query, setQuery] = useState('')
  const [users, setUsers] = useState([CURRENT_USER, ...PEOPLE])
  const filteredUsers = users.filter((user) => `${user.name}${user.username}`.toLowerCase().includes(query.toLowerCase()))
  const filteredLogs = AUDIT_LOGS.filter((log) => `${log.actor}${log.target}${log.reason}`.toLowerCase().includes(query.toLowerCase()))

  function toggleAccount(userId) {
    setUsers((current) => current.map((user) => user.id === userId ? { ...user, disabled: !user.disabled, online: user.disabled ? user.online : false } : user))
  }

  return (
    <div className="page">
      <div className="page-header"><div><h1>Quản trị hệ thống</h1><p>Quản lý tài khoản và theo dõi thao tác quản trị.</p></div></div>
      <div className="stat-strip"><div className="stat"><div className="stat-label">Tổng tài khoản</div><div className="stat-value">{users.length}<em>trong mẫu</em></div></div><div className="stat"><div className="stat-label">Đang hoạt động</div><div className="stat-value">{users.filter((user) => user.online && !user.disabled).length}<em>trực tuyến</em></div></div><div className="stat"><div className="stat-label">Bị khóa</div><div className="stat-value">{users.filter((user) => user.disabled).length}<em>tài khoản</em></div></div></div>
      <div className="page-toolbar"><div className="tabs"><button className={`tab${tab === 'users' ? ' active' : ''}`} type="button" onClick={() => setTab('users')}>Tài khoản</button><button className={`tab${tab === 'logs' ? ' active' : ''}`} type="button" onClick={() => setTab('logs')}>Nhật ký quản trị</button></div><label className="field-wrap admin-search"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm kiếm…" aria-label="Tìm kiếm quản trị" /></label></div>
      <div className="table-wrap">
        {tab === 'users' ? (
          <table><thead><tr><th>Tài khoản</th><th>Vai trò</th><th>Trạng thái</th><th className="right">Thao tác</th></tr></thead><tbody>{filteredUsers.map((user) => <tr key={user.id}><td><div className="id-cell"><Avatar person={user} size="sm" /><div className="id-cell-text"><strong>{user.name}</strong><small>@{user.username}</small></div></div></td><td><span className={`pill pill--${user.role === 'Admin' ? 'indigo' : 'gray'}`}>{user.role}</span></td><td><span className={`pill pill--${user.disabled ? 'red' : 'green'}`}>{user.disabled ? 'Bị khóa' : 'Hoạt động'}</span></td><td className="right">{user.role === 'Admin' ? <span className="muted">—</span> : <button className={`tbl-action${user.disabled ? '' : ' danger'}`} type="button" onClick={() => toggleAccount(user.id)}>{user.disabled ? 'Mở khóa' : 'Khóa tài khoản'}</button>}</td></tr>)}</tbody></table>
        ) : (
          <table><thead><tr><th>Thời gian</th><th>Người thực hiện</th><th>Đối tượng</th><th>Thao tác và lý do</th></tr></thead><tbody>{filteredLogs.map((log) => <tr key={log.id}><td>{log.time}</td><td>{log.actor}</td><td>@{log.target}</td><td><strong>{log.action}</strong><small className="audit-reason">{log.reason}</small></td></tr>)}</tbody></table>
        )}
      </div>
    </div>
  )
}

export default AdminPage

import { useState } from 'react'
import Avatar from '../../../components/Avatar.jsx'
import Icon from '../../../components/Icon.jsx'
import { Empty, Freshness, Pager } from '../AdminUi.jsx'
import { time } from '../format.js'

export default function ConnectionsView({ data, loading, page, age, onPrevious, onNext, onUser }) {
  const [search, setSearch] = useState('')
  const connections = data.metrics.connections
  const users = data.users.filter(user => `${user.username} ${user.displayName}`.toLowerCase().includes(search.toLowerCase()))
  return <><div className="aw-subheading"><div><h3>Kết nối theo tài khoản</h3><p>Một tài khoản có thể mở nhiều kết nối từ các tab khác nhau.</p></div></div>
    <label className="aw-search aw-monitor-search"><Icon name="search" /><input aria-label="Tìm trong trang kết nối" value={search}
      onChange={event => setSearch(event.target.value)} placeholder="Tìm người dùng trong trang hiện tại…" /></label>
    <div className="aw-table-wrap"><table><thead><tr><th>Tài khoản</th><th>Vai trò</th><th>Kết nối SignalR</th></tr></thead>
      <tbody>{users.map(user => {
        const links = connections.filter(link => link.userId === String(user.id))
        return <tr key={user.id}><td><div className="aw-identity"><Avatar size="sm" person={{ id: user.id, name: user.displayName }} />
          <div><button className="aw-link aw-person-name" type="button" onClick={() => onUser?.(user.id)}>{user.displayName}</button>
            <small>@{user.username} · #{user.id}</small>{user.isDisabled && <small className="aw-error">Bị khóa</small>}</div></div></td>
          <td><span className={`aw-role ${user.role === 'Admin' ? 'is-admin' : ''}`}>{user.role}</span></td>
          <td>{links.length ? <details className="aw-connection-list"><summary><span className="aw-presence online">{links.length} kết nối</span><span className="aw-caption">Xem chi tiết</span></summary>
            <ul>{links.map(link => <li key={link.id}><code title={link.id}>{link.id.slice(0, 12)}…</code><dl>
              <div><dt>Mở lúc</dt><dd>{time(link.connectedAt)}</dd></div><div><dt>Heartbeat</dt><dd>{time(link.lastHeartbeatAt)}</dd></div></dl>
              <Freshness seconds={link.lastHeartbeatAt ? age({ at: link.lastHeartbeatAt }) : null} label="Heartbeat" /></li>)}</ul>
          </details> : <span className="aw-caption">Không có kết nối trong mẫu</span>}</td></tr>
      })}</tbody></table>{!users.length && <Empty title="Không có tài khoản phù hợp">Thử tìm lại trong trang kết nối này.</Empty>}</div>
    <p className="aw-footnote">Mỗi trang tối đa 50 tài khoản và {data.metrics.connectionLimit} kết nối. Kết nối đang mở và trạng thái online là hai chỉ số riêng.</p>
    <Pager page={page} loading={loading} hasNext={!!data.nextUserId} onPrevious={onPrevious} onNext={onNext} />
  </>
}

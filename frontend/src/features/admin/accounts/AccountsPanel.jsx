import { useEffect, useRef, useState } from 'react'
import Avatar from '../../../components/Avatar.jsx'
import Icon from '../../../components/Icon.jsx'
import { request } from '../../../services/apiClient.js'
import { createClientMessageId } from '../../../utils/chatState.js'
import { AccountState, Empty, Feedback, Pager } from '../AdminUi.jsx'
import { actionName, number, queryString } from '../format.js'
import { useAdminQuery } from '../useAdminQuery.js'
import AccountActionDialog from './AccountActionDialog.jsx'
import AccountDetail from './AccountDetail.jsx'

export default function AccountsPanel({ token, active, revision, onFailure, onChanged, onLogs, selected, onSelected }) {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [role, setRole] = useState('')
  const [state, setState] = useState('')
  const [online, setOnline] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [pages, setPages] = useState([0])
  const [refresh, setRefresh] = useState(0)
  const [intent, setIntent] = useState(null)
  const [modal, setModal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [changeError, setChangeError] = useState('')
  const [notice, setNotice] = useState('')
  const trigger = useRef(null)
  useEffect(() => {
    if (query.trim() === search) return undefined
    const timer = setTimeout(() => { setSearch(query.trim()); setPages([0]) }, 300)
    return () => clearTimeout(timer)
  }, [query, search])
  const options = { token, active, revision: `${revision}:${refresh}`, onFailure }
  const list = useAdminQuery('/admin/users?' + queryString({ search, role, state, online, afterId: pages.at(-1) }), options)
  const detail = useAdminQuery(selected ? `/admin/users/${selected}` : null, options)
  function reload() { setRefresh(value => value + 1) }
  function view(id, element) { trigger.current = element; onSelected(id) }
  function closeDetail() {
    onSelected(null)
    requestAnimationFrame(() => trigger.current?.focus())
  }
  function prepare(user, disabled) {
    if (intent?.mode === 'unknown' && intent.user.id !== user.id) {
      setNotice(`Vui lòng kiểm tra kết quả với @${intent.user.username} trước.`); return
    }
    if (intent?.mode !== 'unknown') setIntent({ user, disabled, reason: '', requestId: createClientMessageId(), mode: 'confirm' })
    setChangeError(''); setModal(true)
  }
  async function confirm() {
    if (busy || !intent) return
    setBusy(true); setChangeError('')
    try {
      const result = await request(`/admin/users/${intent.user.id}/${intent.disabled ? 'disable' : 'enable'}`, {
        token, method: 'POST', body: { requestId: intent.requestId, expectedVersion: intent.user.version, reason: intent.reason },
      })
      setNotice(result.replayed
        ? `Thao tác ${actionName(result.operation.action).toLowerCase()} @${result.user.username} đã được ghi nhận. Hiện tại: ${result.user.isDisabled ? 'Bị khóa' : 'Được phép hoạt động'}.`
        : `Đã ${intent.disabled ? 'khóa' : 'mở khóa'} @${result.user.username}.${result.runtimeCleanupPending ? ' Quyền truy cập đã cập nhật; một số thông báo đang chờ xử lý.' : ''}`)
      setIntent(null); setModal(false); onChanged(); reload()
    } catch (failure) {
      onFailure(failure); setChangeError(failure.message)
      setIntent(current => ({ ...current, mode: !failure.status || failure.status >= 500 ? 'unknown' : failure.status === 409 ? 'conflict' : 'confirm' }))
    } finally { setBusy(false) }
  }
  async function reloadIntent() {
    setBusy(true)
    try {
      const result = await request(`/admin/users/${intent.user.id}`, { token })
      setIntent(current => ({ ...current, user: result.user, requestId: createClientMessageId(), mode: 'confirm' }))
      setChangeError(''); reload()
    } catch (failure) { setChangeError(failure.message); onFailure(failure) }
    finally { setBusy(false) }
  }
  function clearFilters() { setQuery(''); setSearch(''); setRole(''); setState(''); setOnline(''); setPages([0]) }
  const rows = list.data?.items || []
  const filterCount = [role, state, online].filter(Boolean).length
  return <div className={`aw-accounts ${selected ? 'has-open-detail' : ''}`}>
    {notice && <div className="aw-alert" role="status"><Icon name="check" /><span>{notice}</span>
      <button className="icon-btn" type="button" aria-label="Đóng thông báo" onClick={() => setNotice('')}><Icon name="close" /></button></div>}
    {intent?.mode === 'unknown' && !modal && <div className="aw-alert aw-alert--warning" role="status"><span>Cần kiểm tra kết quả với @{intent.user.username}.</span>
      <button className="aw-link" type="button" onClick={() => setModal(true)}>Kiểm tra kết quả</button></div>}
    <div className={`aw-account-workarea ${selected ? 'has-detail' : ''}`}><div className="aw-account-list" aria-busy={list.loading}>
    <header className="aw-section-heading"><div><h2>Danh sách tài khoản</h2></div>
      <button className="btn" type="button" disabled={list.loading} onClick={() => { reload(); onChanged() }}>Làm mới</button></header>
    <div className="aw-search-line"><label className="aw-search"><Icon name="search" /><input aria-label="Tìm tài khoản" value={query} maxLength={100}
      onChange={event => setQuery(event.target.value)} placeholder="Tìm tên hoặc username…" /></label>
      <button className="btn aw-filter-toggle" type="button" aria-expanded={filtersOpen} aria-controls="aw-account-filters"
        onClick={() => setFiltersOpen(value => !value)}>Bộ lọc{filterCount > 0 && <span className="aw-count">{filterCount}</span>}
        <span className="aw-chevron" aria-hidden="true" /></button></div>
    <div className="aw-filter-row" id="aw-account-filters" hidden={!filtersOpen}>
      <label>Vai trò<select value={role} onChange={event => { setRole(event.target.value); setPages([0]) }}><option value="">Tất cả</option><option>User</option><option>Admin</option></select></label>
      <label>Quyền sử dụng<select value={state} onChange={event => { setState(event.target.value); setPages([0]) }}><option value="">Tất cả trạng thái</option><option value="enabled">Được phép hoạt động</option><option value="disabled">Bị khóa</option></select></label>
      <label>Hiện diện<select value={online} onChange={event => { setOnline(event.target.value); setPages([0]) }}><option value="">Tất cả</option><option value="online">Online</option><option value="offline">Offline</option></select></label>
    </div>
    <Feedback resource={list} onRetry={reload} />

      {list.data && <><div className="aw-list-caption"><span>{number(list.data.total)} tài khoản phù hợp</span>{query || filterCount ? <button className="aw-link" type="button" onClick={clearFilters}>Xóa bộ lọc</button> : <span>25 tài khoản / trang</span>}</div>
        <div className="aw-table-wrap"><table className="aw-accounts-table"><thead><tr><th>Tài khoản</th><th>Vai trò</th><th>Quyền sử dụng</th><th>Thao tác</th></tr></thead>
          <tbody>{rows.map(user => <tr key={user.id} data-user-id={user.id} className={selected === user.id ? 'is-selected' : ''}>
            <td><div className="aw-identity"><Avatar size="sm" person={{ id: user.id, name: user.displayName, online: user.isOnline }} />
              <div><button className="aw-link aw-person-name" type="button" onClick={event => view(user.id, event.currentTarget)}>{user.displayName}</button>
                <small>@{user.username} - #{user.id}</small></div></div></td>
            <td><span className={`aw-role ${user.role === 'Admin' ? 'is-admin' : ''}`}>{user.role}</span></td>
            <td><AccountState user={user} /><small className={`aw-presence ${user.isOnline ? 'online' : ''}`}>{user.isOnline ? 'Online' : 'Offline'}</small></td>
            <td><div className="aw-row-actions"><button className="aw-link" type="button" onClick={event => view(user.id, event.currentTarget)}>Chi tiết</button>
              {user.role === 'User' && <button className={`aw-link ${user.isDisabled ? '' : 'aw-error'}`} type="button" disabled={list.loading || busy}
                onClick={() => prepare(user, !user.isDisabled)}>{user.isDisabled ? 'Mở khóa' : 'Khóa'}</button>}</div></td>
          </tr>)}</tbody></table>
          {!list.loading && !rows.length && <Empty title="Không tìm thấy tài khoản">Thử tên khác hoặc xóa bớt bộ lọc để xem thêm tài khoản.</Empty>}</div>
        <Pager page={pages.length} loading={list.loading} hasNext={!!list.data.nextCursor}
          onPrevious={() => setPages(values => values.slice(0, -1))} onNext={() => setPages(values => [...values, list.data.nextCursor])} /></>}
    </div>
      {selected && <AccountDetail token={token} active={active} revision={`${revision}:${refresh}`} onFailure={onFailure} resource={detail} selected={selected} busy={busy} onRetry={reload} onClose={closeDetail} onChange={prepare} onLogs={onLogs} />}
    </div>
    {modal && intent && <AccountActionDialog intent={intent} busy={busy} error={changeError} onConfirm={confirm} onReload={reloadIntent}
      onReason={reason => setIntent(current => ({ ...current, reason, requestId: createClientMessageId() }))}
      onClose={() => { setModal(false); if (intent.mode !== 'unknown') setIntent(null) }} />}
  </div>
}

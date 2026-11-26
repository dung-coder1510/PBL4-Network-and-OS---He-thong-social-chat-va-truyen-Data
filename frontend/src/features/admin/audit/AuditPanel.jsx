import { useState } from 'react'
import Icon from '../../../components/Icon.jsx'
import { AccountState, Empty, Feedback, Pager } from '../AdminUi.jsx'
import { actionName, queryString, time } from '../format.js'
import { useAdminQuery } from '../useAdminQuery.js'

export default function AuditPanel({ token, active, revision, onFailure, target, onUser, onClearTarget }) {
  const [actor, setActor] = useState('')
  const [search, setSearch] = useState('')
  const [action, setAction] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [filter, setFilter] = useState({})
  const [pageState, setPageState] = useState({ targetId: target?.id, cursors: [''] })
  const [refresh, setRefresh] = useState(0)
  const [validation, setValidation] = useState('')
  const pages = pageState.targetId === target?.id ? pageState.cursors : ['']
  const setPages = value => setPageState({ targetId: target?.id, cursors: typeof value === 'function' ? value(pages) : value })
  const logs = useAdminQuery('/admin/audit-logs?' + queryString({ ...filter, userId: target?.id, beforeId: pages.at(-1) }),
    { token, active, revision: `${revision}:${refresh}`, onFailure })
  function apply(event) {
    event.preventDefault()
    if (from && to && from > to) { setValidation('Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.'); return }
    const start = from ? new Date(from + 'T00:00:00+07:00').toISOString() : ''
    const end = to ? new Date(Date.parse(to + 'T00:00:00+07:00') + 86400000).toISOString() : ''
    setFilter({ actor: actor.trim(), target: search.trim(), action, from: start, to: end }); setPages(['']); setValidation('')
  }
  function clear() {
    setActor(''); setSearch(''); setAction(''); setFrom(''); setTo(''); setFilter({}); setPages(['']); setValidation(''); onClearTarget()
  }
  return <>
    <header className="aw-section-heading"><div><h2>Nhật ký quản trị</h2><p>Ai đã thay đổi quyền truy cập, vào lúc nào và vì sao.</p></div>
      <button className="btn" type="button" disabled={logs.loading} onClick={() => setRefresh(value => value + 1)}>Làm mới</button></header>
    {target && <div className="aw-alert"><Icon name="users" /><span>Đang lọc tài khoản @{target.username}</span>
      <button className="aw-link" type="button" onClick={onClearTarget}>Bỏ lọc tài khoản</button></div>}
    <form className="aw-audit-filters" onSubmit={apply}>
      <label>Tài khoản đích<input value={search} onChange={event => setSearch(event.target.value)} maxLength={100} placeholder="Tên hoặc @username" /></label>
      <label>Admin thực hiện<input value={actor} onChange={event => setActor(event.target.value)} maxLength={100} placeholder="Tên hoặc @username" /></label>
      <label>Thao tác<select value={action} onChange={event => setAction(event.target.value)}><option value="">Tất cả thao tác</option><option value="DisableUser">Khóa</option><option value="EnableUser">Mở khóa</option></select></label>
      <label>Từ ngày<input type="date" value={from} onChange={event => setFrom(event.target.value)} max="9998-12-31" /></label>
      <label>Đến ngày<input type="date" value={to} onChange={event => setTo(event.target.value)} max="9998-12-31" /></label>
      <div className="aw-filter-actions"><button className="btn btn--primary" type="submit">Áp dụng</button><button className="aw-link" type="button" onClick={clear}>Xóa bộ lọc</button></div>
    </form>
    {validation && <p className="aw-alert aw-alert--error" role="alert">{validation}</p>}
    <Feedback resource={logs} onRetry={() => setRefresh(value => value + 1)} />
    {logs.data && <><div className="aw-list-caption"><span>Các thao tác đã hoàn thành</span><span>Giờ Việt Nam</span></div>
      <ol className="aw-audit-feed" aria-label="Các thao tác quản trị" aria-busy={logs.loading}>
        {logs.data.items.map(log => <li key={log.id} className={log.newIsDisabled ? 'is-disable' : 'is-enable'}>
          <span className="aw-audit-marker"><Icon name={log.newIsDisabled ? 'lock' : 'unlock'} /></span>
          <article><header><div><strong>{log.adminName}</strong><span> đã {actionName(log.action).toLowerCase()} </span>
            <button className="aw-link" type="button" onClick={() => onUser(log.targetUserId)}>@{log.targetUsername}</button></div>
            <time dateTime={log.createdAt}>{time(log.createdAt)}</time></header>
            <p className="aw-audit-actor">@{log.adminUsername} - Tài khoản đích #{log.targetUserId}</p>
            <div className="aw-state-change"><AccountState user={{ isDisabled: log.oldIsDisabled }} /><span aria-label="chuyển thành">→</span>
              <AccountState user={{ isDisabled: log.newIsDisabled }} /></div>
            <p className="aw-audit-reason">{log.reason}</p>
            <details className="aw-record-details"><summary>Thông tin bản ghi</summary><dl><div><dt>Mã bản ghi</dt><dd>{log.id}</dd></div>
              <div><dt>Mã thao tác</dt><dd>{log.requestId}</dd></div></dl></details>
          </article>
        </li>)}
      </ol>
      {!logs.loading && !logs.data.items.length && <Empty icon="history" title="Chưa có nhật ký phù hợp">Các lần khóa và mở khóa thành công sẽ xuất hiện tại đây.</Empty>}
      <Pager page={pages.length} loading={logs.loading} hasNext={!!logs.data.nextCursor} onPrevious={() => setPages(values => values.slice(0, -1))}
        onNext={() => setPages(values => [...values, logs.data.nextCursor])} /></>}
  </>
}

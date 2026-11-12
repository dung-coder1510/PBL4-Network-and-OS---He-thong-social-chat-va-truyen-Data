import Icon from '../../components/Icon.jsx'

export function AccountState({ user }) {
  return <span className={`aw-state ${user.isDisabled ? 'aw-state--danger' : 'aw-state--good'}`}>
    {user.isDisabled ? 'Bị khóa' : 'Được phép hoạt động'}</span>
}
export function Feedback({ resource, onRetry }) {
  return <>{resource.loading && !resource.data && <p className="aw-feedback" role="status">Đang tải dữ liệu…</p>}
    {resource.error && <div className="aw-alert aw-alert--error" role="alert"><Icon name="info" /><span>{resource.error}</span>
      {onRetry && ![401, 403].includes(resource.status) && <button className="aw-link" type="button" onClick={onRetry}>Thử lại</button>}</div>}</>
}
export function Empty({ icon = 'search', title, children }) {
  return <div className="aw-empty"><span className="aw-empty-symbol"><Icon name={icon} /></span><h3>{title}</h3>{children && <p>{children}</p>}</div>
}
export function Pager({ page, loading, hasNext, onPrevious, onNext }) {
  return <div className="aw-pager"><span>Trang {page}</span><div>
    <button className="btn" type="button" disabled={page === 1 || loading} onClick={onPrevious}>Trang trước</button>
    <button className="btn" type="button" disabled={!hasNext || loading} onClick={onNext}>Trang tiếp</button></div></div>
}
export function Freshness({ seconds, label = 'Cập nhật' }) {
  const level = seconds == null ? 'unknown' : seconds <= 10 ? 'fresh' : seconds <= 20 ? 'late' : 'stale'
  return <span className={`aw-freshness ${level}`} role="status"><i aria-hidden="true" />
    {seconds == null ? 'Chưa có mẫu' : `${label} ${Math.floor(seconds)} giây trước`}</span>
}

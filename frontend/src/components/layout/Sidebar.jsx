import Icon from '../Icon.jsx'

const NAV_ITEMS = [
  ['chat', 'chat', 'Trò chuyện'],
  ['contacts', 'users', 'Danh bạ'],
  ['calls', 'phone', 'Cuộc gọi'],
  ['files', 'folder', 'Tệp'],
  ['admin', 'shield', 'Quản trị'],
]

function Sidebar({ currentPage, onLogout, onNavigate, user, loggingOut }) {
  return (
    <aside className="sidebar" aria-label="Điều hướng chính">
      <div className="sidebar-drag-handle">
        <button className="brand" type="button" onClick={() => onNavigate('chat')} aria-label="Nối, về trò chuyện">
          <span className="brand-logo" aria-hidden="true">N</span>
          <span className="brand-name">Nối<span className="brand-dot">.</span></span>
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="Màn hình chính">
        {NAV_ITEMS.filter(([page]) => page !== 'admin' || user.role === 'Admin').map(([page, icon, label]) => (
          <button
            className={`nav-item${currentPage === page ? ' active' : ''}`}
            type="button"
            key={page}
            onClick={() => onNavigate(page)}
            aria-label={label}
            aria-current={currentPage === page ? 'page' : undefined}
          >
            <Icon name={icon} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button className={`nav-item${currentPage === 'settings' ? ' active' : ''}`} type="button" onClick={() => onNavigate('settings')} aria-label="Cài đặt">
          <Icon name="settings" />
          <span>Cài đặt</span>
        </button>
        <button className="nav-item" type="button" onClick={onLogout} disabled={loggingOut} aria-label={loggingOut ? 'Đang đăng xuất' : 'Đăng xuất'}>
          <Icon name="logout" />
          <span>{loggingOut ? 'Đang đăng xuất…' : 'Đăng xuất'}</span>
        </button>
      </div>
    </aside>
  )
}

export default Sidebar

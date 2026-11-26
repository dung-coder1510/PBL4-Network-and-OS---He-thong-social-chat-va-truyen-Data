import Avatar from '../Avatar.jsx'
import Icon from '../Icon.jsx'
import { useChatRealtime } from '../../realtime/chatRealtimeContext.js'
import { useFileTransfers } from '../../realtime/fileTransferContext.js'
import { useNotifications } from '../../realtime/notificationContext.js'

const NAV_ITEMS = [
  ['chat', 'chat', 'Trò chuyện'],
  ['contacts', 'users', 'Danh bạ'],
  ['calls', 'phone', 'Cuộc gọi'],
  ['files', 'folder', 'Tệp'],
  ['admin', 'shield', 'Quản trị'],
]

function Sidebar({ currentPage, onLogout, onNavigate, user, loggingOut, theme = 'light', onThemeChange }) {
  const realtime = useChatRealtime()
  const files = useFileTransfers()
  const { totalUnreadMessages, pendingFileCount } = useNotifications()
  const connectionState = realtime?.connectionState || 'disconnected'
  const transmitting = files?.items?.filter(transfer => transfer.status === 'transferring' &&
    (transfer.senderConnectionId === files.connectionId ||
     transfer.receiverConnectionId === files.connectionId ||
     transfer.localRelayEndpoint)).length || 0
  const statusClass = connectionState === 'connected' ? 'online'
    : connectionState === 'connecting' ? 'reconnecting' : 'offline'
  const statusText = connectionState === 'connected' ? 'Đã kết nối'
    : connectionState === 'connecting' ? 'Đang kết nối…' : 'Mất kết nối'

  return (
    <aside className="sidebar" aria-label="Điều hướng chính">
      <div className="sidebar-head">
        <button className="brand" type="button" onClick={() => onNavigate('chat')} aria-label="Nối, về trò chuyện">
          <span className="brand-logo" aria-hidden="true">N</span>
          <span className="brand-name">Nối<span className="brand-dot">.</span></span>
        </button>
        {onThemeChange && (
          <button
            className="icon-btn sidebar-theme-btn"
            type="button"
            onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}
            aria-label={theme === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}
            title={theme === 'dark' ? 'Giao diện sáng' : 'Giao diện tối'}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size="ico-sm" />
          </button>
        )}
      </div>

      <nav className="sidebar-nav" aria-label="Màn hình chính">
        {NAV_ITEMS.filter(([page]) => page !== 'admin' || user.role === 'Admin').map(([page, icon, label]) => {
          const badge = page === 'chat' ? totalUnreadMessages : page === 'files' ? pendingFileCount : 0
          const badgeLabel = badge > 99 ? '99+' : String(badge)
          return (
            <button
              className={`nav-item${currentPage === page ? ' active' : ''}`}
              type="button"
              key={page}
              onClick={() => onNavigate(page)}
              aria-label={label}
              title={badge > 0 ? `${label} (${badgeLabel} mới)` : label}
              aria-current={currentPage === page ? 'page' : undefined}
            >
              <Icon name={icon} />
              <span>{label}</span>
              {badge > 0 && (
                <span className={`nav-badge${page === 'files' ? ' nav-badge--green' : ''}`} aria-hidden="true">
                  {badgeLabel}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-account-card" title={`${user.displayName} (@${user.username}) - ${statusText}`}>
          <Avatar person={{ id: user.id, name: user.displayName }} size="sm" />
          <div className="sidebar-account-meta">
            <strong className="sidebar-account-name">{user.displayName}</strong>
            <span className="sidebar-account-status">
              <span className={`status-dot-pulse ${statusClass}`} aria-hidden="true" />
              <span>{statusText}</span>
              {transmitting > 0 && <span className="sidebar-transfer-chip">- {transmitting} tệp</span>}
            </span>
          </div>
        </div>
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

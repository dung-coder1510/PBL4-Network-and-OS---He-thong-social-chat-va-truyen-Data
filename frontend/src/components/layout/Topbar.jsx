import Icon from '../Icon.jsx'

const PAGE_NAMES = {
  chat: 'Trò chuyện',
  contacts: 'Danh bạ',
  calls: 'Cuộc gọi',
  files: 'Tệp',
  admin: 'Quản trị',
  settings: 'Cài đặt',
}

function Topbar({ currentPage, onOpenSettings, user }) {
  const initials = user.displayName.trim().split(/\s+/).slice(-2).map(part => part[0]).join('').toUpperCase()
  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="window-title-region">
          <span className="window-client-badge">P2P CLIENT</span>
          <span className="topbar-section">{PAGE_NAMES[currentPage]}</span>
        </div>
      </div>
      <div className="topbar-right">
        <div className="proto-badge" title="Trạng thái tài khoản">
          <span className="proto-dot" aria-hidden="true" />
          <span>Đã đăng nhập</span>
        </div>
        <button className="avatar-btn" type="button" onClick={onOpenSettings} aria-label={`Cài đặt tài khoản ${user.displayName}`}>
          {initials}
        </button>
        <div className="window-controls" aria-label="Điều khiển cửa sổ minh họa">
          <button className="win-btn" type="button" aria-label="Thu nhỏ"><Icon name="window-minimize" /></button>
          <button className="win-btn" type="button" aria-label="Phóng to"><Icon name="window-maximize" /></button>
          <button className="win-btn win-btn--close" type="button" aria-label="Đóng"><Icon name="close" /></button>
        </div>
      </div>
    </header>
  )
}

export default Topbar

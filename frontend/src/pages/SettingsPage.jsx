import { useState } from 'react'
import Avatar from '../components/Avatar.jsx'
import Icon from '../components/Icon.jsx'


function AppearanceSettings({ onThemeChange, theme }) {
  const [compact, setCompact] = useState(false)
  return <><div className="settings-card"><h3>Giao diện</h3><p>Chọn nền sáng hoặc tối theo sở thích.</p><div className="theme-options">{[['light', 'Sáng', 'sun'], ['dark', 'Tối', 'moon']].map(([value, label, icon]) => <button className="theme-opt" type="button" aria-pressed={theme === value} onClick={() => onThemeChange(value)} key={value}><div className={`theme-preview${value === 'dark' ? ' dp' : ''}`}><div className="theme-preview-sidebar" /><div className="theme-preview-main"><div className="theme-preview-msgs"><div className="theme-preview-msg in" /><div className="theme-preview-msg out" /></div></div></div><div className="theme-opt-label"><Icon name={icon} />{label}{theme === value ? <span className="theme-check"><Icon name="check" size="ico-sm" /></span> : null}</div></button>)}</div></div><div className="settings-card"><h3>Hiển thị và thao tác</h3><div className="setting-row"><div><strong>Giao diện gọn</strong><p>Giảm khoảng cách giữa các tin nhắn.</p></div><button className="toggle" type="button" role="switch" aria-checked={compact} onClick={() => setCompact((current) => !current)} /></div><div className="setting-row"><div><strong>Phím gửi tin nhắn</strong><p>Shift + Enter luôn xuống dòng.</p></div><select aria-label="Cách gửi tin nhắn"><option>Enter để gửi</option><option>Dùng nút gửi</option></select></div></div></>
}

function ProfileSettings({ user }) {
  return <form className="settings-card" onSubmit={(event) => event.preventDefault()}><h3>Hồ sơ cá nhân</h3><p>Thông tin hiển thị với người bạn kết nối.</p><div className="profile-avatar"><Avatar person={{ id: user.id, name: user.displayName, color: 'blue' }} size="lg" /></div><div className="form-field"><label htmlFor="display-name">Tên hiển thị</label><input id="display-name" value={user.displayName} readOnly /></div><div className="form-field"><label htmlFor="username">Tên đăng nhập</label><input id="username" value={user.username} readOnly /></div><div className="form-field"><label htmlFor="account-role">Vai trò</label><input id="account-role" value={user.role === 'Admin' ? 'Quản trị viên' : 'Người dùng'} readOnly /></div></form>
}

function NotificationsSettings() {
  const [enabled, setEnabled] = useState(true)
  return <div className="settings-card"><h3>Thông báo</h3><p>Cấu hình cách ứng dụng thông báo cho bạn.</p><div className="setting-row"><div><strong>Thông báo trong ứng dụng</strong><p>Hiển thị khi có tin nhắn hoặc cuộc gọi mới.</p></div><button className="toggle" type="button" role="switch" aria-checked={enabled} onClick={() => setEnabled((current) => !current)} /></div></div>
}

function DeveloperSettings() {
  const [enabled, setEnabled] = useState(false)
  return <><div className="settings-card"><div className="dev-banner"><span className="dev-banner-icon">🛠️</span><div><h4>Chế độ nhà phát triển</h4><p>Công cụ kiểm thử SignalR, ICE và WebRTC cho đồ án PBL4.</p></div></div><div className="setting-row"><div><strong>Kích hoạt chế độ nhà phát triển</strong><p>Mở các thông số chẩn đoán và giả lập mạng.</p></div><button className="toggle" type="button" role="switch" aria-checked={enabled} onClick={() => setEnabled((current) => !current)} /></div></div>{enabled ? <div className="settings-card"><h3>Giả lập điều kiện mạng</h3><div className="setting-row"><div><strong>Độ trễ giả lập</strong><p>Thêm độ trễ vào phản hồi thời gian thực.</p></div><select aria-label="Độ trễ giả lập"><option>0 ms</option><option>80 ms</option><option>250 ms</option><option>600 ms</option></select></div><div className="setting-row"><div><strong>Tỷ lệ rớt gói</strong><p>Mô phỏng mất gói trên WebRTC DataChannel.</p></div><select aria-label="Tỷ lệ rớt gói"><option>0%</option><option>5%</option><option>15%</option></select></div></div> : null}</>
}

function SettingsPage({ onThemeChange, theme, user }) {
  const [tab, setTab] = useState('appearance')
  return <div className="page"><div className="page-header"><div><h1>Cài đặt</h1><p>Tùy chỉnh ứng dụng theo cách của bạn.</p></div></div><div className="settings-layout"><nav className="settings-sidebar" aria-label="Nhóm cài đặt">{[['appearance', 'Giao diện'], ['profile', 'Hồ sơ'], ['notifications', 'Thông báo'], ['developer', 'Nhà phát triển 🛠️']].map(([value, label]) => <button className={`settings-tab${tab === value ? ' active' : ''}`} type="button" onClick={() => setTab(value)} key={value}>{label}</button>)}</nav><div>{tab === 'appearance' ? <AppearanceSettings onThemeChange={onThemeChange} theme={theme} /> : null}{tab === 'profile' ? <ProfileSettings user={user} /> : null}{tab === 'notifications' ? <NotificationsSettings /> : null}{tab === 'developer' ? <DeveloperSettings /> : null}</div></div></div>
}

export default SettingsPage


import { useState } from 'react'
import Avatar from '../components/Avatar.jsx'
import Icon from '../components/Icon.jsx'
import { MAX_FILE_CHANNELS, PARALLEL_CONNECTION_COUNT, V7_CONNECTION_COUNTS } from '../services/fileProtocol.js'
import { RELAY_CONNECTION_COUNTS } from '../services/fileRelayProtocol.js'
import { useNotifications } from '../realtime/notificationContext.js'
import RelayDiagnostics from '../components/files/RelayDiagnostics.jsx'


function AppearanceSettings({ onThemeChange, theme, uiSettings, onUiSettingsChange }) {
  const compactMode = uiSettings?.compactMode === true
  const sendWithEnter = uiSettings?.sendWithEnter !== false
  return <>
    <div className="settings-card"><h3>Giao diện</h3><p>Chọn nền sáng hoặc tối theo sở thích.</p><div className="theme-options">{[['light', 'Sáng', 'sun'], ['dark', 'Tối', 'moon']].map(([value, label, icon]) => <button className="theme-opt" type="button" aria-pressed={theme === value} onClick={() => onThemeChange(value)} key={value}><div className={`theme-preview${value === 'dark' ? ' dp' : ''}`}><div className="theme-preview-sidebar" /><div className="theme-preview-main"><div className="theme-preview-msgs"><div className="theme-preview-msg in" /><div className="theme-preview-msg out" /></div></div></div><div className="theme-opt-label"><Icon name={icon} />{label}{theme === value ? <span className="theme-check"><Icon name="check" size="ico-sm" /></span> : null}</div></button>)}</div></div>
    <div className="settings-card"><h3>Hiển thị và thao tác</h3>
      <div className="setting-row"><div><strong>Giao diện gọn</strong><p>Giảm khoảng cách giữa các tin nhắn và danh sách hội thoại.</p></div><button className="toggle" type="button" role="switch" aria-checked={compactMode} onClick={() => onUiSettingsChange?.({ ...uiSettings, compactMode: !compactMode })} /></div>
      <div className="setting-row"><div><strong>Phím gửi tin nhắn</strong><p>Shift + Enter luôn xuống dòng.</p></div>
        <select aria-label="Cách gửi tin nhắn" value={sendWithEnter ? 'enter' : 'button'}
          onChange={event => onUiSettingsChange?.({ ...uiSettings, sendWithEnter: event.target.value === 'enter' })}>
          <option value="enter">Enter để gửi</option>
          <option value="button">Dùng nút gửi</option>
        </select>
      </div>
    </div>
  </>
}

function ProfileSettings({ user }) {
  return <form className="settings-card" onSubmit={(event) => event.preventDefault()}><h3>Hồ sơ cá nhân</h3><p>Thông tin hiển thị với người bạn kết nối.</p><div className="profile-avatar"><Avatar person={{ id: user.id, name: user.displayName }} size="lg" /></div><div className="form-field"><label htmlFor="display-name">Tên hiển thị</label><input id="display-name" value={user.displayName} readOnly /></div><div className="form-field"><label htmlFor="username">Tên đăng nhập</label><input id="username" value={user.username} readOnly /></div><div className="form-field"><label htmlFor="account-role">Vai trò</label><input id="account-role" value={user.role === 'Admin' ? 'Quản trị viên' : 'Người dùng'} readOnly /></div></form>
}

const PERMISSION_LABELS = {
  granted: 'Đã cấp quyền',
  default: 'Chưa cấp quyền',
  denied: 'Đang bị chặn',
  unsupported: 'Trình duyệt không hỗ trợ',
}

function NotificationsSettings({ settings, onChange }) {
  const { sendTest } = useNotifications()
  const [permission, setPermission] = useState(() => (
    typeof globalThis.Notification === 'function' ? globalThis.Notification.permission : 'unsupported'
  ))

  const desktopActive = settings.desktopEnabled && permission === 'granted'

  async function toggleDesktop() {
    if (permission === 'unsupported') return
    if (desktopActive) {
      onChange?.({ ...settings, desktopEnabled: false })
      return
    }
    if (permission === 'granted') {
      onChange?.({ ...settings, desktopEnabled: true })
      return
    }
    if (permission === 'default') {
      try {
        const result = await globalThis.Notification.requestPermission()
        setPermission(result)
        onChange?.({ ...settings, desktopEnabled: result === 'granted' })
      } catch {
        setPermission(typeof globalThis.Notification === 'function' ? globalThis.Notification.permission : 'denied')
      }
    }
  }

  return (
    <div className="settings-card">
      <h3>Thông báo</h3>
      <p>Cấu hình cách Nối báo tin nhắn và lời mời nhận tệp cho bạn.</p>
      <div className="setting-row">
        <div>
          <strong>Thông báo trong ứng dụng</strong>
          <p>Hiện thẻ nổi ở góc màn hình khi có tin nhắn hoặc tệp mới lúc bạn đang ở trang khác.</p>
        </div>
        <button
          className="toggle"
          type="button"
          role="switch"
          aria-label="Thông báo trong ứng dụng"
          aria-checked={settings.inAppEnabled}
          onClick={() => onChange?.({ ...settings, inAppEnabled: !settings.inAppEnabled })}
        />
      </div>

      <div className="setting-row">
        <div>
          <strong>Âm thanh thông báo</strong>
          <p>Phát âm báo nhẹ khi có tin nhắn mới hoặc lời mời nhận tệp đến.</p>
        </div>
        <button
          className="toggle"
          type="button"
          role="switch"
          aria-label="Âm thanh thông báo"
          aria-checked={settings.soundEnabled}
          onClick={() => onChange?.({ ...settings, soundEnabled: !settings.soundEnabled })}
        />
      </div>

      <div className="setting-row">
        <div>
          <strong>Thông báo trên màn hình (trình duyệt)</strong>
          <p>
            Hiển thị thông báo hệ thống khi bạn đang mở tab hoặc cửa sổ khác ({PERMISSION_LABELS[permission] || permission}).
          </p>
          {permission === 'denied' && (
            <small className="notif-perm-note">Hãy bấm vào biểu tượng ổ khóa trên thanh địa chỉ trình duyệt để cấp quyền Thông báo lại.</small>
          )}
        </div>
        <button
          className="toggle"
          type="button"
          role="switch"
          aria-label="Thông báo trên màn hình"
          aria-checked={desktopActive}
          disabled={permission === 'unsupported' || permission === 'denied'}
          onClick={() => { void toggleDesktop() }}
        />
      </div>

      <div className="setting-row settings-test-row">
        <div>
          <strong>Kiểm tra nhanh</strong>
          <p>Gửi thử một thông báo xem âm báo và giao diện hiển thị đã đúng ý chưa.</p>
        </div>
        <button className="btn" type="button" onClick={sendTest}>Gửi thử thông báo</button>
      </div>
    </div>
  )
}

function DeveloperSettings({ settings, onChange, token }) {
  return <>
    <div className="settings-card">
      <div className="dev-banner"><span className="dev-banner-badge" aria-hidden="true"><Icon name="shield" size="ico-lg" /></span>
        <div><h4>Chế độ nhà phát triển</h4><p>Công cụ kiểm thử SignalR, ICE và WebRTC cho đồ án PBL4.</p></div>
      </div>
      <div className="setting-row">
        <div><strong>Kích hoạt chế độ nhà phát triển</strong><p>Tắt để ứng dụng tự chọn cấu hình truyền file. Bật để điều chỉnh thủ công.</p></div>
        <button className="toggle" type="button" role="switch" aria-label="Kích hoạt chế độ nhà phát triển"
          aria-checked={settings.enabled} onClick={() => onChange({ ...settings, enabled: !settings.enabled })} />
      </div>
    </div>
    {settings.enabled && <>
      <div className="settings-card"><h3>Truyền file trực tiếp (WebRTC P2P)</h3>
        <div className="setting-row">
          <div><strong>Kết nối WebRTC riêng (v7)</strong><p>Bật để dùng giao thức file-v7 qua 1, 2 hoặc 4 kết nối độc lập cho cả tệp nhỏ và lớn.</p></div>
          <button className="toggle" type="button" role="switch" aria-label="Dùng hai kết nối WebRTC riêng"
            aria-checked={settings.parallelFileConnections}
            onClick={() => onChange({ ...settings, parallelFileConnections: !settings.parallelFileConnections })} />
        </div>
        <div className="setting-row">
          <div><label htmlFor="webrtc-connection-count"><strong>Số kết nối WebRTC</strong></label>
            <p>Thử nghiệm 1, 2 hoặc 4 kết nối P2P song song (tắt chế độ nhà phát triển mặc định dùng 2 kết nối cho tệp lớn).</p>
          </div>
          <select id="webrtc-connection-count"
            value={settings.parallelFileConnections
              ? String(settings.webrtcConnectionCount ?? PARALLEL_CONNECTION_COUNT) : ''}
            onChange={event => {
              const value = event.target.value
              if (!value) onChange({ ...settings, parallelFileConnections: false })
              else onChange({ ...settings, parallelFileConnections: true, webrtcConnectionCount: Number(value) })
            }}>
            <option value="">Tắt (theo số kênh)</option>
            {V7_CONNECTION_COUNTS.map(count =>
              <option key={count} value={String(count)}>{count} kết nối</option>)}
          </select>
        </div>
        <div className="setting-row">
          <div><label htmlFor="file-channel-count"><strong>Số kênh truyền file</strong></label>
            <p>Áp dụng từ lượt gửi tiếp theo. Hai máy chốt số kênh khi nhận lời mời.</p>
          </div>
          <select id="file-channel-count" disabled={settings.parallelFileConnections}
            value={settings.parallelFileConnections
              ? (settings.webrtcConnectionCount ?? PARALLEL_CONNECTION_COUNT)
              : settings.fileChannelCount}
            onChange={event => onChange({ ...settings, fileChannelCount: Number(event.target.value) })}>
            {Array.from({ length: MAX_FILE_CHANNELS }, (_, index) => index + 1).map(count =>
              <option key={count} value={count}>{count} kênh</option>)}
          </select>
        </div>
        <div className="setting-row">
          <div><strong>Cho phép chuyển tiếp qua TURN</strong>
            <p>Tắt (mặc định): khi không đi P2P trực tiếp sẽ chuyển thẳng sang 4 luồng HTTPS thay vì TURN. Chỉ cần bật ở một trong hai máy cho lượt gửi mới.</p>
          </div>
          <button className="toggle" type="button" role="switch" aria-label="Cho phép chuyển tiếp qua TURN cho truyền file"
            aria-checked={settings.allowTurnForFiles}
            onClick={() => onChange({ ...settings, allowTurnForFiles: !settings.allowTurnForFiles })} />
        </div>
      </div>
      <div className="settings-card"><h3>Truyền file qua máy chủ</h3>
        <div className="setting-row">
          <div><label htmlFor="relay-connection-count"><strong>Số kết nối HTTPS</strong></label>
            <p>Áp dụng từ lượt gửi tiếp theo cho cả tải lên và tải xuống đa phần (tắt chế độ nhà phát triển mặc định dùng 4 kết nối).</p></div>
          <select id="relay-connection-count" value={settings.relayConnectionCount}
            onChange={event => onChange({ ...settings, relayConnectionCount: Number(event.target.value), relayConfigured: true })}>
            {RELAY_CONNECTION_COUNTS.map(count => <option key={count} value={count}>{count} kết nối</option>)}
          </select>
        </div>
        <RelayDiagnostics token={token} />
      </div>
    </>}
  </>
}

const SETTINGS_TABS = [
  ['appearance', 'Giao diện', 'sun', undefined],
  ['profile', 'Hồ sơ', 'users', undefined],
  ['notifications', 'Thông báo', 'bell', undefined],
  ['developer', 'Nhà phát triển', 'activity', 'Nhà phát triển 🛠️'],
]

function SettingsPage({
  onThemeChange,
  theme,
  user,
  token,
  uiSettings,
  onUiSettingsChange,
  notificationSettings,
  onNotificationSettingsChange,
  developerSettings,
  onDeveloperSettingsChange,
}) {
  const [tab, setTab] = useState('appearance')
  return <div className="page"><div className="page-header"><div><h1>Cài đặt</h1><p>Tùy chỉnh ứng dụng theo cách của bạn.</p></div></div><div className="settings-layout"><nav className="settings-sidebar" aria-label="Nhóm cài đặt">{SETTINGS_TABS.map(([value, label, icon, ariaLabel]) => <button className={`settings-tab${tab === value ? ' active' : ''}`} type="button" aria-label={ariaLabel} onClick={() => setTab(value)} key={value}><Icon name={icon} size="ico-sm" /><span>{label}</span></button>)}</nav><div>{tab === 'appearance' ? <AppearanceSettings onThemeChange={onThemeChange} theme={theme} uiSettings={uiSettings} onUiSettingsChange={onUiSettingsChange} /> : null}{tab === 'profile' ? <ProfileSettings user={user} /> : null}{tab === 'notifications' ? <NotificationsSettings settings={notificationSettings} onChange={onNotificationSettingsChange} /> : null}{tab === 'developer' ? <DeveloperSettings settings={developerSettings} onChange={onDeveloperSettingsChange} token={token} /> : null}</div></div></div>
}

export default SettingsPage


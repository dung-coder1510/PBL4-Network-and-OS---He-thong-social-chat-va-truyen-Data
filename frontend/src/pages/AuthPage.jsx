import { useEffect, useRef, useState } from 'react'
import Icon from '../components/Icon.jsx'
import { authApi } from '../services/authApi.js'

function AuthPage({ onAuthenticated, notice = '' }) {
  const [register, setRegister] = useState(false)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(null)
  useEffect(() => () => pending.current?.abort(), [])

  function switchMode() {
    setRegister(current => !current)
    setError('')
    setSuccess('')
    setPassword('')
    setConfirmPassword('')
    setShowPassword(false)
  }

  async function submit(event) {
    event.preventDefault()
    if (pending.current) return
    if (register && password !== confirmPassword) {
      setError('Hai mật khẩu chưa khớp.')
      return
    }
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setError('')
    setSuccess('')
    try {
      if (register) {
        await authApi.register({ username: username.trim(), displayName: displayName.trim(), password }, controller.signal)
        setRegister(false)
        setUsername(username.trim().toLowerCase())
        setPassword('')
        setConfirmPassword('')
        setSuccess('Tạo tài khoản thành công. Bạn đăng nhập để tiếp tục nhé.')
      } else {
        const session = await authApi.login({ username: username.trim(), password }, controller.signal)
        session.user = await authApi.getMe(session.accessToken, controller.signal)
        onAuthenticated(session)
      }
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message)
    } finally {
      pending.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return (
    <section className="login-screen">
      <div className="login-left">
        <div className="brand"><span className="brand-logo">N</span><span className="brand-name">Nối<span className="brand-dot">.</span></span></div>
        <div className="login-hero">
          <h1>Giữ liên lạc.<br />Cùng nhau kết nối.</h1>
          <p>Nhắn tin thời gian thực và truyền tệp dung lượng lớn trực tiếp P2P.</p>
          <div className="login-features">
            <span className="login-feature-pill"><Icon name="activity" size="ico-sm" />P2P trực tiếp</span>
            <span className="login-feature-pill"><Icon name="folder" size="ico-sm" />Tệp lớn tới 10 GB</span>
            <span className="login-feature-pill"><Icon name="shield" size="ico-sm" />Toàn vẹn SHA-256</span>
          </div>
          <div className="login-bubbles">
            <div className="mini-bubble in">Chiều nay mình cùng xem lại đồ án nhé?</div>
            <div className="mini-bubble out">Oke, 14h nha!</div>
            <div className="mini-bubble in">Mình gửi bản dựng qua P2P luôn đây.</div>
          </div>
        </div>
        <div className="login-foot-left">PBL4 - Hệ thống trao đổi thông tin thời gian thực</div>
      </div>
      <div className="login-right">
        <div className="login-form-box">
          <h2>{register ? 'Tạo tài khoản' : 'Chào mừng trở lại'}</h2>
          <p>{register ? 'Bắt đầu kết nối với nhóm của bạn.' : 'Đăng nhập để tiếp tục trò chuyện.'}</p>
          {(success || notice) && <p className="auth-notice" role="status">{success || notice}</p>}
          <form onSubmit={submit} aria-busy={busy}>
            <fieldset className="auth-fields" disabled={busy}>
              {register && <div className="form-field">
                <label htmlFor="auth-name">Họ và tên</label>
                <input id="auth-name" name="displayName" autoComplete="name" value={displayName} onChange={e => setDisplayName(e.target.value)} maxLength={100} required />
              </div>}
              <div className="form-field">
                <label htmlFor="auth-user">Tên đăng nhập</label>
                <input id="auth-user" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false}
                  value={username} onChange={e => setUsername(e.target.value)} minLength={register ? 3 : undefined} maxLength={32}
                  pattern={register ? '[a-zA-Z0-9_.]+' : undefined} required aria-describedby={register ? 'username-help' : undefined} />
                {register && <small id="username-help">3–32 ký tự: chữ không dấu, số, dấu chấm hoặc gạch dưới.</small>}
              </div>
              <div className="form-field">
                <label htmlFor="auth-password">Mật khẩu</label>
                <div className="password-input-wrap">
                  <input id="auth-password" name="password" type={showPassword ? 'text' : 'password'}
                    autoComplete={register ? 'new-password' : 'current-password'}
                    value={password} onChange={e => setPassword(e.target.value)} minLength={register ? 12 : undefined}
                    maxLength={128} required aria-describedby={register ? 'password-help' : undefined} />
                  <button className="password-toggle-btn" type="button"
                    onClick={() => setShowPassword(value => !value)}
                    aria-label={showPassword ? 'Ẩn ký tự' : 'Hiện ký tự'}
                    aria-pressed={showPassword}>
                    <Icon name="eye" size="ico-sm" />
                  </button>
                </div>
                {register && <small id="password-help">12–128 ký tự. Có thể dùng khoảng trắng.</small>}
              </div>
              {register && <div className="form-field">
                <label htmlFor="auth-confirm">Nhập lại mật khẩu</label>
                <input id="auth-confirm" name="confirmPassword" type="password" autoComplete="new-password"
                  value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} maxLength={128} required />
              </div>}
              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="btn btn--primary" type="submit">{busy ? 'Đang xử lý…' : register ? 'Tạo tài khoản' : 'Đăng nhập'}</button>
            </fieldset>
          </form>
          <div className="login-switch">
            {register ? 'Đã có tài khoản?' : 'Chưa có tài khoản?'}{' '}
            <button type="button" disabled={busy} onClick={switchMode}>{register ? 'Đăng nhập' : 'Đăng ký'}</button>
          </div>
        </div>
      </div>
    </section>
  )
}

export default AuthPage

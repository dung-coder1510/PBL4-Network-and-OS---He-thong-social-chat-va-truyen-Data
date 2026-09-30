import { useCallback, useEffect, useState } from 'react'
import AppShell from './components/layout/AppShell.jsx'
import AuthPage from './pages/AuthPage.jsx'
import EmptyWorkspacePage from './pages/EmptyWorkspacePage.jsx'
import SettingsPage from './pages/SettingsPage.jsx'
import ChatPage from './pages/ChatPage.jsx'
import ContactsPage from './pages/ContactsPage.jsx'
import { authApi } from './services/authApi.js'
import './styles/app.css'

const PAGES = new Set(['chat', 'contacts', 'calls', 'files', 'admin', 'settings'])

function App() {
  const [page, setPage] = useState('chat')
  const [theme, setTheme] = useState(() => localStorage.getItem('pbl4-theme') || 'light')
  const [session, setSession] = useState(null)
  const [notice, setNotice] = useState('')
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const [openConversationId, setOpenConversationId] = useState(null)
  const sessionExpired = useCallback(() => {
    setSession(null)
    setNotice('Phiên đăng nhập đã hết hạn hoặc bị thu hồi. Bạn đăng nhập lại nhé.')
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('pbl4-theme', theme)
  }, [theme])

  useEffect(() => {
    const onHashChange = () => {
      const nextPage = window.location.hash.slice(1)
      if (PAGES.has(nextPage)) setPage(nextPage)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    if (!session) return undefined
    let active = true
    const controller = new AbortController()
    const expire = () => {
      if (!active) return
      setSession(null)
      setNotice('Phiên đăng nhập đã hết hạn hoặc bị thu hồi. Bạn đăng nhập lại nhé.')
    }
    const timer = setTimeout(expire, Math.max(0, Date.parse(session.expiresAt) - Date.now()))
    const verify = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const user = await authApi.getMe(session.accessToken, controller.signal)
        if (active && JSON.stringify(user) !== JSON.stringify(session.user)) {
          setSession(current => current?.sessionId === session.sessionId ? { ...current, user } : current)
        }
      } catch (error) {
        if (error.status === 401 || error.status === 403) expire()
        // Mất mạng tạm thời không giả định token đã bị thu hồi.
      }
    }
    const poll = setInterval(verify, 60000)
    window.addEventListener('focus', verify)
    return () => {
      active = false
      controller.abort()
      clearTimeout(timer)
      clearInterval(poll)
      window.removeEventListener('focus', verify)
    }
  }, [session])

  function navigate(nextPage) {
    setPage(nextPage)
    window.location.hash = nextPage
  }

  function authenticated(nextSession) {
    setSession(nextSession)
    setNotice('')
    setLogoutError('')
    navigate('chat')
  }

  async function logout() {
    if (loggingOut) return
    setLoggingOut(true)
    setLogoutError('')
    try {
      await authApi.logout(session.accessToken)
      setSession(null)
      setNotice('Bạn đã đăng xuất.')
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        setSession(null)
        setNotice('Phiên đăng nhập đã kết thúc.')
      } else {
        // Giữ phiên để người dùng retry thu hồi, không báo đã thu hồi khi server chưa xử lý.
        setLogoutError('Chưa đăng xuất được trên máy chủ. Vui lòng thử lại.')
      }
    } finally {
      setLoggingOut(false)
    }
  }

  if (!session) return <AuthPage onAuthenticated={authenticated} notice={notice} />

  const visiblePage = page === 'admin' && session.user.role !== 'Admin' ? 'chat' : page
  return (
    <AppShell currentPage={visiblePage} onLogout={logout} onNavigate={navigate} user={session.user} loggingOut={loggingOut}>
      {logoutError && <p className="auth-workspace-error" role="alert">{logoutError}</p>}
      {visiblePage === 'settings'
        ? <SettingsPage onThemeChange={setTheme} theme={theme} user={session.user} />
        : visiblePage === 'contacts'
        ? <ContactsPage token={session.accessToken} userId={session.user.id}
            onSessionExpired={sessionExpired}
            onOpenConversation={conversationId => {
              setOpenConversationId(conversationId)
              navigate('chat')
            }} />
        : visiblePage === 'chat'
        ? <ChatPage key={session.sessionId} token={session.accessToken} user={session.user}
            initialConversationId={openConversationId}
            onInitialConversationHandled={() => setOpenConversationId(null)}
            onSessionExpired={sessionExpired} />
        : <EmptyWorkspacePage page={visiblePage} user={session.user} />}
    </AppShell>
  )
}

export default App

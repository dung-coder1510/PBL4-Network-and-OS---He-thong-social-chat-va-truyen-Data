import { useCallback, useEffect, useRef, useState } from 'react'
import AppShell from './components/layout/AppShell.jsx'
import AuthPage from './pages/AuthPage.jsx'
import EmptyWorkspacePage from './pages/EmptyWorkspacePage.jsx'
import SettingsPage from './pages/SettingsPage.jsx'
import ChatPage from './pages/ChatPage.jsx'
import ContactsPage from './pages/ContactsPage.jsx'
import { authApi } from './services/authApi.js'
import { MAX_FILE_CHANNELS } from './services/fileProtocol.js'
import { RELAY_CONNECTION_COUNTS } from './services/fileRelayProtocol.js'
import { ChatRealtimeProvider } from './realtime/ChatRealtimeProvider.jsx'
import { FileTransferProvider } from './realtime/FileTransferProvider.jsx'
import FilesPage from './pages/FilesPage.jsx'
import AdminPage from './pages/AdminPage.jsx'
import './styles/app.css'

const PAGES = new Set(['chat', 'contacts', 'calls', 'files', 'admin', 'settings'])
const DEVELOPER_SETTINGS_KEY = 'pbl4-developer-settings'

function readDeveloperSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEVELOPER_SETTINGS_KEY))
    const count = saved?.fileChannelCount
    const keepSavedRelay = RELAY_CONNECTION_COUNTS.includes(saved?.relayConnectionCount) &&
      (!Object.hasOwn(saved ?? {}, 'allowTurnForFiles') || saved?.relayConfigured === true)
    return { enabled: saved?.enabled === true,
      fileChannelCount: Number.isInteger(count) && count >= 1 && count <= MAX_FILE_CHANNELS ? count : 1,
      parallelFileConnections: saved?.parallelFileConnections === true,
      allowTurnForFiles: saved?.allowTurnForFiles === true,
      relayConfigured: saved?.relayConfigured === true,
      relayConnectionCount: keepSavedRelay ? saved.relayConnectionCount : 4 }
  } catch {
    return { enabled: false, fileChannelCount: 1, parallelFileConnections: false,
      allowTurnForFiles: false, relayConfigured: false, relayConnectionCount: 4 }
  }
}

function App() {
  const [page, setPage] = useState('chat')
  const [theme, setTheme] = useState(() => localStorage.getItem('pbl4-theme') || 'light')
  const [developerSettings, setDeveloperSettings] = useState(readDeveloperSettings)
  const [session, setSession] = useState(null)
  const [notice, setNotice] = useState('')
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const [openConversationId, setOpenConversationId] = useState(null)
  const relayActive = useRef(false)
  const expiryPending = useRef(false)
  const sessionExpired = useCallback(() => {
    if (relayActive.current) {
      expiryPending.current = true
      return
    }
    expiryPending.current = false
    setSession(null)
    setNotice('Phiên đăng nhập đã hết hạn hoặc bị thu hồi. Bạn đăng nhập lại nhé.')
  }, [])
  const relayActivity = useCallback(active => {
    relayActive.current = active
    if (!active && expiryPending.current) sessionExpired()
  }, [sessionExpired])
  const adminAccessLost = useCallback(async () => {
    if (!session) return
    try {
      const user = await authApi.getMe(session.accessToken)
      setSession(current => current?.sessionId === session.sessionId ? { ...current, user } : current)
      if (user.role !== 'Admin') { setPage('chat'); window.location.hash = 'chat' }
    } catch (error) {
      if (error.status === 401) sessionExpired()
    }
  }, [session, sessionExpired])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('pbl4-theme', theme)
  }, [theme])

  useEffect(() => {
    localStorage.setItem(DEVELOPER_SETTINGS_KEY, JSON.stringify(developerSettings))
  }, [developerSettings])

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
      sessionExpired()
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
  }, [session, sessionExpired])

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
    <ChatRealtimeProvider key={session.sessionId} token={session.accessToken}
      user={session.user} onSessionExpired={sessionExpired}>
      <FileTransferProvider token={session.accessToken} user={session.user} developerMode={developerSettings.enabled}
        onRelayActivity={relayActivity}
        preferredChannelCount={developerSettings.enabled ? developerSettings.fileChannelCount : null}
        relayConnectionCount={developerSettings.enabled ? developerSettings.relayConnectionCount : null}
        parallelFileConnections={developerSettings.enabled ? developerSettings.parallelFileConnections : null}
        allowTurnForFiles={developerSettings.enabled ? developerSettings.allowTurnForFiles : false}>
      <AppShell currentPage={visiblePage} onLogout={logout} onNavigate={navigate} user={session.user} loggingOut={loggingOut}>
        {logoutError && <p className="auth-workspace-error" role="alert">{logoutError}</p>}
        {visiblePage === 'settings'
          ? <SettingsPage onThemeChange={setTheme} theme={theme} user={session.user} token={session.accessToken}
              developerSettings={developerSettings} onDeveloperSettingsChange={setDeveloperSettings} />
          : visiblePage === 'contacts'
          ? <ContactsPage token={session.accessToken}
              onSessionExpired={sessionExpired}
              onOpenConversation={conversationId => {
                setOpenConversationId(conversationId)
                navigate('chat')
              }} />
          : visiblePage === 'chat'
          ? <ChatPage token={session.accessToken} user={session.user}
              initialConversationId={openConversationId}
              onInitialConversationHandled={() => setOpenConversationId(null)}
              onSessionExpired={sessionExpired} />
          : visiblePage === 'files'
          ? <FilesPage token={session.accessToken} user={session.user} onSessionExpired={sessionExpired} />
          : visiblePage === 'admin'
          ? <AdminPage token={session.accessToken} onSessionExpired={sessionExpired} onAccessLost={adminAccessLost} />
          : <EmptyWorkspacePage page={visiblePage} user={session.user} />}
      </AppShell>
      </FileTransferProvider>
    </ChatRealtimeProvider>
  )
}

export default App

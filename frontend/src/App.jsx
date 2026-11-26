import { useCallback, useEffect, useRef, useState } from 'react'
import AppShell from './components/layout/AppShell.jsx'
import AuthPage from './pages/AuthPage.jsx'
import EmptyWorkspacePage from './pages/EmptyWorkspacePage.jsx'
import SettingsPage from './pages/SettingsPage.jsx'
import ChatPage from './pages/ChatPage.jsx'
import ContactsPage from './pages/ContactsPage.jsx'
import { authApi } from './services/authApi.js'
import { MAX_FILE_CHANNELS, PARALLEL_CONNECTION_COUNT, V7_CONNECTION_COUNTS } from './services/fileProtocol.js'
import { RELAY_CONNECTION_COUNTS } from './services/fileRelayProtocol.js'
import { ChatRealtimeProvider } from './realtime/ChatRealtimeProvider.jsx'
import { FileTransferProvider } from './realtime/FileTransferProvider.jsx'
import { NotificationProvider } from './realtime/NotificationProvider.jsx'
import { NOTIFICATION_SETTINGS_KEY, readNotificationSettings } from './utils/notificationState.js'
import FilesPage from './pages/FilesPage.jsx'
import AdminPage from './pages/AdminPage.jsx'
import './styles/app.css'

const PAGES = new Set(['chat', 'contacts', 'calls', 'files', 'admin', 'settings'])
const DEVELOPER_SETTINGS_KEY = 'pbl4-developer-settings'
const UI_SETTINGS_KEY = 'pbl4-ui-settings'

function readUiSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_SETTINGS_KEY))
    return {
      compactMode: saved?.compactMode === true,
      sendWithEnter: saved?.sendWithEnter !== false,
    }
  } catch {
    return { compactMode: false, sendWithEnter: true }
  }
}

function readDeveloperSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEVELOPER_SETTINGS_KEY))
    const count = saved?.fileChannelCount
    const keepSavedRelay = RELAY_CONNECTION_COUNTS.includes(saved?.relayConnectionCount) &&
      (!Object.hasOwn(saved ?? {}, 'allowTurnForFiles') || saved?.relayConfigured === true)
    return { enabled: saved?.enabled === true,
      fileChannelCount: Number.isInteger(count) && count >= 1 && count <= MAX_FILE_CHANNELS ? count : 1,
      parallelFileConnections: saved?.parallelFileConnections === true,
      webrtcConnectionCount: V7_CONNECTION_COUNTS.includes(saved?.webrtcConnectionCount)
        ? saved.webrtcConnectionCount : PARALLEL_CONNECTION_COUNT,
      allowTurnForFiles: saved?.allowTurnForFiles === true,
      relayConfigured: saved?.relayConfigured === true,
      relayConnectionCount: keepSavedRelay ? saved.relayConnectionCount : 4 }
  } catch {
    return { enabled: false, fileChannelCount: 1, parallelFileConnections: false,
      webrtcConnectionCount: PARALLEL_CONNECTION_COUNT,
      allowTurnForFiles: false, relayConfigured: false, relayConnectionCount: 4 }
  }
}

function readInitialPage() {
  const hashPage = window.location.hash.slice(1)
  return PAGES.has(hashPage) ? hashPage : 'chat'
}

function App() {
  const [page, setPage] = useState(readInitialPage)
  const [theme, setTheme] = useState(() => localStorage.getItem('pbl4-theme') || 'light')
  const [uiSettings, setUiSettings] = useState(readUiSettings)
  const [notificationSettings, setNotificationSettings] = useState(readNotificationSettings)
  const [developerSettings, setDeveloperSettings] = useState(readDeveloperSettings)
  const [session, setSession] = useState(null)
  const [restoringSession, setRestoringSession] = useState(true)
  const [notice, setNotice] = useState('')
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const [openConversationId, setOpenConversationId] = useState(null)
  const relayActive = useRef(false)
  const expiryPending = useRef(false)
  const refreshingRef = useRef(null)
  const forceLogout = useCallback((message = 'Phiên đăng nhập đã hết hạn hoặc bị thu hồi. Bạn đăng nhập lại nhé.') => {
    if (relayActive.current) {
      expiryPending.current = true
      return
    }
    expiryPending.current = false
    setSession(null)
    setNotice(message)
  }, [])
  const refreshSession = useCallback(async signal => {
    if (refreshingRef.current) return refreshingRef.current
    const pending = authApi.refresh(signal)
      .then(next => {
        setSession(current => current ? { ...current, ...next } : next)
        return next
      })
      .finally(() => {
        if (refreshingRef.current === pending) refreshingRef.current = null
      })
    refreshingRef.current = pending
    return pending
  }, [])
  const handleAuthError = useCallback(async () => {
    try {
      await refreshSession()
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) forceLogout()
    }
  }, [refreshSession, forceLogout])
  const relayActivity = useCallback(active => {
    relayActive.current = active
    if (!active && expiryPending.current) forceLogout()
  }, [forceLogout])
  const adminAccessLost = useCallback(async () => {
    if (!session) return
    try {
      const user = await authApi.getMe(session.accessToken)
      setSession(current => current?.sessionId === session.sessionId ? { ...current, user } : current)
      if (user.role !== 'Admin') { setPage('chat'); window.location.hash = 'chat' }
    } catch (error) {
      if (error.status === 401) await handleAuthError()
      else if (error.status === 403) forceLogout()
    }
  }, [session, handleAuthError, forceLogout])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('pbl4-theme', theme)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#18191A' : '#FFFFFF')
  }, [theme])

  useEffect(() => {
    document.documentElement.dataset.compact = uiSettings.compactMode ? 'true' : 'false'
    localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(uiSettings))
  }, [uiSettings])

  useEffect(() => {
    localStorage.setItem(DEVELOPER_SETTINGS_KEY, JSON.stringify(developerSettings))
  }, [developerSettings])

  useEffect(() => {
    localStorage.setItem(NOTIFICATION_SETTINGS_KEY, JSON.stringify(notificationSettings))
  }, [notificationSettings])

  const openConversation = useCallback(conversationId => {
    setOpenConversationId(conversationId)
    setPage('chat')
    window.location.hash = 'chat'
  }, [])

  const openFiles = useCallback(() => {
    setPage('files')
    window.location.hash = 'files'
  }, [])

  useEffect(() => {
    const onHashChange = () => {
      const nextPage = window.location.hash.slice(1)
      if (PAGES.has(nextPage)) setPage(nextPage)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    refreshSession(controller.signal)
      .catch(() => {})
      .finally(() => {
        if (active) setRestoringSession(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [refreshSession])

  useEffect(() => {
    if (!session) return undefined
    let active = true
    const controller = new AbortController()
    let retryTimer = null

    const runProactiveRefresh = async () => {
      if (!active) return
      try {
        await refreshSession(controller.signal)
      } catch (error) {
        if (!active || error?.name === 'AbortError') return
        if (error?.status === 401 || error?.status === 403) forceLogout()
        else {
          clearTimeout(retryTimer)
          retryTimer = setTimeout(runProactiveRefresh, 15000)
        }
      }
    }

    const msUntilRefresh = Math.max(5000, Date.parse(session.expiresAt) - Date.now() - 3 * 60 * 1000)
    const refreshTimer = setTimeout(runProactiveRefresh, msUntilRefresh)

    const verify = async () => {
      if (!active || document.visibilityState !== 'visible') return
      if (Date.parse(session.expiresAt) - Date.now() < 5 * 60 * 1000) {
        await runProactiveRefresh()
        return
      }
      try {
        const user = await authApi.getMe(session.accessToken, controller.signal)
        if (active && JSON.stringify(user) !== JSON.stringify(session.user)) {
          setSession(current => current?.sessionId === session.sessionId ? { ...current, user } : current)
        }
      } catch (error) {
        if (!active || error?.name === 'AbortError') return
        if (error.status === 401) await handleAuthError()
        else if (error.status === 403) forceLogout()
        // Mất mạng tạm thời không giả định token đã bị thu hồi.
      }
    }
    const poll = setInterval(verify, 60000)
    window.addEventListener('focus', verify)
    document.addEventListener('visibilitychange', verify)
    window.addEventListener('online', verify)
    return () => {
      active = false
      controller.abort()
      clearTimeout(refreshTimer)
      clearTimeout(retryTimer)
      clearInterval(poll)
      window.removeEventListener('focus', verify)
      document.removeEventListener('visibilitychange', verify)
      window.removeEventListener('online', verify)
    }
  }, [session, refreshSession, forceLogout, handleAuthError])

  function navigate(nextPage) {
    setPage(nextPage)
    window.location.hash = nextPage
  }

  function authenticated(nextSession) {
    const hashPage = window.location.hash.slice(1)
    setSession(nextSession)
    setNotice('')
    setLogoutError('')
    navigate(PAGES.has(hashPage) ? hashPage : 'chat')
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

  if (restoringSession && !session) {
    return (
      <main className="auth-shell">
        <p className="muted">Đang khôi phục phiên đăng nhập...</p>
      </main>
    )
  }

  if (!session) return <AuthPage onAuthenticated={authenticated} notice={notice} />

  const visiblePage = page === 'admin' && session.user.role !== 'Admin' ? 'chat' : page
  return (
    <ChatRealtimeProvider key={session.sessionId} token={session.accessToken}
      user={session.user} onSessionExpired={handleAuthError}>
      <NotificationProvider token={session.accessToken} user={session.user} currentPage={visiblePage}
        settings={notificationSettings} onOpenConversation={openConversation}
        onOpenFiles={openFiles} onSessionExpired={handleAuthError}>
      <FileTransferProvider token={session.accessToken} user={session.user} developerMode={developerSettings.enabled}
        onRelayActivity={relayActivity}
        preferredChannelCount={developerSettings.enabled ? developerSettings.fileChannelCount : null}
        relayConnectionCount={developerSettings.enabled ? developerSettings.relayConnectionCount : null}
        parallelFileConnections={developerSettings.enabled ? developerSettings.parallelFileConnections : null}
        webrtcConnectionCount={developerSettings.enabled && developerSettings.parallelFileConnections
          ? developerSettings.webrtcConnectionCount : null}
        allowTurnForFiles={developerSettings.enabled ? developerSettings.allowTurnForFiles : false}>
      <AppShell currentPage={visiblePage} onLogout={logout} onNavigate={navigate} user={session.user} loggingOut={loggingOut}
        theme={theme} onThemeChange={setTheme}>
        {logoutError && <p className="auth-workspace-error" role="alert">{logoutError}</p>}
        {visiblePage === 'settings'
          ? <SettingsPage onThemeChange={setTheme} theme={theme} user={session.user} token={session.accessToken}
              uiSettings={uiSettings} onUiSettingsChange={setUiSettings}
              notificationSettings={notificationSettings} onNotificationSettingsChange={setNotificationSettings}
              developerSettings={developerSettings} onDeveloperSettingsChange={setDeveloperSettings} />
          : visiblePage === 'contacts'
          ? <ContactsPage token={session.accessToken}
              onSessionExpired={handleAuthError}
              onOpenConversation={openConversation} />
          : visiblePage === 'chat'
          ? <ChatPage token={session.accessToken} user={session.user}
              sendWithEnter={uiSettings.sendWithEnter}
              initialConversationId={openConversationId}
              onInitialConversationHandled={() => setOpenConversationId(null)}
              onSessionExpired={handleAuthError} />
          : visiblePage === 'files'
          ? <FilesPage token={session.accessToken} user={session.user} onSessionExpired={handleAuthError}
              onOpenConversation={openConversation}
              onOpenContacts={() => navigate('contacts')} />
          : visiblePage === 'admin'
          ? <AdminPage token={session.accessToken} onSessionExpired={handleAuthError} onAccessLost={adminAccessLost} />
          : <EmptyWorkspacePage page={visiblePage} user={session.user} />}
      </AppShell>
      </FileTransferProvider>
      </NotificationProvider>
    </ChatRealtimeProvider>
  )
}

export default App

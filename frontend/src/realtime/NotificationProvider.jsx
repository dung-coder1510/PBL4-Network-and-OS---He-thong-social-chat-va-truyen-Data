import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Avatar from '../components/Avatar.jsx'
import Icon from '../components/Icon.jsx'
import { conversationsApi } from '../services/conversationsApi.js'
import { listenForMessageStatuses } from '../services/chatConnection.js'
import { useChatRealtime } from './chatRealtimeContext.js'
import { NotificationContext } from './notificationContext.js'
import { formatUserError } from '../utils/errorMessage.js'
import { playNotificationSound } from '../utils/notificationSound.js'
import {
  BASE_DOCUMENT_TITLE,
  formatDocumentTitle,
  shouldNotifyIncomingMessage,
  sumUnreadCounts,
  truncatePreview,
} from '../utils/notificationState.js'

const MAX_TOASTS = 3
const MAX_SEEN_KEYS = 300

function fireDesktopNotification(title, body, tag, onSelect) {
  try {
    if (typeof globalThis.Notification !== 'function') return
    if (globalThis.Notification.permission !== 'granted') return
    const notification = new globalThis.Notification(title, { body, tag })
    notification.onclick = () => {
      try { window.focus() } catch {}
      notification.close()
      onSelect?.()
    }
  } catch {
    // Bỏ qua nếu trình duyệt/headless không cho tạo Notification.
  }
}

/** Quản lý toast trong ứng dụng, badge chưa đọc, âm báo, tiêu đề tab và Desktop Notification. */
export function NotificationProvider({
  token,
  user,
  currentPage,
  settings,
  onOpenConversation,
  onOpenFiles,
  onSessionExpired,
  children,
}) {
  const { connection, connectionState, initialSyncDone, subscribeMessages, subscribeSync } = useChatRealtime()
  const [unreadByConv, setUnreadByConv] = useState({})
  const [pendingFileCount, setPendingFileCount] = useState(0)
  const [toasts, setToasts] = useState([])
  const [syncVersion, setSyncVersion] = useState(0)

  const peerCacheRef = useRef(new Map())
  const seenKeysRef = useRef(new Set())
  const timersRef = useRef(new Map())
  const toastSeqRef = useRef(0)
  const activeChatRef = useRef({ conversationId: null, threadVisible: false })
  const latestRef = useRef({ currentPage, settings, initialSyncDone, onOpenConversation, onOpenFiles, token, onSessionExpired })

  useEffect(() => {
    latestRef.current = { currentPage, settings, initialSyncDone, onOpenConversation, onOpenFiles, token, onSessionExpired }
  }, [currentPage, settings, initialSyncDone, onOpenConversation, onOpenFiles, token, onSessionExpired])

  const dismissToast = useCallback(id => {
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
    setToasts(current => current.filter(item => item.id !== id))
  }, [])

  const scheduleToastTimer = useCallback((id, durationMs = 5000) => {
    const existing = timersRef.current.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      timersRef.current.delete(id)
      setToasts(current => current.filter(item => item.id !== id))
    }, durationMs)
    timersRef.current.set(id, timer)
  }, [])

  const pauseToastTimer = useCallback(id => {
    const existing = timersRef.current.get(id)
    if (existing) {
      clearTimeout(existing)
      timersRef.current.delete(id)
    }
  }, [])

  const enqueueToast = useCallback(toast => {
    const id = ++toastSeqRef.current
    const entry = { ...toast, id }
    setToasts(current => {
      const next = [...current, entry]
      if (next.length > MAX_TOASTS) {
        const dropped = next.shift()
        const oldTimer = timersRef.current.get(dropped.id)
        if (oldTimer) {
          clearTimeout(oldTimer)
          timersRef.current.delete(dropped.id)
        }
      }
      return next
    })
    scheduleToastTimer(id, toast.durationMs ?? 5000)
    return id
  }, [scheduleToastTimer])

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const resolvePeer = useCallback(async conversationId => {
    if (!conversationId) return null
    const cached = peerCacheRef.current.get(conversationId)
    if (cached) return cached
    try {
      const detail = await conversationsApi.get(latestRef.current.token, conversationId)
      if (detail?.peer) {
        const person = { id: detail.peer.id, name: detail.peer.displayName, username: detail.peer.username }
        peerCacheRef.current.set(conversationId, person)
        return person
      }
    } catch {
      // Giữ fallback tiêu đề chung nếu chưa tải được tên người gửi.
    }
    return null
  }, [])

  const syncConversations = useCallback(items => {
    if (!Array.isArray(items) || items.length === 0) return
    for (const item of items) {
      if (item?.peer) {
        peerCacheRef.current.set(item.id, {
          id: item.peer.id, name: item.peer.displayName, username: item.peer.username,
        })
      }
    }
    setUnreadByConv(current => {
      let changed = false
      const next = { ...current }
      const { conversationId: activeId, threadVisible } = activeChatRef.current
      const readingVisible = latestRef.current.currentPage === 'chat' &&
        threadVisible && document.visibilityState === 'visible'
      for (const item of items) {
        const targetCount = readingVisible && activeId === item.id ? 0 : (item.unreadCount || 0)
        if ((next[item.id] || 0) !== targetCount) {
          next[item.id] = targetCount
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [])

  const setActiveChat = useCallback(({ conversationId, threadVisible }) => {
    activeChatRef.current = { conversationId: conversationId || null, threadVisible: Boolean(threadVisible) }
    if (conversationId && threadVisible && document.visibilityState === 'visible') {
      setUnreadByConv(current => (current[conversationId] ? { ...current, [conversationId]: 0 } : current))
    }
  }, [])

  // Nạp lại bộ đếm chưa đọc + tên peer từ DB khi đăng nhập, hoàn tất sync đầu hoặc SignalR báo thay đổi.
  useEffect(() => subscribeSync(() => setSyncVersion(value => value + 1)), [subscribeSync])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    async function loadSummary() {
      const allItems = []
      let cursor = null
      let pages = 0
      do {
        const page = await conversationsApi.list(latestRef.current.token, { cursor }, controller.signal)
        allItems.push(...page.items)
        cursor = page.nextCursor
        pages++
      } while (cursor && pages < 10)
      if (!active || controller.signal.aborted) return

      const nextUnread = {}
      const { conversationId: activeId, threadVisible } = activeChatRef.current
      const readingVisible = latestRef.current.currentPage === 'chat' &&
        threadVisible && document.visibilityState === 'visible'
      for (const item of allItems) {
        if (item.peer) {
          peerCacheRef.current.set(item.id, {
            id: item.peer.id, name: item.peer.displayName, username: item.peer.username,
          })
        }
        nextUnread[item.id] = readingVisible && activeId === item.id ? 0 : (item.unreadCount || 0)
      }
      setUnreadByConv(nextUnread)
    }
    loadSummary().catch(failure => {
      if (!active || failure.name === 'AbortError') return
      if (failure.status === 401 || failure.status === 403) onSessionExpired?.()
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [connectionState, initialSyncDone, syncVersion, onSessionExpired])

  // Cập nhật unread khi backend gửi biên nhận đã đọc.
  useEffect(() => {
    if (!connection) return undefined
    return listenForMessageStatuses(connection, status => {
      if (!status.readAt || status.recipientUserId !== user.id) return
      setUnreadByConv(current => {
        const nextCount = status.unreadCount ?? (status.messageId ? (current[status.conversationId] || 0) : 0)
        if ((current[status.conversationId] || 0) === nextCount) return current
        return { ...current, [status.conversationId]: nextCount }
      })
    })
  }, [connection, user.id])

  // Lắng nghe tin nhắn đến toàn cục để phát toast, âm báo, unread badge và Desktop Notification.
  useEffect(() => {
    return subscribeMessages(async message => {
      if (!message) return
      const key = `${message.senderId}:${message.clientMessageId || message.id}`
      if (seenKeysRef.current.has(key)) return
      seenKeysRef.current.add(key)
      if (seenKeysRef.current.size > MAX_SEEN_KEYS) {
        const oldest = seenKeysRef.current.values().next().value
        seenKeysRef.current.delete(oldest)
      }

      const {
        currentPage: page,
        settings: currentSettings,
        initialSyncDone: synced,
        onOpenConversation: openConversation,
      } = latestRef.current

      const decision = shouldNotifyIncomingMessage({
        message,
        currentUserId: user.id,
        currentPage: page,
        activeChat: activeChatRef.current,
        isVisible: document.visibilityState === 'visible',
        hasFocus: document.hasFocus(),
        initialSyncDone: synced,
        settings: currentSettings,
      })

      if (decision.incrementUnread && synced) {
        setUnreadByConv(current => ({
          ...current,
          [message.conversationId]: (current[message.conversationId] || 0) + 1,
        }))
      }

      if (!decision.showInApp && !decision.playSound && !decision.showDesktop) return

      const peer = await resolvePeer(message.conversationId)
      const title = peer?.name || 'Tin nhắn mới'
      const preview = truncatePreview(message.content || 'Tin nhắn mới')

      if (decision.playSound) playNotificationSound('message')
      if (decision.showInApp) {
        enqueueToast({
          kind: 'message',
          title,
          body: preview,
          avatarPerson: peer,
          conversationId: message.conversationId,
          target: 'chat',
          durationMs: 5000,
        })
      }
      if (decision.showDesktop) {
        fireDesktopNotification(title, preview, `pbl4-msg-${message.conversationId}`, () => {
          openConversation?.(message.conversationId)
        })
      }
    })
  }, [subscribeMessages, user.id, resolvePeer, enqueueToast])

  // Thông báo sự kiện tệp (lời mời đến, lưu tệp xong, lỗi).
  const notifyFile = useCallback(async (message, meta = {}) => {
    if (!message) return
    const kind = meta.kind || 'file-info'
    const body = kind === 'file-error' ? formatUserError(message, message) : message
    const currentSettings = latestRef.current.settings
    const isError = kind === 'file-error'

    let peer = null
    if (kind === 'file-offer' && meta.conversationId) {
      peer = await resolvePeer(meta.conversationId)
    }

    const title = kind === 'file-offer'
      ? (peer ? `${peer.name} gửi tệp` : 'Lời mời nhận tệp')
      : kind === 'file-saved'
        ? 'Đã lưu tệp'
        : 'Thông báo tệp'

    const target = kind === 'file-offer' && meta.conversationId ? 'chat' : 'files'

    if (currentSettings?.inAppEnabled) {
      enqueueToast({
        kind,
        title,
        body,
        avatarPerson: peer,
        conversationId: meta.conversationId || null,
        target,
        durationMs: kind === 'file-offer' ? 8000 : 5000,
      })
    }
    if (currentSettings?.soundEnabled && !isError) {
      playNotificationSound('file')
    }
    const isHidden = document.visibilityState !== 'visible' || !document.hasFocus()
    if (currentSettings?.desktopEnabled && isHidden && !isError) {
      fireDesktopNotification(title, body, `pbl4-file-${meta.transferId || 'notice'}`, () => {
        if (target === 'chat' && meta.conversationId) latestRef.current.onOpenConversation?.(meta.conversationId)
        else latestRef.current.onOpenFiles?.()
      })
    }
  }, [enqueueToast, resolvePeer])

  const sendTest = useCallback(() => {
    const currentSettings = latestRef.current.settings
    const title = 'Thông báo thử nghiệm'
    const body = 'Hệ thống thông báo của Nối đang hoạt động tốt.'
    enqueueToast({ kind: 'test', title, body, avatarPerson: null, conversationId: null, target: 'close', durationMs: 4500 })
    if (currentSettings?.soundEnabled) playNotificationSound('message')
    if (currentSettings?.desktopEnabled) fireDesktopNotification(title, body, 'pbl4-test')
  }, [enqueueToast])

  const totalUnreadMessages = useMemo(() => sumUnreadCounts(unreadByConv), [unreadByConv])

  useEffect(() => {
    document.title = formatDocumentTitle(totalUnreadMessages + pendingFileCount, BASE_DOCUMENT_TITLE)
    return () => { document.title = BASE_DOCUMENT_TITLE }
  }, [totalUnreadMessages, pendingFileCount])

  const contextValue = useMemo(() => ({
    totalUnreadMessages,
    pendingFileCount,
    setPendingFileCount,
    setActiveChat,
    syncConversations,
    notifyFile,
    sendTest,
  }), [totalUnreadMessages, pendingFileCount, setActiveChat, syncConversations, notifyFile, sendTest])

  function handleToastClick(toast) {
    dismissToast(toast.id)
    if (toast.target === 'chat' && toast.conversationId) onOpenConversation?.(toast.conversationId)
    else if (toast.target === 'files') onOpenFiles?.()
  }

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
      {toasts.length > 0 && (
        <div
          className={`app-toast-stack${currentPage === 'chat' ? ' is-chat' : ''}`}
          aria-live="polite"
          aria-relevant="additions"
        >
          {toasts.map(toast => {
            const isFile = toast.kind === 'file-offer' || toast.kind === 'file-saved' || toast.kind === 'file-error'
            return (
              <div
                key={toast.id}
                className={`app-toast${isFile ? ' app-toast--file' : ''}${toast.kind === 'file-error' ? ' app-toast--error' : ''}`}
                role="status"
                onMouseEnter={() => pauseToastTimer(toast.id)}
                onMouseLeave={() => scheduleToastTimer(toast.id, 3000)}
              >
                <button className="app-toast-body" type="button" onClick={() => handleToastClick(toast)}>
                  {toast.avatarPerson ? (
                    <Avatar person={toast.avatarPerson} size="sm" />
                  ) : (
                    <span className="app-toast-icon" aria-hidden="true">
                      <Icon name={isFile ? 'folder' : 'bell'} size="ico-sm" />
                    </span>
                  )}
                  <span className="app-toast-text">
                    <strong>{toast.title}</strong>
                    <span>{toast.body}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="app-toast-close"
                  aria-label={isFile ? 'Đóng thông báo tệp' : 'Đóng thông báo'}
                  onClick={() => dismissToast(toast.id)}
                >
                  <Icon name="close" size="ico-sm" />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </NotificationContext.Provider>
  )
}

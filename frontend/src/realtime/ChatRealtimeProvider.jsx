import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createChatConnection, listenForConversationChanges, listenForMessages,
  sendHeartbeat, startChatConnection, stopChatConnection,
} from '../services/chatConnection.js'
import { createHeartbeatLoop } from '../services/heartbeat.js'
import { conversationsApi } from '../services/conversationsApi.js'
import { ChatRealtimeContext } from './chatRealtimeContext.js'
import { createTextChatTransport } from '../services/textChatTransport.js'

// Nhan dien loi xac thuc tu HTTP/SignalR de ket thuc phien thay vi coi la mat mang tam.
function isAuthenticationError(error) {
  return error?.statusCode === 401 || /\b401\b|unauthenticated|session|phiên/i
    .test(error?.message || '')
}

// Giu ket noi va manager text song cung phien dang nhap, ke ca khi nguoi dung roi trang Chat.
// Cung cap pipeline tin chung, trang thai duong truyen va cac ham dong bo qua React context.
export function ChatRealtimeProvider({ token, user, onSessionExpired, children }) {
  const [connectionRevision, setConnectionRevision] = useState(0)
  const [connection, setConnection] = useState(null)
  const [connectionState, setConnectionState] = useState('connecting')
  const [connectionError, setConnectionError] = useState('')
  const [syncListeners] = useState(() => new Set())
  const [messageListeners] = useState(() => new Set())
  const textTransport = useRef(null)
  const [textStates, setTextStates] = useState({})
  // Dang ky mot noi nhan tin; tra ham xoa listener khi component unmount.
  const subscribeMessages = useCallback(listener => {
    messageListeners.add(listener)
    return () => messageListeners.delete(listener)
  }, [messageListeners])
  // Yeu cau manager hien tai mo P2P cho conversation; ref tranh dung manager da cu trong callback.
  const ensureTextSession = useCallback(id => textTransport.current?.ensure(id), [])
  // Gui tin qua manager dang hoat dong; tu choi neu ket noi chua duoc khoi tao.
  const sendTextMessage = useCallback(message => {
    if (!textTransport.current) return Promise.reject(new Error('Kết nối tin nhắn chưa sẵn sàng.'))
    return textTransport.current.send(message)
  }, [])
  // Bao cac man hinh tai lai du lieu; silent=true giu noi dung dang hien khi dong bo nen.
  const notifySync = useCallback((silent = false) => {
    for (const listener of syncListeners) listener(silent)
  }, [syncListeners])
  // Dang ky callback tai bu cho trang Chat va tra ham don dang ky tuong ung.
  const subscribeSync = useCallback(listener => {
    syncListeners.add(listener)
    return () => syncListeners.delete(listener)
  }, [syncListeners])

  // Tao socket/heartbeat/manager cho mot phien; cleanup chay khi doi tai khoan hoac tao lai ket noi.
  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    let activeConnection
    let synchronization = Promise.resolve()

    // Tai het cac trang tin chua giao va ACK tung tin, roi yeu cau UI lam moi lich su.
    // Dung cursor afterId de viec ACK lam mat tin khoi tap pending khong gay bo sot trang tiep theo.
    async function synchronizePendingMessages(silent = false) {
      try {
        let afterId = null
        do {
          const page = await conversationsApi.pendingMessages(token, { afterId }, controller.signal)
          for (const message of page.items) {
            if (disposed) return
            const status = await activeConnection.invoke('AcknowledgeMessage', {
              conversationId: message.conversationId, messageId: message.id,
            })
            // Da ACK o tren nen truyen false, tranh manager gui them mot ACK cho cung tin.
            manager.receiveServer({ ...message, deliveredAt: status.deliveredAt, readAt: status.readAt }, false)
          }
          afterId = page.nextCursor
        } while (afterId && !disposed)

        if (!disposed) notifySync(silent)
      } catch (failure) {
        if (disposed || failure.name === 'AbortError') return
        if (isAuthenticationError(failure)) onSessionExpired()
        else {
          setConnectionError('Đã kết nối lại nhưng chưa tải đủ tin nhắn. Bạn hãy thử kết nối lại.')
          notifySync(silent)
        }
      }
    }

    // Xep cac lan tai bu vao mot chuoi Promise de reconnect/online/dong phien khong chay chen nhau.
    function requestSynchronization(silent = false) {
      synchronization = synchronization.then(() => synchronizePendingMessages(silent))
      return synchronization
    }

    activeConnection = createChatConnection(token, {
      // Dung heartbeat va bo peer cu ngay khi SignalR bat dau thu noi lai.
      onReconnecting: () => {
        if (disposed) return
        heartbeat.stop()
        textTransport.current?.disconnected()
        setConnectionState('connecting')
      },
      // Khi co ConnectionId moi, tai bu truoc va thu tao lai cac phien P2P da mo.
      onReconnected: () => {
        if (disposed) return
        heartbeat.start()
        setConnectionState('connected')
        setConnectionError('')
        void requestSynchronization()
        textTransport.current?.refresh()
      },
      // Phan biet socket dong do het quyen va do mang, de UI dang xuat hoac cho thu lai.
      onClosed: failure => {
        if (disposed) return
        heartbeat.stop()
        textTransport.current?.disconnected()
        if (disposed) return
        setConnectionState('disconnected')
        if (isAuthenticationError(failure)) onSessionExpired()
        else setConnectionError('Kết nối tin nhắn đã ngắt. Bạn hãy kết nối lại.')
      },
    })
    const heartbeat = createHeartbeatLoop(() => sendHeartbeat(activeConnection), failure => {
      if (isAuthenticationError(failure)) onSessionExpired()
    })
    // Gui lai nhip song khi tab hien ra/focus, neu socket van connected va phien chua huy.
    function resumeHeartbeat() {
      if (!disposed && document.visibilityState === 'visible' &&
          activeConnection.state === 'Connected') heartbeat.start()
    }
    // Tai bu khi browser bao co mang lai, ke ca mat mang qua ngan de SignalR kip disconnected.
    function networkOnline() {
      if (!disposed && activeConnection.state === 'Connected') {
        heartbeat.start()
        void requestSynchronization()
      }
    }
    document.addEventListener('visibilitychange', resumeHeartbeat)
    window.addEventListener('focus', resumeHeartbeat)
    window.addEventListener('online', networkOnline)
    queueMicrotask(() => {
      if (!disposed) { setConnection(activeConnection); setTextStates({}) }
    })
    const manager = createTextChatTransport({
      connection: activeConnection, token, userId: user.id,
      // Phien P2P dong co the de lai tin da commit chua giao; tai bu nen, khong an thread.
      onSyncNeeded: () => { void requestSynchronization(true) },
      // Phat tin tu moi duong truyen toi cung tap subscriber cua UI.
      onMessage: message => {
        if (!disposed) for (const listener of messageListeners) listener(message)
      },
      // Cap nhat route theo conversation, dung functional setState de khong de mat cap nhat khac.
      onState: (id, state) => {
        if (!disposed) setTextStates(current => ({ ...current, [id]: state }))
      },
    })
    textTransport.current = manager
    const peerRefresh = setInterval(() => manager.refresh(), 15000)
    const removeMessageListener = listenForMessages(activeConnection, message => manager.receiveServer(message))
    const removeConversationListener = listenForConversationChanges(activeConnection, () => notifySync())
    startChatConnection(activeConnection).then(async () => {
      if (disposed) return
      heartbeat.start()
      setConnectionState('connected')
      await requestSynchronization()
    }).catch(failure => {
      if (disposed) return
      setConnectionState('disconnected')
      if (isAuthenticationError(failure)) onSessionExpired()
      else setConnectionError('Không mở được kết nối tin nhắn. Kiểm tra server rồi thử lại.')
    })
    // Danh dau disposed truoc khi dong socket de callback muon khong sua state cua phien moi.
    return () => {
      disposed = true
      clearInterval(peerRefresh)
      manager.dispose()
      if (textTransport.current === manager) textTransport.current = null
      heartbeat.stop()
      document.removeEventListener('visibilitychange', resumeHeartbeat)
      window.removeEventListener('focus', resumeHeartbeat)
      window.removeEventListener('online', networkOnline)
      controller.abort()
      removeMessageListener()
      removeConversationListener()
      void stopChatConnection(activeConnection)
    }
  }, [connectionRevision, messageListeners, notifySync, onSessionExpired, token, user.id])

  const value = useMemo(() => ({
    connection,
    connectionState,
    connectionError,
    subscribeSync,
    subscribeMessages, ensureTextSession, sendTextMessage, textStates,
    // Tang revision de effect huy bo ket noi cu va khoi tao mot ket noi moi theo yeu cau UI.
    reconnect: () => {
      setConnectionState('connecting')
      setConnectionError('')
      setConnectionRevision(value => value + 1)
    },
  }), [connection, connectionError, connectionState, subscribeSync, subscribeMessages,
    ensureTextSession, sendTextMessage, textStates])

  return <ChatRealtimeContext.Provider value={value}>{children}</ChatRealtimeContext.Provider>
}

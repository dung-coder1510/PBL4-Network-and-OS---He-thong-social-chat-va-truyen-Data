import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  acknowledgeDelivered, createChatConnection, listenForConversationChanges, listenForMessages,
  startChatConnection, stopChatConnection,
} from '../services/chatConnection.js'
import { conversationsApi } from '../services/conversationsApi.js'
import { ChatRealtimeContext } from './chatRealtimeContext.js'

function isAuthenticationError(error) {
  return error?.statusCode === 401 || /\b401\b|unauthenticated|session|phiên/i
    .test(error?.message || '')
}

export function ChatRealtimeProvider({ token, user, onSessionExpired, children }) {
  const [connectionRevision, setConnectionRevision] = useState(0)
  const [connection, setConnection] = useState(null)
  const [connectionState, setConnectionState] = useState('connecting')
  const [connectionError, setConnectionError] = useState('')
  const [syncListeners] = useState(() => new Set())
  const notifySync = useCallback(() => {
    for (const listener of syncListeners) listener()
  }, [syncListeners])
  const subscribeSync = useCallback(listener => {
    syncListeners.add(listener)
    return () => syncListeners.delete(listener)
  }, [syncListeners])

  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    let activeConnection
    let synchronization = Promise.resolve()

    async function synchronizePendingMessages() {
      try {
        let afterId = null
        const latestByConversation = new Map()
        do {
          const page = await conversationsApi.pendingMessages(token, { afterId }, controller.signal)
          for (const message of page.items) {
            const current = latestByConversation.get(message.conversationId)
            if (!current || BigInt(message.id) > BigInt(current.id))
              latestByConversation.set(message.conversationId, message)
          }
          afterId = page.nextCursor
        } while (afterId && !disposed)

        if (disposed) return
        await Promise.all([...latestByConversation.values()].map(message =>
          acknowledgeDelivered(activeConnection, message.conversationId, message.id)))
        if (!disposed) notifySync()
      } catch (failure) {
        if (disposed || failure.name === 'AbortError') return
        if (isAuthenticationError(failure)) onSessionExpired()
        else {
          setConnectionError('Đã kết nối lại nhưng chưa tải đủ tin nhắn. Bạn hãy thử kết nối lại.')
          notifySync()
        }
      }
    }

    function requestSynchronization() {
      synchronization = synchronization.then(synchronizePendingMessages)
      return synchronization
    }

    activeConnection = createChatConnection(token, {
      onReconnecting: () => setConnectionState('connecting'),
      onReconnected: () => {
        setConnectionState('connected')
        setConnectionError('')
        void requestSynchronization()
      },
      onClosed: failure => {
        setConnectionState('disconnected')
        if (isAuthenticationError(failure)) onSessionExpired()
        else setConnectionError('Kết nối tin nhắn đã ngắt. Bạn hãy kết nối lại.')
      },
    })
    queueMicrotask(() => {
      if (!disposed) setConnection(activeConnection)
    })
    const removeMessageListener = listenForMessages(activeConnection, message => {
      if (message.senderId !== user.id)
        void acknowledgeDelivered(activeConnection, message.conversationId, message.id).catch(() => {})
    })
    const removeConversationListener = listenForConversationChanges(activeConnection, notifySync)
    startChatConnection(activeConnection).then(async () => {
      if (disposed) return
      setConnectionState('connected')
      await requestSynchronization()
    }).catch(failure => {
      if (disposed) return
      setConnectionState('disconnected')
      if (isAuthenticationError(failure)) onSessionExpired()
      else setConnectionError('Không mở được kết nối tin nhắn. Kiểm tra server rồi thử lại.')
    })
    return () => {
      disposed = true
      controller.abort()
      removeMessageListener()
      removeConversationListener()
      void stopChatConnection(activeConnection)
    }
  }, [connectionRevision, notifySync, onSessionExpired, token, user.id])

  const value = useMemo(() => ({
    connection,
    connectionState,
    connectionError,
    subscribeSync,
    reconnect: () => {
      setConnectionState('connecting')
      setConnectionError('')
      setConnectionRevision(value => value + 1)
    },
  }), [connection, connectionError, connectionState, subscribeSync])

  return <ChatRealtimeContext.Provider value={value}>{children}</ChatRealtimeContext.Provider>
}

import { useEffect, useRef, useState } from 'react'
import ConversationList from '../components/chat/ConversationList.jsx'
import ConversationThread from '../components/chat/ConversationThread.jsx'
import NewConversationDialog from '../components/chat/NewConversationDialog.jsx'
import { conversationsApi } from '../services/conversationsApi.js'
import {
  acknowledgeDelivered, createChatConnection, listenForMessages,
  listenForMessageStatuses, listenForPresence, listenForTyping, markAsRead,
  sendMessage, setTyping as sendTypingState, startChatConnection, stopChatConnection,
} from '../services/chatConnection.js'
import {
  applyMessageStatus, applyPresence, createClientMessageId, upsertConversationMessage,
} from '../utils/chatState.js'
import '../styles/conversations.css'

function messageKey(message) {
  return `${message.senderId}:${message.clientMessageId}`
}

function mergeMessages(current, additions) {
  const byKey = new Map(current.map(message => [messageKey(message), message]))
  for (const message of additions) {
    const old = byKey.get(messageKey(message))
    byKey.set(messageKey(message), { ...old, ...message })
  }
  return [...byKey.values()].sort((a, b) => {
    const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt)
    return byTime || messageKey(a).localeCompare(messageKey(b))
  })
}

function isAuthenticationError(error) {
  return error?.statusCode === 401 || /\b401\b|unauthenticated/i.test(error?.message || '')
}

export default function ChatPage({ token, user, initialConversationId,
  onInitialConversationHandled, onSessionExpired }) {
  const [items, setItems] = useState([])
  const itemsRef = useRef([])
  const [query, setQuery] = useState('')
  const queryRef = useRef('')
  const [cursor, setCursor] = useState(null)
  const [nextCursor, setNextCursor] = useState(null)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const selectedIdRef = useRef(null)
  const [conversation, setConversation] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [detailRevision, setDetailRevision] = useState(0)
  const [messages, setMessages] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyBefore, setHistoryBefore] = useState(null)
  const [nextHistoryCursor, setNextHistoryCursor] = useState(null)
  const [historyRevision, setHistoryRevision] = useState(0)
  const [connectionState, setConnectionState] = useState('connecting')
  const [connectionError, setConnectionError] = useState('')
  const [connectionRevision, setConnectionRevision] = useState(0)
  const connectionRef = useRef(null)
  const lastReadRequestRef = useRef(null)
  const typingActiveRef = useRef(false)
  const typingConversationRef = useRef(null)
  const typingStopTimerRef = useRef(null)
  const peerTypingTimerRef = useRef(null)
  const [peerTyping, setPeerTyping] = useState(false)
  const [visibilityRevision, setVisibilityRevision] = useState(0)
  const [showCreate, setShowCreate] = useState(false)
  const [showList, setShowList] = useState(true)

  function changeItems(updater) {
    setItems(current => {
      const next = updater(current)
      itemsRef.current = next
      return next
    })
  }

  useEffect(() => {
    const changed = () => setVisibilityRevision(value => value + 1)
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const page = await conversationsApi.list(token, {
          search: query.trim(), beforeId: cursor,
        }, controller.signal)
        if (!controller.signal.aborted) {
          changeItems(current => cursor
            ? [...current, ...page.items.filter(item => !current.some(old => old.id === item.id))]
            : page.items)
          setNextCursor(page.nextCursor)
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          if (failure.status === 401) onSessionExpired()
          else setError(failure.message)
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, cursor ? 0 : 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [token, query, cursor, revision, onSessionExpired])

  useEffect(() => {
    if (!selectedId) return undefined
    const controller = new AbortController()
    conversationsApi.get(token, selectedId, controller.signal).then(result => {
      if (!controller.signal.aborted) setConversation(result)
    }).catch(failure => {
      if (!controller.signal.aborted) {
        if (failure.status === 401) onSessionExpired()
        else setDetailError(failure.message)
      }
    }).finally(() => {
      if (!controller.signal.aborted) setDetailLoading(false)
    })
    return () => controller.abort()
  }, [token, selectedId, detailRevision, onSessionExpired])

  useEffect(() => {
    if (!selectedId) return undefined
    const controller = new AbortController()
    conversationsApi.messages(token, selectedId, { beforeId: historyBefore }, controller.signal)
      .then(page => {
        if (controller.signal.aborted) return
        setMessages(current => mergeMessages(page.items, current))
        setNextHistoryCursor(page.nextCursor)
      }).catch(failure => {
        if (controller.signal.aborted) return
        if (failure.status === 401) onSessionExpired()
        else setHistoryError(failure.message)
      }).finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false)
      })
    return () => controller.abort()
  }, [token, selectedId, historyBefore, historyRevision, onSessionExpired])

  useEffect(() => {
    let disposed = false
    const loadingConversations = new Set()
    const connection = createChatConnection(token, {
      onReconnecting: () => { if (!disposed) setConnectionState('connecting') },
      onReconnected: () => {
        if (disposed) return
        setConnectionState('connected')
        setConnectionError('')
        setLoading(true)
        setError('')
        changeItems(() => [])
        setCursor(null)
        setNextCursor(null)
        setRevision(value => value + 1)
        setHistoryLoading(Boolean(selectedIdRef.current))
        setHistoryBefore(null)
        setHistoryRevision(value => value + 1)
        lastReadRequestRef.current = null
      },
      onClosed: failure => {
        if (disposed) return
        setConnectionState('disconnected')
        if (isAuthenticationError(failure)) onSessionExpired()
        else setConnectionError('Kết nối tin nhắn đã ngắt. Bạn hãy kết nối lại.')
      },
    })
    connectionRef.current = connection

    const removeMessageListener = listenForMessages(connection, message => {
      const received = { ...message, sendState: 'sent' }
      const active = selectedIdRef.current === message.conversationId &&
        document.visibilityState === 'visible'
      const knownConversation = itemsRef.current.some(item => item.id === message.conversationId)
      changeItems(current => upsertConversationMessage(current, received, null, {
        currentUserId: user.id, isActive: active,
      }))

      if (!knownConversation && !queryRef.current.trim() &&
          !loadingConversations.has(message.conversationId)) {
        loadingConversations.add(message.conversationId)
        conversationsApi.get(token, message.conversationId).then(result => {
          if (disposed) return
          changeItems(current => upsertConversationMessage(
            current, result.lastMessage || received, result,
            { currentUserId: user.id, isActive: active, fromSnapshot: true }))
        }).catch(failure => {
          if (!disposed && failure.status === 401) onSessionExpired()
        }).finally(() => loadingConversations.delete(message.conversationId))
      }

      if (message.senderId !== user.id)
        void acknowledgeDelivered(connection, message.conversationId, message.id).catch(() => {})
      if (selectedIdRef.current === message.conversationId)
        setMessages(current => mergeMessages(current, [received]))
    })

    const removeStatusListener = listenForMessageStatuses(connection, status => {
      setMessages(current => applyMessageStatus(current, status))
      changeItems(current => current.map(item => {
        if (item.id !== status.conversationId) return item
        const lastMessage = item.lastMessage
          ? applyMessageStatus([item.lastMessage], status)[0] : null
        return {
          ...item,
          lastMessage,
          unreadCount: status.readAt && status.recipientUserId === user.id
            ? 0 : item.unreadCount,
        }
      }))
    })

    const removePresenceListener = listenForPresence(connection, status => {
      changeItems(current => applyPresence(current, status))
      setConversation(current => current?.peer.id === status.userId
        ? { ...current, peer: { ...current.peer, ...status } } : current)
    })

    const removeTypingListener = listenForTyping(connection, status => {
      if (status.userId === user.id || status.conversationId !== selectedIdRef.current) return
      clearTimeout(peerTypingTimerRef.current)
      setPeerTyping(status.isTyping)
      if (status.isTyping)
        peerTypingTimerRef.current = setTimeout(() => setPeerTyping(false), 4000)
    })

    startChatConnection(connection).then(() => {
      if (disposed) return
      setConnectionState('connected')
      // Bù khoảng trống giữa lần tải REST đầu tiên và lúc Hub bắt đầu nhận event.
      setLoading(true)
      setRevision(value => value + 1)
    }).catch(failure => {
      if (disposed) return
      setConnectionState('disconnected')
      if (isAuthenticationError(failure)) onSessionExpired()
      else setConnectionError('Không mở được kết nối tin nhắn. Kiểm tra server rồi thử lại.')
    })
    return () => {
      disposed = true
      clearTimeout(peerTypingTimerRef.current)
      clearTimeout(typingStopTimerRef.current)
      removeMessageListener()
      removeStatusListener()
      removePresenceListener()
      removeTypingListener()
      if (connectionRef.current === connection) connectionRef.current = null
      void stopChatConnection(connection)
    }
  }, [token, connectionRevision, onSessionExpired, user.id])

  useEffect(() => {
    if (!selectedId || connectionState !== 'connected' ||
        document.visibilityState !== 'visible') return
    const latestIncoming = messages.findLast(message =>
      message.senderId !== user.id && /^\d+$/.test(String(message.id)))
    if (!latestIncoming?.id || latestIncoming.readAt) return
    const requestKey = `${selectedId}:${latestIncoming.id}`
    if (lastReadRequestRef.current === requestKey) return
    lastReadRequestRef.current = requestKey
    markAsRead(connectionRef.current, selectedId, latestIncoming.id).catch(() => {
      if (lastReadRequestRef.current === requestKey) lastReadRequestRef.current = null
    })
  }, [messages, selectedId, connectionState, visibilityRevision, user.id])

  useEffect(() => {
    if (initialConversationId && selectedIdRef.current !== initialConversationId) {
      select(initialConversationId)
      onInitialConversationHandled?.()
    }
  }, [initialConversationId, onInitialConversationHandled])

  function refresh() {
    setLoading(true)
    setError('')
    changeItems(() => [])
    setCursor(null)
    setNextCursor(null)
    setRevision(value => value + 1)
  }

  function search(value) {
    setLoading(true)
    setError('')
    changeItems(() => [])
    queryRef.current = value
    setQuery(value)
    setCursor(null)
    setNextCursor(null)
  }

  function stopTyping() {
    clearTimeout(typingStopTimerRef.current)
    if (!typingActiveRef.current) return
    const connection = connectionRef.current
    const conversationId = typingConversationRef.current
    typingActiveRef.current = false
    typingConversationRef.current = null
    if (connection?.state === 'Connected' && conversationId)
      void sendTypingState(connection, conversationId, false).catch(() => {})
  }

  function typingChanged(isTyping) {
    const connection = connectionRef.current
    if (!selectedIdRef.current || connectionState !== 'connected' || !connection) return
    clearTimeout(typingStopTimerRef.current)
    if (!isTyping) {
      stopTyping()
      return
    }
    if (!typingActiveRef.current || typingConversationRef.current !== selectedIdRef.current) {
      typingActiveRef.current = true
      typingConversationRef.current = selectedIdRef.current
      void sendTypingState(connection, selectedIdRef.current, true).catch(() => {})
    }
    typingStopTimerRef.current = setTimeout(stopTyping, 2500)
  }

  function select(id) {
    stopTyping()
    selectedIdRef.current = id
    lastReadRequestRef.current = null
    setSelectedId(id)
    setPeerTyping(false)
    changeItems(current => current.map(item => item.id === id
      ? { ...item, unreadCount: 0 } : item))
    setShowList(false)
    setDetailLoading(true)
    setDetailError('')
    setConversation(null)
    setMessages([])
    setHistoryLoading(true)
    setHistoryBefore(null)
    setNextHistoryCursor(null)
    setHistoryError('')
    setHistoryRevision(value => value + 1)
    setDetailRevision(value => value + 1)
  }

  function retryDetail() {
    setDetailLoading(true)
    setDetailError('')
    setConversation(null)
    setDetailRevision(value => value + 1)
  }

  function loadMore() {
    if (loading || !nextCursor) return
    setLoading(true)
    setError('')
    setCursor(nextCursor)
  }

  function created(result) {
    setShowCreate(false)
    setQuery('')
    queryRef.current = ''
    refresh()
    select(result.id)
  }

  function retryHistory() {
    setHistoryLoading(true)
    setHistoryError('')
    setHistoryRevision(value => value + 1)
  }

  function loadOlderMessages() {
    if (!nextHistoryCursor || historyLoading) return
    setHistoryLoading(true)
    setHistoryError('')
    setHistoryBefore(nextHistoryCursor)
  }

  function reconnect() {
    setConnectionState('connecting')
    setConnectionError('')
    setConnectionRevision(value => value + 1)
  }

  async function submitMessage(content, existingClientMessageId) {
    const connection = connectionRef.current
    if (!selectedId || !connection || connectionState !== 'connected')
      throw new Error('Kết nối tin nhắn chưa sẵn sàng.')

    const clientMessageId = existingClientMessageId || createClientMessageId()
    const optimistic = {
      id: `local:${clientMessageId}`, clientMessageId, conversationId: selectedId,
      senderId: user.id, content, createdAt: new Date().toISOString(), sendState: 'sending',
      deliveredAt: null, readAt: null,
    }
    setMessages(current => mergeMessages(current, [optimistic]))
    try {
      const saved = await sendMessage(connection, {
        conversationId: selectedId, clientMessageId, content,
      })
      setMessages(current => mergeMessages(current, [{ ...saved, sendState: 'sent' }]))
      changeItems(current => upsertConversationMessage(current, saved, conversation, {
        currentUserId: user.id, isActive: true,
      }))
      return saved
    } catch (failure) {
      setMessages(current => current.map(message =>
        messageKey(message) === messageKey(optimistic) && String(message.id).startsWith('local:')
          ? { ...message, sendState: 'failed', error: failure.message } : message))
      throw failure
    }
  }

  return (
    <div className={`chat-layout live-chat${showList ? ' show-conv' : ''}`}>
      <ConversationList items={items} query={query} onQueryChange={search} loading={loading}
        error={error} currentUserId={user.id} selectedId={selectedId} onSelect={select}
        onCreate={() => setShowCreate(true)} onRefresh={refresh} hasMore={Boolean(nextCursor)}
        onLoadMore={loadMore} />
      <ConversationThread conversation={conversation} loading={detailLoading} error={detailError}
        messages={messages} currentUserId={user.id} historyLoading={historyLoading}
        historyError={historyError} hasOlder={Boolean(nextHistoryCursor)}
        connectionState={connectionState} connectionError={connectionError}
        peerTyping={peerTyping} onTypingChange={typingChanged} onBack={() => setShowList(true)}
        onRetry={retryDetail} onRetryHistory={retryHistory} onLoadOlder={loadOlderMessages}
        onSend={submitMessage} onRetryMessage={message =>
          submitMessage(message.content, message.clientMessageId)}
        onReconnect={reconnect} onCreate={() => setShowCreate(true)} />
      {showCreate && <NewConversationDialog token={token} onClose={() => setShowCreate(false)}
        onCreated={created} onSessionExpired={onSessionExpired} />}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import ConversationList from '../components/chat/ConversationList.jsx'
import ConversationThread from '../components/chat/ConversationThread.jsx'
import NewConversationDialog from '../components/chat/NewConversationDialog.jsx'
import { conversationsApi } from '../services/conversationsApi.js'
import AddContactDialog from '../components/contacts/AddContactDialog.jsx'
import {
  listenForMessageStatuses, listenForPresence, listenForTyping,
  setTyping as sendTypingState,
} from '../services/chatConnection.js'
import { useChatRealtime } from '../realtime/chatRealtimeContext.js'
import { useFileTransfers } from '../realtime/fileTransferContext.js'
import {
  applyMessageStatus, applyPresence, createClientMessageId, mergeChatMessages, sortConversations, upsertConversationMessage,
} from '../utils/chatState.js'
import '../styles/conversations.css'

// Tao khoa on dinh cho tin o moi duong truyen; sender duoc ghep vao de UUID khong bi nham tai khoan.
function messageKey(message) {
  return `${message.senderId}:${message.clientMessageId}`
}

const mergeMessages = mergeChatMessages

// Quan ly danh sach conversation, lich su, thao tac gui va read/typing cua trang Chat.
// Ket noi va nhan tin thuc te nam o provider de doi trang khong lam ngung P2P.
export default function ChatPage({ token, user, initialConversationId,
  onInitialConversationHandled, onSessionExpired }) {
  const { connection, connectionState, connectionError, reconnect, subscribeSync,
    subscribeMessages, ensureTextSession, sendTextMessage, textStates } = useChatRealtime()
  const files = useFileTransfers()
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
  const connectionRef = useRef(connection)
  const pendingReads = useRef(new Set())
  const typingActiveRef = useRef(false)
  const typingConversationRef = useRef(null)
  const typingStopTimerRef = useRef(null)
  const peerTypingTimerRef = useRef(null)
  const [peerTyping, setPeerTyping] = useState(false)
  const [visibilityRevision, setVisibilityRevision] = useState(0)
  const [showCreate, setShowCreate] = useState(false)
  const [contactToAdd, setContactToAdd] = useState(null)
  const [showList, setShowList] = useState(true)
  const showListRef = useRef(true)

  // Kiem tra thread co thuc su hien theo breakpoint 900px; document visible chua du tren mobile.
  function threadVisible() {
    return !window.matchMedia('(max-width: 900px)').matches || !showListRef.current
  }

  // Cap nhat state va ref danh sach cung luc, de listener bat dong bo doc du lieu moi nhat.
  function changeItems(updater) {
    setItems(current => {
      const next = sortConversations(updater(current))
      itemsRef.current = next
      return next
    })
  }

  // Kich hoat danh gia read lai khi doi do hien thi cua tab hoac vuot breakpoint mobile.
  useEffect(() => {
    // Tang revision de effect read chay lai, khong can tao lai ket noi.
    const changed = () => setVisibilityRevision(value => value + 1)
    const narrowScreen = window.matchMedia('(max-width: 900px)')
    document.addEventListener('visibilitychange', changed)
    narrowScreen.addEventListener('change', changed)
    return () => {
      document.removeEventListener('visibilitychange', changed)
      narrowScreen.removeEventListener('change', changed)
    }
  }, [])

  // Debounce tim kiem 250ms; trang tiep theo tai ngay va loai conversation trung ID.
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const page = await conversationsApi.list(token, {
          search: query.trim(), cursor,
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

  // Tai thong tin conversation dang chon; huy request cu khi nguoi dung doi nguoi nhan.
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

  // Tai trang lich su va gop voi tin live; ban sao tu REST khong duoc xoa receipt moi hon.
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

  // Dang ky tin/receipt/presence/typing cho UI; bo listener va timer khi ket noi hoac trang thay doi.
  useEffect(() => {
    if (!connection) return undefined
    let disposed = false
    const pendingConversations = new Map()
    connectionRef.current = connection

    // Xu ly chung tin P2P/SignalR: doi preview/unread va them vao thread neu dung conversation.
    const removeMessageListener = subscribeMessages(message => {
      const received = { ...message, sendState: 'sent' }
      const active = selectedIdRef.current === message.conversationId &&
        document.visibilityState === 'visible' && threadVisible()
      const knownConversation = itemsRef.current.some(item => item.id === message.conversationId)
      changeItems(current => upsertConversationMessage(current, received, null, {
        currentUserId: user.id, isActive: active,
      }))

      // Neu tin den truoc thong tin conversation, dem tin trong Map va chi goi API chi tiet mot lan.
      // Snapshot tra ve co the cu hon tin live, nen can ap lai cac tin da dem sau snapshot.
      if (!knownConversation && !queryRef.current.trim()) {
        let pending = pendingConversations.get(message.conversationId)
        if (!pending) {
          pending = { loading: false, messages: [] }
          pendingConversations.set(message.conversationId, pending)
        }
        if (!pending.messages.some(item => messageKey(item) === messageKey(received)))
          pending.messages.push(received)
        if (!pending.loading) {
          pending.loading = true
          conversationsApi.get(token, message.conversationId).then(result => {
            if (disposed) return
            const bufferedMessages = pendingConversations.get(message.conversationId)?.messages || []
            changeItems(current => {
              const isActive = selectedIdRef.current === message.conversationId &&
                document.visibilityState === 'visible' && threadVisible()
              let next = upsertConversationMessage(current,
                result.lastMessage || bufferedMessages[0] || received, result,
                { currentUserId: user.id, isActive, fromSnapshot: true })
              for (const buffered of bufferedMessages)
                next = upsertConversationMessage(next, buffered, null,
                  { currentUserId: user.id, isActive })
              return next
            })
          }).catch(failure => {
            if (!disposed && failure.status === 401) onSessionExpired()
          }).finally(() => pendingConversations.delete(message.conversationId))
        }
      }

      if (selectedIdRef.current === message.conversationId)
        setMessages(current => mergeMessages(current, [received]))
    })

    // Gop receipt vao thread/preview; exact read dung unread count cua server, khong tu xoa tat ca.
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
            ? status.unreadCount ?? (status.messageId ? item.unreadCount : 0) : item.unreadCount,
        }
      }))
    })

    // Dong bo trang thai online cua peer trong ca danh sach va header thread dang chon.
    const removePresenceListener = listenForPresence(connection, status => {
      changeItems(current => applyPresence(current, status))
      setConversation(current => current?.peer.id === status.userId
        ? { ...current, peer: { ...current.peer, ...status } } : current)
    })

    // Chi hien typing cua peer dang chon; tu tat sau 4 giay neu khong nhan tin hieu stop.
    const removeTypingListener = listenForTyping(connection, status => {
      if (status.userId === user.id || status.conversationId !== selectedIdRef.current) return
      clearTimeout(peerTypingTimerRef.current)
      setPeerTyping(status.isTyping)
      if (status.isTyping)
        peerTypingTimerRef.current = setTimeout(() => setPeerTyping(false), 4000)
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
    }
  }, [connection, subscribeMessages, token, onSessionExpired, user.id])

  // Thu mo P2P khi chon conversation, ket noi lai hoac trang thai peer thay doi.
  useEffect(() => {
    if (selectedId && connectionState === 'connected') void ensureTextSession(selectedId)
  }, [selectedId, connectionState, conversation?.peer.isOnline, ensureTextSession])

  // Lam moi cursor va lich su sau tai bu; silent giu noi dung dang hien de fallback khong nhap nhay.
  useEffect(() => subscribeSync(silent => {
    if (!silent) {
      setLoading(true)
      changeItems(() => [])
      setHistoryLoading(Boolean(selectedIdRef.current))
      setDetailLoading(Boolean(selectedIdRef.current))
    }
    setError('')
    setCursor(null)
    setNextCursor(null)
    setRevision(value => value + 1)
    setHistoryBefore(null)
    setHistoryRevision(value => value + 1)
    setDetailError('')
    setDetailRevision(value => value + 1)
    pendingReads.current.clear()
  }), [subscribeSync])

  // Chi read tung tin da luu khi thread thuc su hien; Set chan request trung trong luc dang cho.
  // Khong read cong don de tin den sau khong danh dau luon cac tin truoc con chua nhan.
  useEffect(() => {
    if (!selectedId || connectionState !== 'connected' ||
        document.visibilityState !== 'visible' || !threadVisible()) return
    const unread = messages.filter(message => message.senderId !== user.id &&
      /^\d+$/.test(String(message.id)) && !message.readAt)
    for (const message of unread) {
      const requestKey = `${selectedId}:${message.id}`
      if (pendingReads.current.has(requestKey)) continue
      pendingReads.current.add(requestKey)
      void connectionRef.current.invoke('ReadMessage', { conversationId: selectedId, messageId: message.id })
        .then(status => {
          if (selectedIdRef.current === message.conversationId)
            setMessages(current => applyMessageStatus(current, status))
        }).catch(() => {}).finally(() => pendingReads.current.delete(requestKey))
    }
  }, [messages, selectedId, showList, connectionState, visibilityRevision, user.id])

  // Mo conversation duoc truyen tu Danh ba hoac man hinh khac, roi bao da xu ly yeu cau.
  useEffect(() => {
    if (initialConversationId && selectedIdRef.current !== initialConversationId) {
      select(initialConversationId)
      onInitialConversationHandled?.()
    }
  }, [initialConversationId, onInitialConversationHandled])

  // Tai lai danh sach tu trang dau, xoa loi va cursor cu de khong ghep sai phan trang.
  function refresh() {
    setLoading(true)
    setError('')
    changeItems(() => [])
    setCursor(null)
    setNextCursor(null)
    setRevision(value => value + 1)
  }

  // Cap nhat tu khoa va ref cho listener, sau do bat dau lai danh sach tu trang dau.
  function search(value) {
    setLoading(true)
    setError('')
    changeItems(() => [])
    queryRef.current = value
    setQuery(value)
    setCursor(null)
    setNextCursor(null)
  }

  // Huy timer typing va gui stop cho conversation cu neu truoc do da bao dang nhap.
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

  // Chi gui start khi vua bat dau/doi conversation; dat lai timer stop 2,5 giay khi tiep tuc go.
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

  // Doi conversation, dung typing cu va reset thread/cursor; khong mang ban nhap sang nguoi khac.
  function select(id) {
    stopTyping()
    selectedIdRef.current = id
    pendingReads.current.clear()
    setSelectedId(id)
    setPeerTyping(false)
    showListRef.current = false
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

  // Tang revision de chay lai request thong tin conversation sau loi.
  function retryDetail() {
    setDetailLoading(true)
    setDetailError('')
    setConversation(null)
    setDetailRevision(value => value + 1)
  }

  // Lay trang conversation tiep theo neu co cursor va khong co request dang tai.
  function loadMore() {
    if (loading || !nextCursor) return
    setLoading(true)
    setError('')
    setCursor(nextCursor)
  }

  // Sau khi tao conversation, dong hop thoai, bo loc tim kiem va mo thread vua tao.
  function created(result) {
    setShowCreate(false)
    setQuery('')
    queryRef.current = ''
    refresh()
    select(result.id)
  }

  // Xoa loi lich su va tang revision de thu lai trang dang can tai.
  function retryHistory() {
    setHistoryLoading(true)
    setHistoryError('')
    setHistoryRevision(value => value + 1)
  }

  // Chuyen cursor ve trang tin cu hon; effect lich su se tai va gop vao thread hien tai.
  function loadOlderMessages() {
    if (!nextHistoryCursor || historyLoading) return
    setHistoryLoading(true)
    setHistoryError('')
    setHistoryBefore(nextHistoryCursor)
  }

  // Chi an nhan Nguoi la sau khi popup luu thanh cong; cap nhat theo peer de khong nham thread.
  function contactAdded(contact) {
    setConversation(current => current?.peer.id === contact.user.id
      ? { ...current, isContact: true } : current)
    changeItems(current => current.map(item => item.peer.id === contact.user.id
      ? { ...item, isContact: true } : item))
    setContactToAdd(null)
  }

  // Hien tin optimistic ngay, gui qua manager va thay bang tin SQL chuan khi co ket qua.
  // Retry giu UUID cu; luu conversation luc bat dau de response muon khong chen vao thread da doi.
  async function submitMessage(content, existingClientMessageId) {
    const connection = connectionRef.current
    if (!selectedId || !connection || connectionState !== 'connected')
      throw new Error('Kết nối tin nhắn chưa sẵn sàng.')

    const clientMessageId = existingClientMessageId || createClientMessageId()
    const sendingConversationId = selectedId
    const optimistic = {
      id: `local:${clientMessageId}`, clientMessageId, conversationId: selectedId,
      senderId: user.id, content, createdAt: new Date().toISOString(), sendState: 'sending',
      deliveredAt: null, readAt: null,
    }
    setMessages(current => mergeMessages(current, [optimistic]))
    try {
      const saved = await sendTextMessage({
        conversationId: selectedId, clientMessageId, content,
      })
      if (selectedIdRef.current === sendingConversationId)
        setMessages(current => mergeMessages(current, [{ ...saved, sendState: 'sent' }]))
      changeItems(current => upsertConversationMessage(current, saved, conversation, {
        currentUserId: user.id, isActive: selectedIdRef.current === sendingConversationId && threadVisible(),
      }))
      return saved
    } catch (failure) {
      if (selectedIdRef.current === sendingConversationId)
        setMessages(current => current.map(message =>
          messageKey(message) === messageKey(optimistic) && !message.deliveredAt
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
      <ConversationThread key={conversation?.id || selectedId || 'empty'}
        conversation={conversation} loading={detailLoading} error={detailError}
        messages={messages} currentUserId={user.id} historyLoading={historyLoading}
        historyError={historyError} hasOlder={Boolean(nextHistoryCursor)}
        connectionState={connectionState} connectionError={connectionError}
        textState={textStates[selectedId]}
        peerTyping={peerTyping} onTypingChange={typingChanged} onBack={() => {
          showListRef.current = true
          setShowList(true)
        }}
        onRetry={retryDetail} onRetryHistory={retryHistory} onLoadOlder={loadOlderMessages}
        onSend={submitMessage} onSendFile={file => files.offer(conversation.id, file)} onRetryMessage={message =>
          submitMessage(message.content, message.clientMessageId)}
        onReconnect={reconnect} onCreate={() => setShowCreate(true)}
        onAddContact={() => setContactToAdd(conversation)} />
      {showCreate && <NewConversationDialog token={token} onClose={() => setShowCreate(false)}
        onCreated={created} onSessionExpired={onSessionExpired} />}
      {contactToAdd && <AddContactDialog token={token} person={contactToAdd.peer}
        onClose={() => setContactToAdd(null)} onAdded={contactAdded}
        onSessionExpired={onSessionExpired} />}
    </div>
  )
}

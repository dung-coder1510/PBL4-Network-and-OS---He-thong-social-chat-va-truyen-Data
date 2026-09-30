import { useLayoutEffect, useRef, useState } from 'react'
import Avatar from '../Avatar.jsx'
import Icon from '../Icon.jsx'

function formatTime(value) {
  return new Date(value).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
}

export default function ConversationThread({ conversation, loading, error, messages,
  currentUserId, historyLoading, historyError, hasOlder, connectionState, connectionError,
  peerTyping, onTypingChange, onBack, onRetry, onRetryHistory, onLoadOlder, onSend,
  onRetryMessage, onReconnect, onCreate }) {
  const peer = conversation?.peer
  const messageList = useRef(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')

  useLayoutEffect(() => {
    if (messageList.current) messageList.current.scrollTop = messageList.current.scrollHeight
  }, [conversation?.id, messages.length])

  async function submit(event) {
    event.preventDefault()
    const content = draft.trim()
    if (!content || sending) return
    setSending(true)
    setSendError('')
    try {
      await onSend(content)
      setDraft('')
      onTypingChange(false)
    } catch (failure) {
      setSendError(failure.message || 'Chưa gửi được tin nhắn.')
    } finally {
      setSending(false)
    }
  }

  async function retryMessage(message) {
    setSendError('')
    try {
      await onRetryMessage(message)
    } catch (failure) {
      setSendError(failure.message || 'Chưa gửi lại được tin nhắn.')
    }
  }

  const presenceLabel = peer?.isOnline ? 'Đang hoạt động'
    : peer?.lastSeenAt ? `Hoạt động ${new Date(peer.lastSeenAt).toLocaleString('vi-VN')}` : 'Ngoại tuyến'

  return (
    <section className="thread" aria-label={peer ? `Cuộc trò chuyện với ${peer.displayName}` : 'Nội dung trò chuyện'} aria-busy={loading}>
      <header className="thread-header">
        <button className="icon-btn back-btn" type="button" onClick={onBack} aria-label="Về danh sách cuộc trò chuyện">←</button>
        {peer ? <><Avatar person={{ id: peer.id, name: peer.displayName, online: peer.isOnline }} />
          <div className="thread-person"><h2 className="thread-name">{peer.displayName}</h2>
            <p className={`chat-connection-state${peer.isOnline ? ' connected' : ''}`}>
              @{peer.username} · {peerTyping ? 'Đang nhập…' : presenceLabel}
            </p>
          </div></> : <h2 className="thread-name">Trò chuyện</h2>}
      </header>

      {loading ? <div className="conversation-thread-body"><p role="status">Đang mở cuộc trò chuyện…</p></div>
        : error ? <div className="conversation-thread-body"><div role="alert"><p>{error}</p><button className="btn" type="button" onClick={onRetry}>Thử lại</button></div></div>
        : peer ? <>
          <div className="messages" ref={messageList} role="log" aria-live="polite" aria-busy={historyLoading}>
            {hasOlder && <button className="btn conversation-older" type="button" onClick={onLoadOlder} disabled={historyLoading}>Xem tin nhắn cũ hơn</button>}
            {historyLoading && !messages.length && <p className="conversation-feedback" role="status">Đang tải lịch sử…</p>}
            {historyError && <div className="conversation-feedback" role="alert"><p>{historyError}</p><button className="btn" type="button" onClick={onRetryHistory}>Thử lại</button></div>}
            {!historyLoading && !historyError && !messages.length && <div className="conversation-welcome conversation-welcome--messages">
              <Avatar person={{ id: peer.id, name: peer.displayName }} size="xl" />
              <h2>{peer.displayName}</h2><p>Chưa có tin nhắn. Bạn gửi lời chào đầu tiên nhé.</p>
            </div>}
            {messages.map(message => {
              const self = message.senderId === currentUserId
              return <div className={`msg${self ? ' self' : ''}`} key={`${message.senderId}:${message.clientMessageId}`}>
                {!self && <Avatar person={{ id: peer.id, name: peer.displayName }} size="sm" />}
                <div className="bubble-wrap">
                  <div className="bubble">{message.content}</div>
                  <div className="msg-meta">
                    <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
                    {message.sendState === 'sending' && <span>Đang gửi…</span>}
                    {message.sendState === 'failed' && <button className="message-retry" type="button" onClick={() => retryMessage(message)}>Gửi lại</button>}
                    {self && message.sendState !== 'sending' && message.sendState !== 'failed' &&
                      <span>{message.readAt ? 'Đã đọc' : message.deliveredAt ? 'Đã nhận' : 'Đã gửi'}</span>}
                  </div>
                </div>
              </div>
            })}
          </div>
          <form className="composer-wrap" onSubmit={submit}>
            {connectionError && <div className="composer-alert" role="alert">{connectionError} <button type="button" onClick={onReconnect}>Kết nối lại</button></div>}
            {sendError && <p className="composer-alert" role="alert">{sendError}</p>}
            <div className="composer">
              <textarea value={draft} onChange={event => {
                setDraft(event.target.value)
                onTypingChange(Boolean(event.target.value.trim()))
              }} maxLength={4000}
                disabled={peer.isDisabled || connectionState !== 'connected'}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
                placeholder={peer.isDisabled ? 'Tài khoản này hiện không khả dụng.' : connectionState === 'connected' ? `Nhắn gì đó cho ${peer.displayName}…` : 'Đang chờ kết nối tin nhắn…'} />
              <div className="composer-bottom"><span className="composer-count">{draft.length}/4000</span>
                <button className="send-btn" type="submit" disabled={!draft.trim() || sending || peer.isDisabled || connectionState !== 'connected'} aria-label="Gửi tin nhắn"><Icon name="send" /></button>
              </div>
            </div>
            <p className="composer-hint">Enter để gửi · Shift + Enter để xuống dòng</p>
          </form>
        </> : <div className="conversation-thread-body"><div className="conversation-welcome">
          <Icon name="chat" size="ico-lg" /><h2>Cùng nhau kết nối</h2>
          <p>Chọn một cuộc trò chuyện hoặc tìm người để bắt đầu.</p>
          <button className="btn btn--primary" type="button" onClick={onCreate}>Cuộc trò chuyện mới</button>
        </div></div>}
    </section>
  )
}

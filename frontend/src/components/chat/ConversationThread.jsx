import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import Avatar from '../Avatar.jsx'
import Icon from '../Icon.jsx'
import { textRouteLabel } from '../../services/textProtocol.js'
import FileMessageCard from './FileMessageCard.jsx'
import { chatTimeline, formatTimeDivider, shouldShowTimeDivider } from '../../utils/chatTimeline.js'
import { formatUserError } from '../../utils/errorMessage.js'
import '../../styles/file-messages.css'

// Hien timestamp server theo gio dia phuong cua trinh duyet voi dinh dang gio/phut tieng Viet.
function formatTime(value) {
  return new Date(value).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
}

// Ve thread, receipt, route va o soan tin; nhan callback xu ly nghiep vu tu ChatPage.
// Ban nhap nam trong component; key conversation o cha giup reset khi doi nguoi nhan.
export default function ConversationThread({ conversation, loading, error, messages,
  currentUserId, historyLoading, historyError, hasOlder, connectionState, connectionError,
  peerTyping, onTypingChange, onBack, onRetry, onRetryHistory, onLoadOlder, onSend,
  onRetryMessage, onReconnect, onCreate, onSendFile, sendWithEnter = true, textState, onAddContact,
  transfers = [], fileHistoryLoading, fileHistoryError, relayAvailable }) {
  const peer = conversation?.peer
  const hasPeer = Boolean(peer)
  const isStranger = conversation?.isContact === false
  const stageRef = useRef(null)
  const strangerRef = useRef(null)
  const composerWrapRef = useRef(null)
  const messageList = useRef(null)
  const draftInput = useRef(null)
  const scrollStateRef = useRef({ conversationId: null, firstKey: null, lastKey: null, scrollHeight: 0, scrollTop: 0 })
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const fileInput = useRef(null)
  const fileTransport = useRef('webrtc')
  const [sendingFile, setSendingFile] = useState(false)
  const [fileError, setFileError] = useState('')
  const timeline = chatTimeline(messages, transfers)
  const firstKey = timeline[0]?.key ?? null
  const lastKey = timeline.at(-1)?.key ?? null

  // Cuon xuong cuoi khi doi hoi thoai hoac co tin moi; giu nguyen vi tri khi nap them tin cu hon o dau danh sach.
  useLayoutEffect(() => {
    const list = messageList.current
    if (!list) return
    const previous = scrollStateRef.current
    const sameConversation = previous.conversationId === (conversation?.id ?? null)
    const prependedOlder = sameConversation && previous.firstKey && firstKey &&
      firstKey !== previous.firstKey && lastKey === previous.lastKey
    if (prependedOlder) {
      list.scrollTop = previous.scrollTop + (list.scrollHeight - previous.scrollHeight)
    } else {
      list.scrollTop = list.scrollHeight
    }
    scrollStateRef.current = {
      conversationId: conversation?.id ?? null,
      firstKey,
      lastKey,
      scrollHeight: list.scrollHeight,
      scrollTop: list.scrollTop,
    }
  }, [conversation?.id, timeline.length, firstKey, lastKey])

  // Do lai noi dung de o nhap tu gian khi go, dan chu va thu gon khi xoa hoac gui xong.
  useLayoutEffect(() => {
    const input = draftInput.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${input.scrollHeight}px`
  }, [draft, loading, error])

  // Xuong dong cung thay doi khi doi kich thuoc khung chat, ke ca ban nhap khong doi.
  useLayoutEffect(() => {
    const input = draftInput.current
    if (!input) return
    let previousWidth = input.clientWidth
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === previousWidth) return
      previousWidth = input.clientWidth
      input.style.height = 'auto'
      input.style.height = `${input.scrollHeight}px`
    })
    observer.observe(input)
    return () => observer.disconnect()
  }, [loading, error])

  // Dong bo khoang dem tren/duoi cua danh sach tin nhan theo chieu cao 2 thanh island noi.
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return undefined
    const syncOffsets = () => {
      const list = messageList.current
      const nearBottom = list ? (list.scrollHeight - list.scrollTop - list.clientHeight) < 28 : false
      const stranger = strangerRef.current
      const composer = composerWrapRef.current
      stage.style.setProperty('--stranger-offset', stranger ? `${stranger.offsetTop + stranger.offsetHeight - 6}px` : '0px')
      stage.style.setProperty('--composer-offset', composer ? `${composer.offsetHeight + 8}px` : '116px')
      if (list && nearBottom) list.scrollTop = list.scrollHeight
    }
    syncOffsets()
    const observer = new ResizeObserver(syncOffsets)
    if (strangerRef.current) observer.observe(strangerRef.current)
    if (composerWrapRef.current) observer.observe(composerWrapRef.current)
    return () => observer.disconnect()
  }, [loading, error, hasPeer, isStranger])

  // Chan submit rong/trung luc dang gui; chi xoa ban nhap sau khi callback gui thanh cong.
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
      setSendError(formatUserError(failure, 'Chưa gửi được tin nhắn.'))
    } finally {
      setSending(false)
    }
  }

  // Gui lai tin loi bang callback cua cha de tai su dung UUID, dong thoi hien loi neu tiep tuc that bai.
  async function retryMessage(message) {
    setSendError('')
    try {
      await onRetryMessage(message)
    } catch (failure) {
      setSendError(formatUserError(failure, 'Chưa gửi lại được tin nhắn.'))
    }
  }

  // Gui loi moi file cho dung nguoi dang chat, giu nguyen ban nhap va reset input de chon lai cung file.
  async function selectFile(event) {
    const file = event.target.files?.[0]
    const transport = fileTransport.current
    fileTransport.current = 'webrtc'
    event.target.value = ''
    if (!file || sendingFile) return
    setSendingFile(true)
    setFileError('')
    try {
      await onSendFile(file, transport)
    } catch (failure) {
      setFileError(formatUserError(failure, 'Chưa gửi được lời mời nhận tệp.'))
    } finally {
      setSendingFile(false)
    }
  }

  function chooseFile(transport) {
    fileTransport.current = transport
    fileInput.current?.click()
  }

  const presenceLabel = peer?.isOnline ? 'Đang hoạt động'
    : peer?.lastSeenAt ? `Hoạt động ${new Date(peer.lastSeenAt).toLocaleString('vi-VN')}` : 'Ngoại tuyến'

  return (
    <section className="thread" aria-label={peer ? `Cuộc trò chuyện với ${peer.displayName}` : 'Nội dung trò chuyện'} aria-busy={loading}>
      <header className="thread-header">
        <button className="icon-btn back-btn" type="button" onClick={onBack} aria-label="Về danh sách cuộc trò chuyện"><Icon name="back" size="ico-sm" /></button>
        {peer ? <><Avatar person={{ id: peer.id, name: peer.displayName, online: peer.isOnline }} />
          <div className="thread-person">
            <h2 className="thread-name" title={`@${peer.username}`}>{peer.displayName}</h2>
            <div className="thread-meta">
              <div className="thread-identity">
                {conversation.isContact === false && <span className="stranger-label">NGƯỜI LẠ</span>}
                <p className={`chat-connection-state${peer.isOnline ? ' connected' : ''}`} title={presenceLabel}>
                  {peerTyping ? 'Đang nhập…' : presenceLabel}
                </p>
              </div>
              <p className="text-route" role="status" data-route={textState?.route || 'signalr'}>
                {connectionState === 'connected' ? textRouteLabel(textState) : 'Đường truyền text đã ngắt'}
              </p>
            </div>
          </div></> : <h2 className="thread-name">Trò chuyện</h2>}
      </header>

      {loading ? <div className="conversation-thread-body"><p role="status">Đang mở cuộc trò chuyện…</p></div>
        : error ? <div className="conversation-thread-body"><div role="alert"><p>{error}</p><button className="btn" type="button" onClick={onRetry}>Thử lại</button></div></div>
        : peer ? <div className={`thread-stage${isStranger ? ' has-stranger' : ''}`} ref={stageRef}>
          {isStranger && <aside className="stranger-contact" ref={strangerRef} aria-label="Thêm liên hệ vào danh bạ"
            onWheel={event => { if (messageList.current) messageList.current.scrollTop += event.deltaY }}>
            <div className="stranger-contact-row">
              <Icon name="user-plus" />
              <p>Thêm vào danh bạ của bạn</p>
              <button className="stranger-contact-button" type="button" onClick={onAddContact}
                disabled={peer.isDisabled}>
                Thêm liên hệ
              </button>
            </div>
          </aside>}
          <div className="messages" ref={messageList} role="log" aria-live="polite" aria-busy={historyLoading || fileHistoryLoading}
            onScroll={() => {
              if (!messageList.current) return
              scrollStateRef.current.scrollTop = messageList.current.scrollTop
              scrollStateRef.current.scrollHeight = messageList.current.scrollHeight
            }}>
            {hasOlder && <button className="btn conversation-older" type="button" onClick={onLoadOlder} disabled={historyLoading || fileHistoryLoading}>Xem tin nhắn cũ hơn</button>}
            {historyLoading && !messages.length && <p className="conversation-feedback" role="status">Đang tải lịch sử…</p>}
            {historyError && <div className="conversation-feedback" role="alert"><p>{historyError}</p><button className="btn" type="button" onClick={onRetryHistory}>Thử lại</button></div>}
            {fileHistoryError && <div className="conversation-feedback" role="alert"><p>Chưa tải được lịch sử tệp: {fileHistoryError}</p><button className="btn" type="button" onClick={onRetryHistory}>Thử lại</button></div>}
            {fileHistoryLoading && !timeline.length && <p className="conversation-feedback" role="status">Đang tải lịch sử tệp…</p>}
            {!historyLoading && !fileHistoryLoading && !historyError && !fileHistoryError && !timeline.length && <div className="conversation-welcome conversation-welcome--messages">
              <Avatar person={{ id: peer.id, name: peer.displayName }} size="xl" />
              <h2>{peer.displayName}</h2><p>Chưa có tin nhắn. Bạn gửi lời chào đầu tiên nhé.</p>
            </div>}
            {timeline.map((entry, index) => {
              const divider = shouldShowTimeDivider(timeline[index - 1], entry) ? (
                <div className="time-divider" role="separator" aria-label={formatTimeDivider(entry.createdAt)}>
                  <time dateTime={entry.createdAt}>{formatTimeDivider(entry.createdAt)}</time>
                </div>
              ) : null
              if (entry.kind === 'file') {
                const transfer = entry.value
                const self = transfer.senderId === currentUserId
                return <Fragment key={entry.key}>
                  {divider}
                  <div className={`msg msg--file${self ? ' self' : ''}`}>
                    {!self && <Avatar person={{ id: peer.id, name: peer.displayName }} size="sm" />}
                    <div className="bubble-wrap"><FileMessageCard transfer={transfer} currentUserId={currentUserId} /></div>
                  </div>
                </Fragment>
              }
              const message = entry.value
              const self = message.senderId === currentUserId
              const isGrouped = (other) => other?.kind === 'text' &&
                other.value.senderId === message.senderId &&
                Math.abs(Date.parse(other.createdAt) - Date.parse(entry.createdAt)) < 180_000
              const samePrev = isGrouped(timeline[index - 1])
              const sameNext = isGrouped(timeline[index + 1])
              return <Fragment key={`${message.senderId}:${message.clientMessageId}`}>
                {divider}
                <div className={`msg${self ? ' self' : ''}${samePrev ? ' msg--cont-prev' : ''}${sameNext ? ' msg--cont-next' : ''}`}>
                  {!self && (sameNext
                    ? <span className="msg-avatar-space" aria-hidden="true" />
                    : <Avatar person={{ id: peer.id, name: peer.displayName }} size="sm" />)}
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
              </Fragment>
            })}
          </div>
          <form className="composer-wrap" ref={composerWrapRef} onSubmit={submit}>
            {connectionError && (
              <div className="composer-alert" role="alert">
                <Icon name="info" size="ico-sm" />
                <span className="composer-alert-text">{formatUserError(connectionError)}</span>
                <button className="composer-alert-action" type="button" onClick={onReconnect}>Kết nối lại</button>
              </div>
            )}
            {sendError && (
              <div className="composer-alert" role="alert">
                <Icon name="info" size="ico-sm" />
                <span className="composer-alert-text">{sendError}</span>
                <button className="composer-alert-close" type="button" onClick={() => setSendError('')} aria-label="Đóng thông báo lỗi">
                  <Icon name="close" size="ico-sm" />
                </button>
              </div>
            )}
            {fileError && (
              <div className="composer-alert" role="alert">
                <Icon name="info" size="ico-sm" />
                <span className="composer-alert-text">{fileError}</span>
                <button className="composer-alert-close" type="button" onClick={() => setFileError('')} aria-label="Đóng thông báo lỗi">
                  <Icon name="close" size="ico-sm" />
                </button>
              </div>
            )}
            {sendingFile && <p className="composer-file-notice" role="status">Đang chuẩn bị tệp…</p>}
            <div className="composer">
              <textarea ref={draftInput} rows={1} value={draft} onChange={event => {
                setDraft(event.target.value)
                onTypingChange(Boolean(event.target.value.trim()))
              }} maxLength={4000}
                disabled={peer.isDisabled || connectionState !== 'connected'}
                onKeyDown={event => {
                  if (sendWithEnter && event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
                placeholder={peer.isDisabled ? 'Tài khoản này hiện không khả dụng.' : connectionState === 'connected' ? `Nhắn gì đó cho ${peer.displayName}…` : 'Đang chờ kết nối tin nhắn…'} />
              <div className="composer-bottom">
                <div className="composer-file-tools">
                  <input ref={fileInput} type="file" hidden aria-label={`Chọn tệp gửi cho ${peer.displayName}`}
                    disabled={sendingFile || peer.isDisabled || (!relayAvailable && connectionState !== 'connected')}
                    onChange={selectFile} />
                  <button className="btn composer-file-button" type="button"
                    onClick={() => chooseFile('webrtc')}
                    disabled={sendingFile || peer.isDisabled || connectionState !== 'connected'}
                    aria-label={`Gửi file cho ${peer.displayName}`}>
                    <Icon name="paperclip" size="ico-sm" />{sendingFile ? 'Đang chuẩn bị…' : 'Gửi file'}
                  </button>
                  {relayAvailable && <button className="btn composer-file-button" type="button"
                    disabled={sendingFile || peer.isDisabled} onClick={() => chooseFile('https')}>
                    Gửi qua máy chủ
                  </button>}
                  {draft.length > 0 && (
                    <span className={`composer-count${draft.length >= 3600 ? ' warn' : ''}`}>{draft.length}/4000</span>
                  )}
                </div>
                <button className="send-btn" type="submit" disabled={!draft.trim() || sending || peer.isDisabled || connectionState !== 'connected'} aria-label="Gửi tin nhắn"><Icon name="send" /></button>
              </div>
            </div>
          </form>
        </div> : <div className="conversation-thread-body"><div className="conversation-welcome">
          <Icon name="chat" size="ico-lg" /><h2>Cùng nhau kết nối</h2>
          <p>Chọn một cuộc trò chuyện hoặc tìm người để bắt đầu.</p>
          <button className="btn btn--primary" type="button" onClick={onCreate}>Cuộc trò chuyện mới</button>
        </div></div>}
    </section>
  )
}

import { useLayoutEffect, useRef, useState } from 'react'
import Avatar from '../components/Avatar.jsx'
import Icon from '../components/Icon.jsx'
import { CONVERSATIONS, FILES, PEOPLE } from '../data/mockData.js'

function lastPreview(personId, messages) {
  const last = (messages[personId] || []).at(-1)
  if (!last) return 'Bắt đầu cuộc trò chuyện'
  if (last.fileId) return '📎 Tệp đính kèm'
  return `${last.self ? 'Bạn: ' : ''}${last.text.split('\n')[0]}`
}

function FileBubble({ fileId, onNavigate }) {
  const file = FILES.find((item) => item.id === fileId)
  if (!file) return null

  return (
    <div className="file-bubble">
      <div className="file-head">
        <span className={`file-thumb${file.type === 'PDF' ? ' file-thumb--pdf' : ''}`}><Icon name="file" /></span>
        <div><div className="file-name">{file.name}</div><div className="file-size">{file.size} · {file.type}</div></div>
      </div>
      <div className="file-foot">
        <span className="file-status-ok">Đã nhận · SHA-256 ✓</span>
        <button type="button" onClick={() => onNavigate('files')}>Tải xuống</button>
      </div>
    </div>
  )
}

function ConversationList({ filter, messages, onFilterChange, onQueryChange, onSelect, query, selectedId }) {
  const filtered = CONVERSATIONS.filter((conversation) => {
    const person = PEOPLE.find((item) => item.id === conversation.id)
    const matchesFilter = filter === 'all' || conversation.unread > 0
    return matchesFilter && person.name.toLowerCase().includes(query.toLowerCase())
  })

  return (
    <aside className="conv-list" aria-label="Cuộc trò chuyện">
      <div className="conv-list-header">
        <div className="conv-list-title"><h2>Trò chuyện</h2><button className="icon-btn" type="button" aria-label="Cuộc trò chuyện mới"><Icon name="edit" /></button></div>
        <label className="field-wrap"><Icon name="search" /><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Tìm kiếm…" aria-label="Tìm cuộc trò chuyện" /></label>
        <div className="tabs conv-tabs">
          <button className={`tab${filter === 'all' ? ' active' : ''}`} type="button" onClick={() => onFilterChange('all')}>Tất cả</button>
          <button className={`tab${filter === 'unread' ? ' active' : ''}`} type="button" onClick={() => onFilterChange('unread')}>Chưa đọc <span className="tab-count">2</span></button>
        </div>
      </div>
      <div className="conv-items">
        {filtered.map((conversation) => {
          const person = PEOPLE.find((item) => item.id === conversation.id)
          return (
            <button className={`conv-item${selectedId === person.id ? ' selected' : ''}`} type="button" key={person.id} onClick={() => onSelect(person.id)}>
              <Avatar person={person} size="sm" />
              <span className="conv-body">
                <span className="conv-row1"><span className="conv-name">{person.name.split(' ').slice(-2).join(' ')}</span><time className="conv-time">{conversation.time}</time></span>
                <span className="conv-preview">{lastPreview(person.id, messages)}</span>
              </span>
              {conversation.unread ? <span className="unread-badge">{conversation.unread}</span> : null}
            </button>
          )
        })}
      </div>
      <div className="conv-footer"><Icon name="chat" /> Dữ liệu mẫu · Không kết nối mạng</div>
    </aside>
  )
}

function ContactInfo({ onClose, onNavigate, person }) {
  const sharedFiles = FILES.filter((file) => file.owner === person.id)
  return (
    <aside className="info-panel" aria-label="Thông tin liên hệ">
      <div className="info-top"><button className="icon-btn" type="button" onClick={onClose} aria-label="Đóng"><Icon name="close" /></button></div>
      <div className="info-hero">
        <Avatar person={person} size="xl" />
        <div className="info-hero-name">{person.name}</div>
        <div className="info-hero-sub">@{person.username}</div>
        <div className="info-quick">
          <button className="info-quick-btn" type="button"><span className="info-quick-icon"><Icon name="phone" size="ico-sm" /></span>Gọi thoại</button>
          <button className="info-quick-btn" type="button"><span className="info-quick-icon"><Icon name="search" size="ico-sm" /></span>Tìm kiếm</button>
          <button className="info-quick-btn" type="button"><span className="info-quick-icon"><Icon name="paperclip" size="ico-sm" /></span>Gửi file</button>
        </div>
      </div>
      <div className="info-section">
        <div className="info-section-title">Chi tiết</div>
        <div className="info-kv">Tên đầy đủ<strong>{person.name}</strong></div>
        <div className="info-kv">Trạng thái<strong>{person.online ? 'Đang hoạt động' : 'Ngoại tuyến'}</strong></div>
        <div className="info-kv">Vai trò<strong>{person.role}</strong></div>
      </div>
      <div className="info-section">
        <div className="info-section-title">Tệp đã chia sẻ<button type="button" onClick={() => onNavigate('files')}>Xem tất cả</button></div>
        {sharedFiles.map((file) => <div className="info-file" key={file.id}><span className="file-thumb"><Icon name="file" size="ico-sm" /></span><div><div className="file-name">{file.name}</div><div className="file-size">{file.size}</div></div></div>)}
      </div>
    </aside>
  )
}

function ChatPage({ messages, onNavigate, onSelect, onSend, selectedId }) {
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [showInfo, setShowInfo] = useState(() => window.innerWidth >= 1100)
  const messagesRef = useRef(null)
  const person = PEOPLE.find((item) => item.id === selectedId) || PEOPLE[0]
  const conversationMessages = messages[selectedId] || []

  useLayoutEffect(() => {
    const messageList = messagesRef.current
    if (messageList) messageList.scrollTop = messageList.scrollHeight
  }, [selectedId, conversationMessages.length])

  function submitMessage(event) {
    event.preventDefault()
    const content = draft.trim()
    if (!content) return
    onSend(content)
    setDraft('')
  }

  return (
    <div className={`chat-layout${showInfo ? ' show-info' : ''}`}>
      <ConversationList filter={filter} messages={messages} onFilterChange={setFilter} onQueryChange={setQuery} onSelect={onSelect} query={query} selectedId={selectedId} />
      <section className="thread" aria-label={`Cuộc trò chuyện với ${person.name}`}>
        <header className="thread-header">
          <Avatar person={person} />
          <div className="thread-person"><div className="thread-name">{person.name}</div><div className={`thread-status${person.online ? '' : ' offline'}`}><span className="status-dot" />{person.online ? 'Đang hoạt động' : 'Hoạt động hôm qua'}</div></div>
          <div className="thread-actions">
            <button className="btn" type="button"><Icon name="phone" size="ico-sm" /><span>Gọi thoại</span></button>
            <button className={`icon-btn${showInfo ? ' active' : ''}`} type="button" onClick={() => setShowInfo((current) => !current)} aria-label="Thông tin"><Icon name="info" /></button>
          </div>
        </header>
        <div className="messages" ref={messagesRef} role="log" aria-live="polite">
          <div className="date-chip"><span>Hôm nay</span></div>
          {conversationMessages.map((message) => (
            <div className={`msg${message.self ? ' self' : ''}`} key={message.id}>
              {!message.self ? <Avatar person={person} size="sm" /> : null}
              <div className="bubble-wrap">
                {message.fileId ? <FileBubble fileId={message.fileId} onNavigate={onNavigate} /> : <div className="bubble">{message.text}</div>}
                <div className="msg-meta"><time>{message.time}</time>{message.self ? <><Icon name="check" size="ico-sm" /><span>Đã đọc</span></> : null}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="composer-wrap">
          <form className="composer" onSubmit={submitMessage}>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="Soạn tin nhắn" placeholder={`Nhắn gì đó cho ${person.name.split(' ').at(-1)}…`} />
            <div className="composer-bottom"><div className="composer-tools"><button className="icon-btn" type="button" aria-label="Đính kèm file"><Icon name="paperclip" /></button><button className="icon-btn" type="button" aria-label="Biểu tượng cảm xúc"><Icon name="smile" /></button></div><button className="send-btn" type="submit" aria-label="Gửi"><Icon name="send" /></button></div>
          </form>
          <div className="composer-hint">Enter để gửi · Shift + Enter để xuống dòng</div>
        </div>
      </section>
      {showInfo ? <ContactInfo onClose={() => setShowInfo(false)} onNavigate={onNavigate} person={person} /> : null}
    </div>
  )
}

export default ChatPage

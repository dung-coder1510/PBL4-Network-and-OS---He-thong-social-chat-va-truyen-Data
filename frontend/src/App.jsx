import { useEffect, useState } from 'react'
import './App.css'

const NAV_ITEMS = [
  ['chat', 'Trò chuyện'],
  ['contacts', 'Danh bạ'],
  ['calls', 'Cuộc gọi'],
  ['files', 'Tệp'],
  ['admin', 'Quản trị'],
  ['settings', 'Cài đặt'],
]

const PEOPLE = [
  { id: 1, name: 'Nguyễn Hoàng Dũng', shortName: 'Hoàng Dũng', initials: 'HD', online: true, preview: 'Oke, 14h nha. Mình xem lại phần giao diện.', time: '10:42' },
  { id: 2, name: 'Nguyễn Hoàng Duy', shortName: 'Hoàng Duy', initials: 'HD', online: true, preview: 'Bạn xem giúp mình các mốc triển khai nha.', time: '10:30', unread: 2 },
  { id: 3, name: 'Trần Minh Anh', shortName: 'Minh Anh', initials: 'MA', online: false, preview: 'Mình sẽ xem tài liệu tối nay.', time: 'Hôm qua', unread: 1 },
  { id: 4, name: 'Lê Khánh Linh', shortName: 'Khánh Linh', initials: 'KL', online: false, preview: 'Mình đã gửi bản đề cương rồi nhé.', time: 'Thứ sáu' },
]

const INITIAL_MESSAGES = {
  1: [
    { id: 1, mine: false, text: 'Trung ơi, mình gửi lại phần thiết kế cơ sở dữ liệu nha.', time: '10:35' },
    { id: 2, mine: false, file: 'Thiet_ke_CSDL.pdf', meta: '1.8 MB · PDF', time: '10:36' },
    { id: 3, mine: true, text: 'Mình nhận được rồi. Phần UserAID và UserBID nhìn rõ hơn đó.', time: '10:38' },
    { id: 4, mine: false, text: 'Ừ, mình cũng bổ sung phần nhật ký cho Admin rồi.', time: '10:40' },
  ],
  2: [
    { id: 1, mine: false, text: 'Mình vừa cập nhật phần báo cáo tiến độ trên Sheet.', time: '10:28' },
    { id: 2, mine: false, text: 'Bạn xem giúp mình các mốc triển khai nha.', time: '10:30' },
  ],
  3: [{ id: 1, mine: false, text: 'Cảm ơn bạn, mình sẽ xem tài liệu tối nay.', time: 'Hôm qua' }],
  4: [{ id: 1, mine: true, text: 'Mình đã gửi bản đề cương qua đây rồi nhé.', time: 'Thứ sáu' }],
}

const PAGE_META = {
  contacts: ['Danh bạ', 'Những người bạn thường xuyên kết nối.'],
  calls: ['Cuộc gọi', 'Lịch sử gọi thoại gần đây.'],
  files: ['Tệp đã chia sẻ', 'Theo dõi các phiên truyền tệp P2P.'],
  admin: ['Quản trị hệ thống', 'Quản lý tài khoản và xem nhật ký thao tác.'],
  settings: ['Cài đặt', 'Điều chỉnh không gian theo cách của bạn.'],
}

function Avatar({ person, small = false }) {
  return (
    <span className={`avatar ${small ? 'avatar-small' : ''}`} aria-hidden="true">
      {person.initials}
      {person.online ? <span className="presence" /> : null}
    </span>
  )
}

function App() {
  const [page, setPage] = useState('chat')
  const [selectedId, setSelectedId] = useState(1)
  const [messages, setMessages] = useState(INITIAL_MESSAGES)
  const [draft, setDraft] = useState('')
  const [theme, setTheme] = useState(() => localStorage.getItem('noi-theme') || 'light')

  const selected = PEOPLE.find((person) => person.id === selectedId) ?? PEOPLE[0]

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('noi-theme', theme)
  }, [theme])

  function sendMessage(event) {
    event.preventDefault()
    const content = draft.trim()
    if (!content) return

    setMessages((current) => ({
      ...current,
      [selectedId]: [
        ...(current[selectedId] ?? []),
        { id: Date.now(), mine: true, text: content, time: 'Bây giờ' },
      ],
    }))
    setDraft('')
  }

  function openConversation(id) {
    setSelectedId(id)
    setPage('chat')
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => setPage('chat')} aria-label="Về trò chuyện">
          <span className="brand-mark">n</span>
          <span>Nối.</span>
        </button>
        <div className="breadcrumb">Không gian cá nhân <span>/</span> {page === 'chat' ? 'Trò chuyện' : PAGE_META[page][0]}</div>
        <div className="topbar-end">
          <span className="sample-label">Dữ liệu mẫu</span>
          <span className="profile">TT</span>
        </div>
      </header>

      <aside className="rail" aria-label="Điều hướng chính">
        {NAV_ITEMS.map(([key, label]) => (
          <button
            className={page === key ? 'nav-item active' : 'nav-item'}
            type="button"
            key={key}
            onClick={() => setPage(key)}
          >
            <span className="nav-symbol" aria-hidden="true">{label.slice(0, 1)}</span>
            <span>{label}</span>
          </button>
        ))}
      </aside>

      <main className="main-content">
        {page === 'chat' ? (
          <ChatPage
            draft={draft}
            messages={messages[selectedId] ?? []}
            onDraftChange={setDraft}
            onSelect={setSelectedId}
            onSend={sendMessage}
            selected={selected}
            selectedId={selectedId}
          />
        ) : (
          <SecondaryPage page={page} onOpenConversation={openConversation} theme={theme} onThemeChange={setTheme} />
        )}
      </main>
    </div>
  )
}

function ChatPage({ draft, messages, onDraftChange, onSelect, onSend, selected, selectedId }) {
  return (
    <div className="chat-layout">
      <section className="conversation-list" aria-label="Danh sách cuộc trò chuyện">
        <div className="section-heading">
          <div>
            <h1>Trò chuyện</h1>
            <p>{PEOPLE.filter((person) => person.unread).length} cuộc trò chuyện chưa đọc</p>
          </div>
          <button className="square-button" type="button" aria-label="Cuộc trò chuyện mới">＋</button>
        </div>
        <label className="search-box">
          <span aria-hidden="true">⌕</span>
          <input type="search" placeholder="Tìm cuộc trò chuyện" />
        </label>
        <div className="conversation-items">
          {PEOPLE.map((person) => (
            <button
              className={selectedId === person.id ? 'conversation active' : 'conversation'}
              type="button"
              key={person.id}
              onClick={() => onSelect(person.id)}
            >
              <Avatar person={person} />
              <span className="conversation-copy">
                <span className="conversation-name">{person.shortName}<time>{person.time}</time></span>
                <span className="conversation-preview">{person.preview}</span>
              </span>
              {person.unread ? <span className="unread">{person.unread}</span> : null}
            </button>
          ))}
        </div>
      </section>

      <section className="thread" aria-label={`Cuộc trò chuyện với ${selected.name}`}>
        <header className="thread-header">
          <Avatar person={selected} small />
          <div>
            <strong>{selected.name}</strong>
            <p className={selected.online ? 'online' : ''}>{selected.online ? 'Đang hoạt động' : 'Ngoại tuyến'}</p>
          </div>
          <div className="thread-actions">
            <button className="outline-button" type="button">Gọi thoại</button>
            <button className="square-button" type="button" aria-label="Thông tin cuộc trò chuyện">ⓘ</button>
          </div>
        </header>

        <div className="message-list" aria-live="polite">
          <div className="date-divider"><span>Hôm nay</span></div>
          {messages.map((message) => (
            <article className={message.mine ? 'message mine' : 'message'} key={message.id}>
              {message.file ? (
                <div className="file-message">
                  <span className="file-mark">PDF</span>
                  <div><strong>{message.file}</strong><small>{message.meta}</small></div>
                  <button type="button">Tải xuống</button>
                </div>
              ) : (
                <p>{message.text}</p>
              )}
              <small>{message.time}{message.mine ? ' · Đã gửi' : ''}</small>
            </article>
          ))}
        </div>

        <form className="composer" onSubmit={onSend}>
          <textarea
            aria-label="Soạn tin nhắn"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder={`Nhắn gì đó cho ${selected.shortName.split(' ').at(-1)}…`}
          />
          <div className="composer-actions">
            <button type="button" aria-label="Đính kèm tệp">＋</button>
            <span>Enter để gửi</span>
            <button className="send-button" type="submit" aria-label="Gửi tin nhắn">Gửi</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function SecondaryPage({ page, onOpenConversation, theme, onThemeChange }) {
  const [title, description] = PAGE_META[page]

  return (
    <section className="page">
      <div className="page-heading"><h1>{title}</h1><p>{description}</p></div>
      {page === 'contacts' ? <Contacts onOpenConversation={onOpenConversation} /> : null}
      {page === 'calls' ? <SimpleTable columns={['Người liên hệ', 'Thời gian', 'Trạng thái']} rows={[[PEOPLE[0].name, 'Hôm qua, 15:30', '12 phút 34 giây'], [PEOPLE[1].name, 'Hôm qua, 10:15', '8 phút 12 giây'], [PEOPLE[2].name, '19/09, 09:40', 'Cuộc gọi nhỡ']]} /> : null}
      {page === 'files' ? <SimpleTable columns={['Tên tệp', 'Người liên hệ', 'Trạng thái']} rows={[["Thiet_ke_CSDL.pdf", PEOPLE[0].name, 'Hoàn tất'], ['Bao_cao_PBL4.docx', PEOPLE[1].name, 'Hoàn tất'], ['Tai_lieu_tham_khao.zip', PEOPLE[2].name, 'Đã hủy']]} /> : null}
      {page === 'admin' ? <AdminPage /> : null}
      {page === 'settings' ? <Settings theme={theme} onThemeChange={onThemeChange} /> : null}
    </section>
  )
}

function Contacts({ onOpenConversation }) {
  return <div className="card-grid">{PEOPLE.map((person) => <article className="contact-card" key={person.id}><Avatar person={person} /><div><h2>{person.name}</h2><p>{person.online ? 'Đang hoạt động' : 'Ngoại tuyến'}</p></div><button className="outline-button" type="button" onClick={() => onOpenConversation(person.id)}>Nhắn tin</button></article>)}</div>
}

function SimpleTable({ columns, rows }) {
  return <div className="table-wrap"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.join('-')}>{row.map((cell) => <td key={cell}>{cell}</td>)}</tr>)}</tbody></table></div>
}

function AdminPage() {
  return <><div className="stats"><div><span>Tổng tài khoản</span><strong>7</strong></div><div><span>Đang hoạt động</span><strong>6</strong></div><div><span>Bị khóa</span><strong>1</strong></div></div><SimpleTable columns={['Tài khoản', 'Vai trò', 'Trạng thái']} rows={[["Nguyễn Thành Trung", 'Admin', 'Hoạt động'], [PEOPLE[0].name, 'User', 'Hoạt động'], [PEOPLE[1].name, 'User', 'Hoạt động'], ['Tài khoản thử nghiệm', 'User', 'Bị khóa']]} /><p className="page-note">Bản giao diện chỉ hiển thị dữ liệu mẫu. Thao tác khóa/mở sẽ được nối API sau.</p></>
}

function Settings({ theme, onThemeChange }) {
  return <div className="settings-card"><h2>Chủ đề giao diện</h2><p>Ưu tiên nền sáng và có thể chuyển sang nền tối khi cần.</p><div className="theme-options"><button type="button" className={theme === 'light' ? 'theme-choice selected' : 'theme-choice'} onClick={() => onThemeChange('light')} aria-pressed={theme === 'light'}><span className="theme-preview light-preview"><i /><i /></span><strong>Sáng</strong></button><button type="button" className={theme === 'dark' ? 'theme-choice selected' : 'theme-choice'} onClick={() => onThemeChange('dark')} aria-pressed={theme === 'dark'}><span className="theme-preview dark-preview"><i /><i /></span><strong>Tối</strong></button></div></div>
}

export default App

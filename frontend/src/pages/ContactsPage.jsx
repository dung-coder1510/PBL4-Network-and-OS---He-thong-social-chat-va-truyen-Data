import { useState } from 'react'
import Avatar from '../components/Avatar.jsx'
import Icon from '../components/Icon.jsx'
import { PEOPLE } from '../data/mockData.js'

function ContactsPage({ onNotify, onOpenConversation }) {
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const contacts = PEOPLE.filter((person) => !person.disabled)
  const filtered = contacts.filter((person) => {
    const matchesQuery = `${person.name}${person.username}`.toLowerCase().includes(query.toLowerCase())
    const matchesFilter = filter === 'all' || (filter === 'online' && person.online) || (filter === 'offline' && !person.online)
    return matchesQuery && matchesFilter
  })

  return (
    <div className="page">
      <div className="page-header"><div><h1>Danh bạ</h1><p>Kết nối trực tiếp và trao đổi thông tin ngang hàng P2P.</p></div><button className="btn btn--primary" type="button" onClick={() => onNotify('Form thêm liên hệ sẽ được nối API sau.')}><Icon name="plus" size="ico-sm" />Thêm liên hệ</button></div>
      <div className="page-toolbar">
        <div className="tabs">
          <button className={`tab${filter === 'all' ? ' active' : ''}`} type="button" onClick={() => setFilter('all')}>Tất cả <span className="tab-count">{contacts.length}</span></button>
          <button className={`tab${filter === 'online' ? ' active' : ''}`} type="button" onClick={() => setFilter('online')}>Đang hoạt động <span className="tab-count">{contacts.filter((person) => person.online).length}</span></button>
          <button className={`tab${filter === 'offline' ? ' active' : ''}`} type="button" onClick={() => setFilter('offline')}>Ngoại tuyến <span className="tab-count">{contacts.filter((person) => !person.online).length}</span></button>
        </div>
        <label className="field-wrap contact-search"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm theo tên, @username…" aria-label="Tìm liên hệ" /></label>
      </div>
      <div className="contact-list-wrap">
        {filtered.map((person) => (
          <div className="contact-list-item" key={person.id}>
            <div className="contact-info-col"><Avatar person={person} size="sm" /><div className="contact-meta"><div className="contact-meta-header"><span className="contact-name">{person.name}</span></div><span className="contact-uname">@{person.username}</span></div></div>
            <div className="contact-status-col"><span className={`contact-status-pill${person.online ? ' online' : ''}`}><span className={`status-dot${person.online ? '' : ' offline'}`} />{person.online ? 'Đang hoạt động' : 'Ngoại tuyến'}</span><span className="dev-tag p2p-tag">P2P SẴN SÀNG</span></div>
            <div className="contact-actions-col"><button className="btn btn--primary" type="button" onClick={() => onOpenConversation(person.id)}><Icon name="chat" size="ico-sm" />Nhắn tin</button><button className="btn btn--ghost" type="button" onClick={() => onNotify(`Đang mô phỏng gọi ${person.name}.`)}><Icon name="phone" size="ico-sm" />Gọi</button></div>
          </div>
        ))}
        {!filtered.length ? <div className="empty"><Icon name="users" /><p>Không tìm thấy người liên hệ nào.</p></div> : null}
      </div>
    </div>
  )
}

export default ContactsPage

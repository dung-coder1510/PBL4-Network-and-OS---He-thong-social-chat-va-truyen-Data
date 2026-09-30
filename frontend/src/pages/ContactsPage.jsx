import { useEffect, useMemo, useState } from 'react'
import Avatar from '../components/Avatar.jsx'
import Icon from '../components/Icon.jsx'
import AddContactDialog from '../components/contacts/AddContactDialog.jsx'
import { contactsApi } from '../services/contactsApi.js'
import { conversationsApi } from '../services/conversationsApi.js'
import {
  acknowledgeDelivered, createChatConnection, listenForMessages, listenForPresence,
  startChatConnection, stopChatConnection,
} from '../services/chatConnection.js'

function activityLabel(user) {
  if (user.isOnline) return 'Đang hoạt động'
  if (!user.lastSeenAt) return 'Ngoại tuyến'
  return `Hoạt động ${new Date(user.lastSeenAt).toLocaleString('vi-VN')}`
}

export default function ContactsPage({ token, userId, onSessionExpired, onOpenConversation }) {
  const [contacts, setContacts] = useState([])
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [alias, setAlias] = useState('')
  const [busyId, setBusyId] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    contactsApi.list(token, controller.signal).then(setContacts).catch(failure => {
      if (controller.signal.aborted) return
      if (failure.status === 401) onSessionExpired()
      else setError(failure.message)
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [token, onSessionExpired])

  useEffect(() => {
    const connection = createChatConnection(token)
    const removePresence = listenForPresence(connection, presence => {
      setContacts(current => current.map(contact => contact.user.id === presence.userId
        ? { ...contact, user: { ...contact.user, ...presence } } : contact))
    })
    const removeMessages = listenForMessages(connection, message => {
      if (message.senderId !== userId)
        void acknowledgeDelivered(connection, message.conversationId, message.id).catch(() => {})
    })
    void startChatConnection(connection).catch(() => {})
    return () => { removePresence(); removeMessages(); void stopChatConnection(connection) }
  }, [token, userId])

  const filtered = useMemo(() => contacts.filter(contact => {
    const name = contact.alias || contact.user.displayName
    const matchesQuery = `${name}${contact.user.displayName}${contact.user.username}`
      .toLowerCase().includes(query.trim().toLowerCase())
    const matchesFilter = filter === 'all' ||
      (filter === 'online' && contact.user.isOnline) ||
      (filter === 'offline' && !contact.user.isOnline)
    return matchesQuery && matchesFilter
  }), [contacts, filter, query])
  const existingIds = useMemo(() => new Set(contacts.map(contact => contact.user.id)), [contacts])

  async function openConversation(contact) {
    setBusyId(contact.user.id)
    setError('')
    try {
      const conversation = await conversationsApi.create(token, contact.user.id)
      onOpenConversation(conversation.id)
    } catch (failure) {
      if (failure.status === 401) onSessionExpired()
      else setError(failure.message)
    } finally {
      setBusyId(null)
    }
  }

  async function saveAlias(contact) {
    setBusyId(contact.user.id)
    setError('')
    try {
      const updated = await contactsApi.update(token, contact.user.id, alias.trim())
      setContacts(current => current.map(item =>
        item.user.id === contact.user.id ? updated : item))
      setEditingId(null)
    } catch (failure) {
      if (failure.status === 401) onSessionExpired()
      else setError(failure.message)
    } finally {
      setBusyId(null)
    }
  }

  async function remove(contact) {
    setBusyId(contact.user.id)
    setError('')
    try {
      await contactsApi.remove(token, contact.user.id)
      setContacts(current => current.filter(item => item.user.id !== contact.user.id))
    } catch (failure) {
      if (failure.status === 401) onSessionExpired()
      else setError(failure.message)
    } finally {
      setBusyId(null)
    }
  }

  const onlineCount = contacts.filter(contact => contact.user.isOnline).length
  return (
    <div className="page">
      <div className="page-header"><div><h1>Danh bạ</h1>
        <p>Danh sách liên hệ một chiều của tài khoản.</p></div>
        <button className="btn btn--primary" type="button" onClick={() => setShowAdd(true)}>
          <Icon name="plus" size="ico-sm" />Thêm liên hệ
        </button>
      </div>
      <div className="page-toolbar">
        <div className="tabs">
          <button className={`tab${filter === 'all' ? ' active' : ''}`} type="button"
            onClick={() => setFilter('all')}>Tất cả <span className="tab-count">{contacts.length}</span></button>
          <button className={`tab${filter === 'online' ? ' active' : ''}`} type="button"
            onClick={() => setFilter('online')}>Đang hoạt động <span className="tab-count">{onlineCount}</span></button>
          <button className={`tab${filter === 'offline' ? ' active' : ''}`} type="button"
            onClick={() => setFilter('offline')}>Ngoại tuyến <span className="tab-count">{contacts.length - onlineCount}</span></button>
        </div>
        <label className="field-wrap contact-search"><Icon name="search" />
          <input value={query} onChange={event => setQuery(event.target.value)}
            placeholder="Tìm theo tên, @username…" aria-label="Tìm liên hệ" />
        </label>
      </div>
      {error && <p className="conversation-feedback" role="alert">{error}</p>}
      <div className="contact-list-wrap" aria-busy={loading}>
        {loading && <p className="conversation-feedback" role="status">Đang tải danh bạ…</p>}
        {!loading && filtered.map(contact => {
          const editing = editingId === contact.user.id
          return <div className="contact-list-item" key={contact.user.id}>
            <div className="contact-info-col">
              <Avatar person={{ id: contact.user.id, name: contact.user.displayName,
                online: contact.user.isOnline }} size="sm" />
              <div className="contact-meta">
                {editing ? <div className="contact-alias-editor">
                  <input value={alias} onChange={event => setAlias(event.target.value)}
                    maxLength={100} aria-label={`Tên gợi nhớ cho ${contact.user.displayName}`} />
                  <button className="btn btn--primary" type="button"
                    onClick={() => saveAlias(contact)} disabled={busyId === contact.user.id}>Lưu</button>
                  <button className="btn" type="button" onClick={() => setEditingId(null)}>Hủy</button>
                </div> : <div className="contact-meta-header">
                  <span className="contact-name">{contact.alias || contact.user.displayName}</span>
                </div>}
                <span className="contact-uname">{contact.alias ? `${contact.user.displayName} · ` : ''}@{contact.user.username}</span>
              </div>
            </div>
            <div className="contact-status-col">
              <span className={`contact-status-pill${contact.user.isOnline ? ' online' : ''}`}>
                <span className={`status-dot${contact.user.isOnline ? '' : ' offline'}`} />
                {activityLabel(contact.user)}
              </span>
            </div>
            <div className="contact-actions-col">
              <button className="btn btn--primary" type="button"
                onClick={() => openConversation(contact)} disabled={busyId === contact.user.id}>
                <Icon name="chat" size="ico-sm" /><span>Nhắn tin</span>
              </button>
              <button className="btn" type="button" disabled={busyId === contact.user.id}
                onClick={() => { setEditingId(contact.user.id); setAlias(contact.alias || '') }}>
                Đổi tên
              </button>
              <button className="btn btn--ghost" type="button" disabled={busyId === contact.user.id}
                onClick={() => remove(contact)}>Xóa</button>
            </div>
          </div>
        })}
        {!loading && !filtered.length && <div className="empty"><Icon name="users" />
          <p>{contacts.length ? 'Không tìm thấy liên hệ phù hợp.' : 'Bạn chưa có liên hệ nào.'}</p>
        </div>}
      </div>
      {showAdd && <AddContactDialog token={token}
        existingIds={existingIds}
        onClose={() => setShowAdd(false)} onSessionExpired={onSessionExpired}
        onAdded={contact => { setContacts(current => [...current, contact]); setShowAdd(false) }} />}
    </div>
  )
}

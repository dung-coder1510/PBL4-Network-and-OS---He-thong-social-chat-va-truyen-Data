import { useEffect, useRef, useState } from 'react'
import Avatar from '../Avatar.jsx'
import Icon from '../Icon.jsx'
import { conversationsApi } from '../../services/conversationsApi.js'

export default function NewConversationDialog({ token, onClose, onCreated, onSessionExpired }) {
  const dialog = useRef(null)
  const searchInput = useRef(null)
  const createRequest = useRef(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const element = dialog.current
    element.showModal()
    searchInput.current?.focus()
    return () => { element.close(); createRequest.current?.abort() }
  }, [])

  // Debounce và hủy kết quả cũ để tìm nhanh không bị ghi đè bởi request chậm.
  useEffect(() => {
    const controller = new AbortController()
    const term = query.trim()
    if (term.length < 2) return () => controller.abort()
    const timer = setTimeout(async () => {
      try {
        const users = await conversationsApi.searchUsers(token, term, controller.signal)
        if (!controller.signal.aborted) setResults(users)
      } catch (failure) {
        if (!controller.signal.aborted) {
          if (failure.status === 401) onSessionExpired()
          else setError(failure.message)
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 300)
    return () => { clearTimeout(timer); controller.abort() }
  }, [token, query, revision, onSessionExpired])

  function search(value) {
    setQuery(value)
    setResults([])
    setSelected(null)
    setError('')
    setLoading(value.trim().length >= 2)
  }
  function retrySearch() {
    search(query)
    setRevision(value => value + 1)
  }

  async function create(event) {
    event.preventDefault()
    if (!selected || createRequest.current) return
    const controller = new AbortController()
    createRequest.current = controller
    setBusy(true)
    setError('')
    try {
      const conversation = await conversationsApi.create(token, selected.id, controller.signal)
      if (!controller.signal.aborted) onCreated(conversation)
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (failure.status === 401) onSessionExpired()
        else setError(failure.message)
      }
    } finally {
      createRequest.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return (
    <dialog className="new-conversation-dialog" ref={dialog} aria-labelledby="new-conversation-title"
      onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
      <form onSubmit={create} aria-busy={busy}>
        <header className="new-conversation-heading"><h2 id="new-conversation-title">Cuộc trò chuyện mới</h2>
          <button className="icon-btn" type="button" onClick={onClose} disabled={busy} aria-label="Đóng tìm người"><Icon name="close" /></button>
        </header>
        <p>Tìm người bằng tên đăng nhập hoặc tên hiển thị.</p>
        <label className="field-wrap"><Icon name="search" />
          <input ref={searchInput} value={query} onChange={e => search(e.target.value)} maxLength={100}
            disabled={busy} placeholder="Nhập ít nhất 2 ký tự…" aria-label="Tìm người để trò chuyện" />
        </label>
        <div className="conversation-search-results" aria-busy={loading}>
          {loading && <p role="status">Đang tìm người dùng…</p>}
          {error && <div role="alert"><p>{error}</p><button className="btn" type="button" disabled={busy} onClick={retrySearch}>Tìm lại</button></div>}
          {!loading && !error && query.trim().length < 2 && <p>Nhập tên người bạn muốn trò chuyện.</p>}
          {!loading && !error && query.trim().length >= 2 && !results.length && <p>Không tìm thấy người dùng phù hợp.</p>}
          {results.map(person => (
            <button className={`conversation-person${selected?.id === person.id ? ' selected' : ''}`}
              type="button" key={person.id} disabled={busy} aria-pressed={selected?.id === person.id}
              onClick={() => setSelected(person)}>
              <Avatar person={{ id: person.id, name: person.displayName }} />
              <span><strong>{person.displayName}</strong><small>@{person.username}</small></span>
              {selected?.id === person.id && <Icon name="check" />}
            </button>
          ))}
          {results.length === 20 && <p>Đang hiển thị 20 kết quả. Nhập tên cụ thể hơn để tìm tiếp.</p>}
        </div>
        <footer className="new-conversation-actions">
          <button className="btn" type="button" disabled={busy} onClick={onClose}>Hủy</button>
          <button className="btn btn--primary" type="submit" disabled={!selected || busy || loading}>{busy ? 'Đang mở…' : 'Bắt đầu trò chuyện'}</button>
        </footer>
      </form>
    </dialog>
  )
}

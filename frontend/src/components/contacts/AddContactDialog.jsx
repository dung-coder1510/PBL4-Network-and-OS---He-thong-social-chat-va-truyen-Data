import { useEffect, useRef, useState } from 'react'
import Avatar from '../Avatar.jsx'
import Icon from '../Icon.jsx'
import { contactsApi } from '../../services/contactsApi.js'

// Co person thi xac nhan lien he dang chat; khong co thi giu luong tim nguoi trong Danh ba.
export default function AddContactDialog({ token, existingIds, person, onClose, onAdded,
  onSessionExpired }) {
  const dialog = useRef(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [selected, setSelected] = useState(person || null)
  const [alias, setAlias] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const element = dialog.current
    element.showModal()
    element.querySelector('input')?.focus()
    return () => element.close()
  }, [])

  useEffect(() => {
    if (person) return undefined
    const controller = new AbortController()
    const term = query.trim()
    if (term.length < 2) return () => controller.abort()
    const timer = setTimeout(() => {
      contactsApi.searchUsers(token, term, controller.signal).then(users => {
        if (!controller.signal.aborted)
          setResults(users.filter(user => !existingIds.has(user.id)))
      }).catch(failure => {
        if (controller.signal.aborted) return
        if (failure.status === 401) onSessionExpired()
        else setError(failure.message)
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    }, 300)
    return () => { clearTimeout(timer); controller.abort() }
  }, [token, query, existingIds, onSessionExpired, person])

  // Chi luu sau khi xac nhan; loi API giu nguyen ten goi nho de thu lai.
  async function submit(event) {
    event.preventDefault()
    if (!selected || busy) return
    setBusy(true)
    setError('')
    try {
      onAdded(await contactsApi.create(token, selected.id, alias.trim()))
    } catch (failure) {
      if (failure.status === 401) onSessionExpired()
      else setError(failure.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog className="new-conversation-dialog" ref={dialog} aria-labelledby="add-contact-title"
      onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
      <form onSubmit={submit} aria-busy={busy}>
        <header className="new-conversation-heading">
          <h2 id="add-contact-title">{person ? 'Thêm vào danh bạ' : 'Thêm liên hệ'}</h2>
          <button className="icon-btn" type="button" onClick={onClose} disabled={busy}
            aria-label="Đóng thêm liên hệ"><Icon name="close" /></button>
        </header>
        {person ? <div className="contact-dialog-person">
          <Avatar person={{ id: person.id, name: person.displayName, online: person.isOnline }} />
          <div><strong>{person.displayName}</strong><span>@{person.username}</span></div>
        </div> : <>
        <p>Tìm người dùng rồi đặt tên gợi nhớ nếu cần.</p>
        <label className="field-wrap"><Icon name="search" />
          <input value={query} onChange={event => {
            setQuery(event.target.value); setSelected(null); setError('')
            setLoading(event.target.value.trim().length >= 2)
          }} maxLength={100} disabled={busy} autoFocus
            placeholder="Nhập ít nhất 2 ký tự…" aria-label="Tìm người để thêm" />
        </label>
        <div className="conversation-search-results" aria-busy={loading}>
          {loading && <p role="status">Đang tìm người dùng…</p>}
          {!loading && query.trim().length < 2 && <p>Nhập tên người bạn muốn thêm.</p>}
          {!loading && query.trim().length >= 2 && !results.length &&
            <p>Không tìm thấy người dùng chưa có trong danh bạ.</p>}
          {results.map(person => (
            <button className={`conversation-person${selected?.id === person.id ? ' selected' : ''}`}
              type="button" key={person.id} disabled={busy} onClick={() => setSelected(person)}>
              <Avatar person={{ id: person.id, name: person.displayName, online: person.isOnline }} />
              <span><strong>{person.displayName}</strong><small>@{person.username}</small></span>
              {selected?.id === person.id && <Icon name="check" />}
            </button>
          ))}
        </div>
        </>}
        {selected && <label className="form-field contact-alias-field"><span>Tên gợi nhớ</span>
          <input value={alias} onChange={event => setAlias(event.target.value)} maxLength={100}
            disabled={busy} placeholder={selected.displayName} aria-describedby="contact-alias-help" />
          <small id="contact-alias-help">Để trống thì dùng tên hiện tại của người này.</small>
        </label>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <footer className="new-conversation-actions">
          <button className="btn" type="button" onClick={onClose} disabled={busy}>Hủy</button>
          <button className="btn btn--primary" type="submit" disabled={!selected || busy}>
            {busy ? 'Đang thêm…' : 'Thêm liên hệ'}
          </button>
        </footer>
      </form>
    </dialog>
  )
}

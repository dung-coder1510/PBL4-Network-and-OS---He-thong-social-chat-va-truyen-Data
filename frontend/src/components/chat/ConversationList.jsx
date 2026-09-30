import Avatar from '../Avatar.jsx'
import Icon from '../Icon.jsx'

function formatActivityTime(value) {
  const date = new Date(value)
  const today = new Date()
  if (date.toDateString() === today.toDateString())
    return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
  return date.toLocaleDateString('vi-VN', {
    day: '2-digit', month: '2-digit',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  })
}

export default function ConversationList({ items, loading, error, query, onQueryChange,
  currentUserId, selectedId, onSelect, onCreate, onRefresh, onLoadMore, hasMore }) {
  return (
    <aside className="conv-list" aria-label="Cuộc trò chuyện">
      <div className="conv-list-header">
        <div className="conv-list-title">
          <h2>Trò chuyện</h2>
          <div className="thread-actions">
            <button className="icon-btn" type="button" onClick={onRefresh} disabled={loading} aria-label="Làm mới cuộc trò chuyện" title="Làm mới">↻</button>
            <button className="icon-btn" type="button" onClick={onCreate} aria-label="Cuộc trò chuyện mới" title="Cuộc trò chuyện mới"><Icon name="edit" /></button>
          </div>
        </div>
        <label className="field-wrap"><Icon name="search" />
          <input value={query} onChange={e => onQueryChange(e.target.value)} maxLength={100}
            placeholder="Tìm cuộc trò chuyện…" aria-label="Tìm cuộc trò chuyện" />
        </label>
      </div>
      <div className="conv-items" aria-busy={loading}>
        {error && <div className="conversation-feedback" role="alert"><p>{error}</p><button className="btn" onClick={onRefresh}>Thử lại</button></div>}
        {items.map(item => {
          const activityAt = item.lastMessage?.createdAt || item.createdAt
          const preview = item.peer.isDisabled ? 'Tài khoản không khả dụng'
            : item.lastMessage ? `${item.lastMessage.senderId === currentUserId ? 'Bạn: ' : ''}${item.lastMessage.content}`
            : 'Chưa có tin nhắn'
          return (
          <button className={`conv-item${selectedId === item.id ? ' selected' : ''}`} type="button"
            key={item.id} onClick={() => onSelect(item.id)} aria-current={selectedId === item.id ? 'true' : undefined}
            aria-label={`Mở cuộc trò chuyện với ${item.peer.displayName}`}>
            <Avatar person={{ id: item.peer.id, name: item.peer.displayName, online: item.peer.isOnline }} size="sm" />
            <span className="conv-body">
              <span className="conv-row1"><span className="conv-name">{item.peer.displayName}</span>
                <time className="conv-time" dateTime={activityAt}>{formatActivityTime(activityAt)}</time>
              </span>
              <span className="conv-preview">{preview}</span>
              <span className="conversation-username">@{item.peer.username}</span>
            </span>
            {item.unreadCount > 0 && <span className="unread-badge" aria-label={`${item.unreadCount} tin chưa đọc`}>
              {item.unreadCount > 99 ? '99+' : item.unreadCount}
            </span>}
          </button>
          )
        })}
        {loading && <p className="conversation-feedback" role="status">Đang tải cuộc trò chuyện…</p>}
        {!loading && !error && !items.length && (
          <div className="conversation-feedback">
            <p>{query.trim() ? 'Không tìm thấy cuộc trò chuyện phù hợp.' : 'Bạn chưa có cuộc trò chuyện nào.'}</p>
            <button className="btn btn--primary" type="button" onClick={onCreate}>Bắt đầu trò chuyện</button>
          </div>
        )}
        {hasMore && !error && <button className="btn conversation-more" type="button" onClick={onLoadMore} disabled={loading}>Xem thêm</button>}
      </div>
      <div className="conv-footer">Cuộc trò chuyện được lưu trong tài khoản của bạn.</div>
    </aside>
  )
}

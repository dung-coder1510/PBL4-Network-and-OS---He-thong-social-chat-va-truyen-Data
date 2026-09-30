export function createClientMessageId(cryptoSource = globalThis.crypto) {
  if (typeof cryptoSource?.randomUUID === 'function') return cryptoSource.randomUUID()
  if (typeof cryptoSource?.getRandomValues !== 'function')
    throw new Error('Trình duyệt không thể tạo mã tin nhắn an toàn.')

  const bytes = new Uint8Array(16)
  cryptoSource.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function persistedId(value) {
  return /^\d+$/.test(String(value)) ? BigInt(value) : null
}

function isNewerMessage(message, previous) {
  if (!previous) return true
  const nextId = persistedId(message.id)
  const previousId = persistedId(previous.id)
  if (nextId !== null && previousId !== null) return nextId > previousId
  return Date.parse(message.createdAt) > Date.parse(previous.createdAt)
}

// Cập nhật preview/unread, đưa cuộc trò chuyện có tin mới lên đầu và có thể thêm conversation vừa nhận.
export function upsertConversationMessage(items, message, conversation = null,
  { currentUserId, isActive = false, fromSnapshot = false } = {}) {
  const current = items.find(item => item.id === message.conversationId)
  const base = current || conversation
  if (!base) return items
  const newer = isNewerMessage(message, base.lastMessage)
  const incoming = currentUserId !== undefined && message.senderId !== currentUserId
  const unreadCount = isActive ? 0
    : incoming && newer && !fromSnapshot ? (base.unreadCount || 0) + 1
    : base.unreadCount || 0
  const updated = {
    ...base,
    hasMessages: true,
    lastMessage: newer ? message : base.lastMessage,
    unreadCount,
  }
  const others = items.filter(item => item.id !== message.conversationId)
  if (!current) return [updated, ...others]
  return newer ? [updated, ...others] : items.map(item => item.id === updated.id ? updated : item)
}

export function applyMessageStatus(messages, status) {
  const boundary = persistedId(status.upToMessageId)
  if (boundary === null) return messages
  return messages.map(message => {
    const id = persistedId(message.id)
    if (message.conversationId !== status.conversationId ||
        message.senderId === status.recipientUserId || id === null || id > boundary)
      return message
    return {
      ...message,
      deliveredAt: message.deliveredAt || status.deliveredAt,
      readAt: message.readAt || status.readAt,
    }
  })
}

export function applyPresence(items, presence) {
  return items.map(item => item.peer.id === presence.userId
    ? { ...item, peer: { ...item.peer, ...presence } } : item)
}

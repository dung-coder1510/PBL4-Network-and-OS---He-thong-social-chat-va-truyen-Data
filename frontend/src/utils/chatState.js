// Tao UUID cho tin mot lan o client; dung lai ID nay cho moi lan retry va moi duong truyen.
// Neu trinh duyet thieu randomUUID, tao UUID v4 tu 16 byte ngau nhien an toan.
export function createClientMessageId(cryptoSource = globalThis.crypto) {
  if (typeof cryptoSource?.randomUUID === 'function') return cryptoSource.randomUUID()
  if (typeof cryptoSource?.getRandomValues !== 'function')
    throw new Error('Trình duyệt không thể tạo mã tin nhắn an toàn.')

  const bytes = new Uint8Array(16)
  cryptoSource.getRandomValues(bytes)
  // Dat 4 bit version thanh 0100 va 2 bit variant thanh 10 theo dinh dang UUID v4.
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// Doi ID SQL thanh BigInt de so sanh chinh xac; ID optimistic local tra null.
function persistedId(value) {
  return /^\d+$/.test(String(value)) ? BigInt(value) : null
}

// Gop tin P2P, SignalR, lich su va optimistic bang Map khoa sender/UUID, trung tin thi cap nhat.
// O(n + m) de gop, sau do O(k log k) de sap xep k tin; giu receipt da co khi ban sao cu den muon.
export function mergeChatMessages(current, additions) {
  // Hai tai khoan co the dung cung UUID; can ghep sender de khong nham danh tinh tin.
  const key = message => `${message.senderId}:${message.clientMessageId}`
  const byKey = new Map(current.map(message => [key(message), message]))
  for (const message of additions) {
    const old = byKey.get(key(message))
    // Ban optimistic den muon khong duoc thay ID SQL/thoi gian chuan da nhan tu server.
    const canonical = old && persistedId(old.id) !== null && persistedId(message.id) === null ? old : message
    byKey.set(key(message), { ...old, ...message, id: canonical.id, createdAt: canonical.createdAt,
      deliveredAt: message.deliveredAt || old?.deliveredAt || null,
      readAt: message.readAt || old?.readAt || null })
  }
  return [...byKey.values()].sort((a, b) => {
    const aId = persistedId(a.id)
    const bId = persistedId(b.id)
    // Uu tien ID SQL; chi dung thoi gian va khoa tin khi con tin chua duoc server cap ID.
    if (aId !== null && bId !== null) return aId < bId ? -1 : aId > bId ? 1 : 0
    return Date.parse(a.createdAt) - Date.parse(b.createdAt) || key(a).localeCompare(key(b))
  })
}

// Chon preview theo timestamp chuan, dung ID SQL de pha hoa khi hai tin trung mili giay.
function isNewerMessage(message, previous) {
  if (!previous) return true
  const difference = Date.parse(message.createdAt) - Date.parse(previous.createdAt)
  if (difference) return difference > 0
  const nextId = persistedId(message.id)
  const previousId = persistedId(previous.id)
  if (nextId !== null && previousId !== null) return nextId > previousId
  return Date.parse(message.createdAt) > Date.parse(previous.createdAt)
}

// Dung timestamp tin cuoi o ca REST va realtime; ID conversation chi dung khi trung timestamp.
export function sortConversations(items) {
  return [...items].sort((a, b) => {
    const difference = Date.parse(b.lastMessage?.createdAt || b.createdAt) -
      Date.parse(a.lastMessage?.createdAt || a.createdAt)
    if (difference) return difference
    const aId = persistedId(a.id)
    const bId = persistedId(b.id)
    return aId !== null && bId !== null ? (aId > bId ? -1 : aId < bId ? 1 : 0) : 0
  })
}

// Them/cap nhat conversation tu mot tin, doi preview, sap lai danh sach va tinh so chua doc.
// Snapshot server da tinh unread; chi cong tin live chua thay nam tren moc snapshot de tranh dem lap.
export function upsertConversationMessage(items, message, conversation = null,
  { currentUserId, isActive = false, fromSnapshot = false } = {}) {
  const current = items.find(item => item.id === message.conversationId)
  const base = current || conversation
  if (!base) return items
  const newer = isNewerMessage(message, base.lastMessage)
  const key = `${message.senderId}:${message.clientMessageId || message.id}`
  const previousKey = base.lastMessage && `${base.lastMessage.senderId}:${base.lastMessage.clientMessageId || base.lastMessage.id}`
  // Cache khoa tin gan day xu ly ban sao den muon; baseline tach tin live khoi tin da co trong snapshot.
  const seen = base.seenMessageKeys || (previousKey ? [previousKey] : [])
  const baseline = Object.hasOwn(base, 'unreadBaselineId') ? base.unreadBaselineId : base.lastMessage?.id || '0'
  const aboveBaseline = persistedId(message.id) !== null && persistedId(baseline) !== null
    ? persistedId(message.id) > persistedId(baseline) : newer
  const incoming = currentUserId !== undefined && message.senderId !== currentUserId
  const unreadCount = isActive ? 0
    : incoming && !seen.includes(key) && aboveBaseline && !fromSnapshot ? (base.unreadCount || 0) + 1
    : base.unreadCount || 0
  const updated = {
    ...base,
    hasMessages: true,
    lastMessage: newer ? message : previousKey === key
      ? mergeChatMessages([base.lastMessage], [message])[0] : base.lastMessage,
    unreadCount,
    // Gioi han 256 khoa moi conversation; khi cache day thi day moc baseline len de chan ban sao cu.
    seenMessageKeys: [...seen.filter(value => value !== key), key].slice(-256),
    unreadBaselineId: fromSnapshot ? (base.lastMessage?.id || message.id)
      : seen.length >= 256 ? (newer ? message.id : base.lastMessage?.id) : baseline,
  }
  const others = items.filter(item => item.id !== message.conversationId)
  if (!current) return sortConversations([updated, ...others])
  return sortConversations(items.map(item => item.id === updated.id ? updated : item))
}

// Ap dung receipt exact khi co MessageId; client cu van co the gui receipt cong don theo moc ID.
// Chi cap nhat tin cua peer trong dung conversation va khong xoa timestamp da nhan/da doc.
export function applyMessageStatus(messages, status) {
  const boundary = persistedId(status.upToMessageId)
  if (boundary === null) return messages
  return messages.map(message => {
    const id = persistedId(message.id)
    if (message.conversationId !== status.conversationId ||
        message.senderId === status.recipientUserId || id === null ||
        (status.messageId ? String(message.id) !== status.messageId : id > boundary))
      return message
    return {
      ...message,
      deliveredAt: message.deliveredAt || status.deliveredAt,
      readAt: message.readAt || status.readAt,
    }
  })
}

// Cap nhat online/lastSeen cua peer trong danh sach, khong sua cac conversation khong lien quan.
export function applyPresence(items, presence) {
  return items.map(item => item.peer.id === presence.userId
    ? { ...item, peer: { ...item.peer, ...presence } } : item)
}

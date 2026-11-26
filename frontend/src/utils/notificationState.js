// Logic chuẩn hóa cài đặt thông báo, đếm chưa đọc, tiêu đề tab và quyết định phát thông báo.

export const NOTIFICATION_SETTINGS_KEY = 'pbl4-notification-settings'
export const BASE_DOCUMENT_TITLE = 'Nối — PBL4 Realtime P2P'

export const DEFAULT_NOTIFICATION_SETTINGS = {
  inAppEnabled: true,
  soundEnabled: true,
  desktopEnabled: false,
}

/** Đọc và chuẩn hóa tùy chọn thông báo từ localStorage. */
export function readNotificationSettings(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(NOTIFICATION_SETTINGS_KEY)
    const saved = raw ? JSON.parse(raw) : null
    return {
      inAppEnabled: saved?.inAppEnabled !== false,
      soundEnabled: saved?.soundEnabled !== false,
      desktopEnabled: saved?.desktopEnabled === true,
    }
  } catch {
    return { ...DEFAULT_NOTIFICATION_SETTINGS }
  }
}

/** Rút gọn nội dung tin nhắn trên một dòng để hiển thị trong thông báo. */
export function truncatePreview(text = '', maxLength = 90) {
  const collapsed = String(text).replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  if (collapsed.length <= maxLength) return collapsed
  return `${collapsed.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
}

/** Cộng tổng số chưa đọc trên tất cả cuộc trò chuyện (object hoặc Map). */
export function sumUnreadCounts(unreadByConversation) {
  if (!unreadByConversation) return 0
  const values = unreadByConversation instanceof Map
    ? unreadByConversation.values()
    : Object.values(unreadByConversation)
  let total = 0
  for (const count of values) {
    if (Number.isFinite(count) && count > 0) total += Math.trunc(count)
  }
  return total
}

/** Tạo tiêu đề tab trình duyệt kèm bộ đếm chưa xem. */
export function formatDocumentTitle(totalCount, baseTitle = BASE_DOCUMENT_TITLE) {
  if (!Number.isFinite(totalCount) || totalCount <= 0) return baseTitle
  const normalized = Math.trunc(totalCount)
  const label = normalized > 99 ? '99+' : String(normalized)
  return `(${label}) ${baseTitle}`
}

/** Xác định có tăng unread, hiện toast trong app, phát âm thanh hay bật Desktop Notification cho tin đến. */
export function shouldNotifyIncomingMessage({
  message,
  currentUserId,
  currentPage,
  activeChat,
  isVisible = true,
  hasFocus = true,
  initialSyncDone = true,
  settings = DEFAULT_NOTIFICATION_SETTINGS,
}) {
  if (!message || message.senderId === currentUserId) {
    return { incrementUnread: false, showInApp: false, playSound: false, showDesktop: false }
  }

  const viewingSameThread = currentPage === 'chat' &&
    activeChat?.conversationId === message.conversationId &&
    activeChat?.threadVisible !== false
  const alreadyReading = viewingSameThread && isVisible
  const incrementUnread = !alreadyReading

  if (!initialSyncDone) {
    return { incrementUnread, showInApp: false, playSound: false, showDesktop: false }
  }

  const showInApp = Boolean(settings?.inAppEnabled) && !alreadyReading && isVisible
  const showDesktop = Boolean(settings?.desktopEnabled) && (!isVisible || !hasFocus)
  const playSound = Boolean(settings?.soundEnabled) && (!alreadyReading || !hasFocus)

  return { incrementUnread, showInApp, playSound, showDesktop }
}

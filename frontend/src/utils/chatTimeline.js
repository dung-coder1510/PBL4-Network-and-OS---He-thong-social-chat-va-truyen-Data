// Ghep hai loai su kien theo UTC; prefix type tranh trung ID giua Messages va FileTransfers.
export function chatTimeline(messages, transfers) {
  return [...messages.map(message => ({ kind: 'text', key: `text:${message.senderId}:${message.clientMessageId}`,
    createdAt: message.createdAt, value: message })),
  ...transfers.map(transfer => ({ kind: 'file', key: `file:${transfer.id}`,
    createdAt: transfer.createdAt, value: transfer }))].sort((a, b) =>
    Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.key.localeCompare(b.key, 'en', { numeric: true }))
}

// Hiển thị dung lượng theo đơn vị thập phân.
export function formatFileSize(bytes) {
  if (bytes < 1000) return `${Math.round(bytes)} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

// Khoảng cách tối thiểu giữa 2 mốc liên tiếp để hiển thị dải ngăn cách thời gian (> 10 phút).
export const TIME_DIVIDER_GAP_MS = 10 * 60 * 1000

// Hiện mốc thời gian giữa 2 sự kiện bất kỳ (tin nhắn hoặc tệp, A/B) khi cách nhau quá 10 phút.
export function shouldShowTimeDivider(previousEntry, currentEntry) {
  if (!previousEntry || !currentEntry) return false
  const previousMs = Date.parse(previousEntry.createdAt)
  const currentMs = Date.parse(currentEntry.createdAt)
  if (!Number.isFinite(previousMs) || !Number.isFinite(currentMs)) return false
  return (currentMs - previousMs) > TIME_DIVIDER_GAP_MS
}

// Định dạng mốc thời gian theo ngày địa phương: Hôm nay / Hôm qua / DD/MM/YYYY.
export function formatTimeDivider(value, now = new Date()) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = number => String(number).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const ref = now instanceof Date ? now : new Date(now)
  if (!Number.isNaN(ref.getTime())) {
    const dateDayUtc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
    const refDayUtc = Date.UTC(ref.getFullYear(), ref.getMonth(), ref.getDate())
    const dayDiff = Math.round((refDayUtc - dateDayUtc) / 86_400_000)
    if (dayDiff === 0) return `${time} Hôm nay`
    if (dayDiff === 1) return `${time} Hôm qua`
  }
  return `${time} ${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`
}

// Chi bieu dien loai file tu duoi ten, khong doc hoac chay noi dung cua tep.
export function fileTypeLabel(fileName) {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return 'FILE'
  const extension = fileName.slice(dot + 1).toLowerCase()
  if (['doc', 'docx'].includes(extension)) return 'W'
  if (['xls', 'xlsx', 'csv'].includes(extension)) return 'X'
  if (['ppt', 'pptx'].includes(extension)) return 'P'
  return /^[a-z0-9]{1,4}$/.test(extension) ? extension.toUpperCase() : 'FILE'
}

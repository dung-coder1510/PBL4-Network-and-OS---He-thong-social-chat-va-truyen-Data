// Ghep hai loai su kien theo UTC; prefix type tranh trung ID giua Messages va FileTransfers.
export function chatTimeline(messages, transfers) {
  return [...messages.map(message => ({ kind: 'text', key: `text:${message.senderId}:${message.clientMessageId}`,
    createdAt: message.createdAt, value: message })),
  ...transfers.map(transfer => ({ kind: 'file', key: `file:${transfer.id}`,
    createdAt: transfer.createdAt, value: transfer }))].sort((a, b) =>
    Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.key.localeCompare(b.key, 'en', { numeric: true }))
}

// Hien dung luong theo don vi nhi phan; 0 byte van la mot file hop le.
export function formatFileSize(bytes) {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

// Chi bieu dien loai file tu duoi ten, khong doc hoac chay noi dung cua tep.
export function fileTypeLabel(fileName) {
  const extension = fileName.split('.').at(-1).toLowerCase()
  if (['doc', 'docx'].includes(extension)) return 'W'
  if (['xls', 'xlsx', 'csv'].includes(extension)) return 'X'
  if (['ppt', 'pptx'].includes(extension)) return 'P'
  return ['pdf', 'zip', 'rar', '7z', 'txt', 'png', 'jpg', 'jpeg'].includes(extension)
    ? extension.toUpperCase() : 'FILE'
}

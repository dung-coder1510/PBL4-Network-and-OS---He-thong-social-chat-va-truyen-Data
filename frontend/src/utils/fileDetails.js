// Phân nhóm loại tệp và mô tả trạng thái/cách thức truyền theo ngôn ngữ thân thiện với người dùng.

export const FILE_CATEGORY_OPTIONS = [
  ['all', 'Mọi loại'],
  ['document', 'Tài liệu'],
  ['image', 'Hình ảnh'],
  ['video', 'Video'],
  ['audio', 'Âm thanh'],
  ['archive', 'Tệp nén'],
  ['other', 'Khác'],
]

const CATEGORY_EXTENSIONS = {
  document: new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'txt', 'md', 'rtf', 'odt']),
  image: new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic', 'avif']),
  video: new Set(['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'wmv']),
  audio: new Set(['m4a', 'mp3', 'wav', 'flac', 'ogg', 'aac', 'opus']),
  archive: new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso']),
}

/** Phân loại tệp dựa theo đuôi tên tệp để lọc nhanh trên giao diện. */
export function fileCategory(fileName = '') {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return 'other'
  const ext = fileName.slice(dot + 1).toLowerCase()
  for (const [category, extensions] of Object.entries(CATEGORY_EXTENSIONS)) {
    if (extensions.has(ext)) return category
  }
  return 'other'
}

/** Nhãn trạng thái ngắn gọn cho từng phiên truyền tệp. */
export function transferStatusLabel(transfer, sending) {
  switch (transfer?.status) {
    case 'offered':
      return sending ? 'Chờ người nhận' : 'Chờ bạn nhận'
    case 'accepted':
      return 'Đang kết nối…'
    case 'transferring':
      return sending ? 'Đang gửi…' : 'Đang nhận…'
    case 'completed':
      return 'Hoàn tất'
    case 'rejected':
      return 'Đã từ chối'
    case 'cancelled':
      return 'Đã hủy'
    case 'expired':
      return 'Hết hạn'
    case 'failed':
      return 'Thất bại'
    default:
      return ''
  }
}

/** Giải thích ngắn gọn điều gì đang xảy ra với phiên truyền hiện tại. */
export function transferStatusSummary(transfer, sending) {
  if (!transfer) return ''
  if (transfer.localPhase === 'verifying') return 'Đang kiểm tra mã toàn vẹn SHA-256 trước khi lưu xuống máy.'
  if (transfer.localPhase === 'saving') return 'Đang ghi hoàn tất tệp vào vị trí lưu bạn đã chọn.'
  if (transfer.savedLocally) {
    return transfer.status === 'completed'
      ? `Đã lưu an toàn thành ${transfer.savedName} và khớp mã SHA-256.`
      : `Đã lưu thành ${transfer.savedName}, đang chờ máy chủ xác nhận hoàn tất.`
  }
  if (transfer.downloadUrl) return 'Tệp đã tải xong và kiểm tra SHA-256. Bấm Tải xuống để lưu về máy.'

  const viaRelay = transfer.transport === 'https'
  switch (transfer.status) {
    case 'offered':
      return sending
        ? 'Đã gửi lời mời, đang chờ người nhận mở và chọn nơi lưu tệp.'
        : 'Bạn đang có lời mời nhận tệp. Bấm Chấp nhận để chọn nơi lưu và tải ngay.'
    case 'accepted':
      return viaRelay
        ? 'Người nhận đã đồng ý, đang chuẩn bị luồng truyền qua máy chủ.'
        : 'Người nhận đã đồng ý, hai thiết bị đang thiết lập kết nối WebRTC.'
    case 'transferring':
      if (viaRelay) {
        return sending
          ? 'Đang tải dữ liệu tệp lên máy chủ để chuyển tới người nhận.'
          : 'Đang tải dữ liệu tệp từ máy chủ về máy của bạn.'
      }
      return sending
        ? 'Đang truyền dữ liệu trực tiếp P2P sang thiết bị người nhận.'
        : 'Đang nhận dữ liệu trực tiếp P2P và ghi vào thiết bị của bạn.'
    case 'completed':
      return 'Truyền tệp thành công và đã đối chiếu khớp mã SHA-256.'
    case 'rejected':
      return sending ? 'Người nhận đã từ chối lời mời nhận tệp.' : 'Bạn đã từ chối lời mời nhận tệp.'
    case 'cancelled':
      return 'Phiên truyền đã được hủy trước khi hoàn tất.'
    case 'expired':
      return 'Lời mời nhận tệp đã hết hạn do không được phản hồi kịp thời.'
    case 'failed':
      return 'Phiên truyền bị gián đoạn trước khi hoàn tất.'
    default:
      return ''
  }
}

/** Mô tả cách thức gửi/nhận đang áp dụng cho tệp. */
export function describeTransferMethod(transfer) {
  if (!transfer) return ''
  if (transfer.transport === 'https') {
    return transfer.relayConnectionCount > 1
      ? `Qua máy chủ (HTTPS - ${transfer.relayConnectionCount} kết nối)`
      : 'Qua máy chủ (HTTPS)'
  }

  const connections = transfer.rtcDiagnostics?.connections
  let base = 'Trực tiếp WebRTC (P2P)'
  if (Array.isArray(connections) && connections.length > 0) {
    const routes = [...new Set(connections.map(item => item.route))]
    if (routes.some(route => route === 'turn')) base = 'WebRTC qua chuyển tiếp (TURN)'
    else if (routes.every(route => route === 'direct')) base = 'Trực tiếp WebRTC (P2P)'
  }

  const parts = [base]
  if (transfer.acceptedAt && transfer.channelCount > 1) parts.push(`${transfer.channelCount} kênh`)
  if (transfer.protocolVersion === 'file-v7') parts.push('v7')
  return parts.join(' - ')
}

/** Trả về bước tiến trình (0..2) hoặc -1 nếu phiên kết thúc không thành công. */
export function transferStepIndex(transfer) {
  if (!transfer) return -1
  if (transfer.status === 'offered') return 0
  if (transfer.status === 'accepted' || transfer.status === 'transferring') return 1
  if (transfer.status === 'completed') return 2
  return -1
}

/** Định dạng khoảng thời gian mili-giây sang chuỗi tiếng Việt ngắn gọn. */
export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return ''
  if (milliseconds < 1000) return '< 1 giây'
  const totalSeconds = Math.round(milliseconds / 1000)
  if (totalSeconds < 60) return `${totalSeconds} giây`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds > 0 ? `${minutes} phút ${seconds} giây` : `${minutes} phút`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes > 0 ? `${hours} giờ ${restMinutes} phút` : `${hours} giờ`
}

/** Ước tính thời gian truyền còn lại (ms) dựa trên tốc độ hiện tại. */
export function estimateRemainingMs(transfer) {
  if (!transfer || !Number.isFinite(transfer.bytesPerSecond) || transfer.bytesPerSecond <= 0) return null
  if (!Number.isFinite(transfer.transferredBytes) || !Number.isFinite(transfer.fileSizeBytes)) return null
  const remainingBytes = transfer.fileSizeBytes - transfer.transferredBytes
  if (remainingBytes <= 0) return null
  return (remainingBytes / transfer.bytesPerSecond) * 1000
}

/** Rút gọn chuỗi SHA-256 hex dài để dễ đọc trong hộp thoại chi tiết. */
export function shortHash(hex) {
  if (typeof hex !== 'string' || !hex) return ''
  if (hex.length <= 16) return hex
  return `${hex.slice(0, 8)}…${hex.slice(-8)}`
}

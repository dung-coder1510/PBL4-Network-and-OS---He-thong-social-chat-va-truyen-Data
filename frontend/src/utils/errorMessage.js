const SIGNALR_INVOKE_PREFIX = /^An unexpected error occurred invoking ['"][^'"]+['"] on the server\.\s*(?:[A-Za-z0-9_.]+Exception:\s*)?/i
const EXCEPTION_PREFIX = /^(?:HubException|InvalidOperationException|ArgumentException):\s*/i

// Lọc bỏ tiền tố kỹ thuật của SignalR HubException để hiển thị thông báo tiếng Việt gọn gàng.
export function formatUserError(error, fallback = 'Đã xảy ra lỗi. Bạn thử lại nhé.') {
  const raw = (typeof error === 'string' ? error : error?.message || '').trim()
  if (!raw) return fallback
  const cleaned = raw.replace(SIGNALR_INVOKE_PREFIX, '').replace(EXCEPTION_PREFIX, '').trim()
  if (!cleaned) return fallback
  if (/connection is not in the 'connected' state|underlying connection was closed|invocation canceled/i.test(cleaned)) {
    return 'Mất kết nối máy chủ. Bạn chờ kết nối lại rồi thử lại nhé.'
  }
  if (/^failed to fetch$/i.test(cleaned) || /^networkerror/i.test(cleaned)) {
    return 'Không kết nối được tới máy chủ. Vui lòng kiểm tra mạng.'
  }
  return cleaned
}

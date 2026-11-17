const API_BASE = (import.meta.env?.VITE_API_BASE_URL || '/api/v1').replace(/\/$/, '')
const FILE_CONTENT_BASE = (import.meta.env?.VITE_FILE_RELAY_CONTENT_BASE_URL || API_BASE).replace(/\/$/, '')

// Goi REST API co JWT, JSON va timeout 15 giay; tra JSON/undefined cho 204 hoac nem loi co status/code.
// Ket hop AbortSignal cua caller voi timeout de huy request khi doi trang/logout hoac cho qua lau.
export async function request(path, { method = 'GET', body, token, signal, headers } = {}) {
  let response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new Error('Không kết nối được máy chủ. Vui lòng thử lại.')
  }
  // HTTP 204 khong co body; khong co doc JSON trong truong hop nay.
  if (response.status === 204) return undefined
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const validation = data?.errors && Object.values(data.errors).flat()[0]
    throw Object.assign(new Error(validation || data?.detail || data?.title || 'Máy chủ chưa sẵn sàng. Vui lòng thử lại.'), {
      status: response.status, code: data?.code,
      retryAfterMs: Math.max(0, Number(response.headers.get('Retry-After')) || 0) * 1000,
    })
  }
  if (!data) throw new Error('Phản hồi từ máy chủ không hợp lệ.')
  return data
}

// Fetch giữ body nhị phân theo luồng và dùng tín hiệu hủy của riêng phiên truyền.
export async function requestFileContent(path, { method = 'GET', body, token, signal, headers }) {
  const response = await fetch(`${FILE_CONTENT_BASE}${path}`, {
    method, body, signal, cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, ...headers },
  })
  if (!response.ok) {
    const problem = await response.json().catch(() => null)
    throw Object.assign(new Error(problem?.title || 'Luồng chuyển tiếp đã dừng.'), { status: response.status })
  }
  return response
}

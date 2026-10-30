const API_BASE = (import.meta.env?.VITE_API_BASE_URL || '/api/v1').replace(/\/$/, '')

// Goi REST API co JWT, JSON va timeout 15 giay; tra JSON/undefined cho 204 hoac nem loi co status/code.
// Ket hop AbortSignal cua caller voi timeout de huy request khi doi trang/logout hoac cho qua lau.
export async function request(path, { method = 'GET', body, token, signal } = {}) {
  let response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
    })
  }
  if (!data) throw new Error('Phản hồi từ máy chủ không hợp lệ.')
  return data
}

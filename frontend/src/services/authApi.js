const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api/v1').replace(/\/$/, '')

async function request(path, { method = 'GET', body, token, signal } = {}) {
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

// Token chỉ được giữ trong React state, không ghi localStorage/sessionStorage.
export const authApi = {
  register: (body, signal) => request('/users', { method: 'POST', body, signal }),
  login: (body, signal) => request('/sessions', { method: 'POST', body, signal }),
  getMe: (token, signal) => request('/users/me', { token, signal }),
  logout: token => request('/sessions/current', { method: 'DELETE', token, signal: AbortSignal.timeout(10000) }),
}


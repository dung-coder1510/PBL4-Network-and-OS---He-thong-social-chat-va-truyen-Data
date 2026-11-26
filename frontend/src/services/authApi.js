import { request } from './apiClient.js'

// Access token chỉ giữ trong React RAM; phiên dài hạn dùng HttpOnly refresh cookie.
export const authApi = {
  register: (body, signal) => request('/users', { method: 'POST', body, signal }),
  login: (body, signal) => request('/sessions', { method: 'POST', body, credentials: 'include', signal }),
  refresh: signal => request('/sessions/refresh', {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-PBL4-Refresh': '1' },
    signal,
  }),
  getMe: (token, signal) => request('/users/me', { token, signal }),
  logout: token => request('/sessions/current', {
    method: 'DELETE',
    token,
    credentials: 'include',
    headers: { 'X-PBL4-Refresh': '1' },
    signal: AbortSignal.timeout(10000),
  }),
}

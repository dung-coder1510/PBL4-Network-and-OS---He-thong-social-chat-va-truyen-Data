import { request } from './apiClient.js'

// Token chỉ được giữ trong React state, không ghi localStorage/sessionStorage.
export const authApi = {
  register: (body, signal) => request('/users', { method: 'POST', body, signal }),
  login: (body, signal) => request('/sessions', { method: 'POST', body, signal }),
  getMe: (token, signal) => request('/users/me', { token, signal }),
  logout: token => request('/sessions/current', { method: 'DELETE', token, signal: AbortSignal.timeout(10000) }),
}

import { request } from './apiClient.js'

export const conversationsApi = {
  searchUsers: (token, search, signal) => request('/users?' + new URLSearchParams({ search }), { token, signal }),
  list: (token, { search = '', beforeId } = {}, signal) => {
    const query = new URLSearchParams({ search, limit: '30' })
    if (beforeId) query.set('beforeId', beforeId)
    return request('/conversations?' + query, { token, signal })
  },
  get: (token, id, signal) => request('/conversations/' + encodeURIComponent(id), { token, signal }),
  messages: (token, id, { beforeId, limit = 50 } = {}, signal) => {
    const query = new URLSearchParams({ limit: String(limit) })
    if (beforeId) query.set('beforeId', beforeId)
    return request('/conversations/' + encodeURIComponent(id) + '/messages?' + query, { token, signal })
  },
  create: (token, peerUserId, signal) => request('/conversations', {
    method: 'POST', body: { peerUserId }, token, signal,
  }),
}

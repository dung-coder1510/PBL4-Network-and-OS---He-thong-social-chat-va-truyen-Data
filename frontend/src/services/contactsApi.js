import { request } from './apiClient.js'

export const contactsApi = {
  list: (token, signal) => request('/contacts', { token, signal }),
  searchUsers: (token, search, signal) => request(
    '/users?' + new URLSearchParams({ search }), { token, signal }),
  create: (token, contactUserId, alias, signal) => request('/contacts', {
    method: 'POST', body: { contactUserId, alias: alias || null }, token, signal,
  }),
  update: (token, contactUserId, alias, signal) => request(
    '/contacts/' + encodeURIComponent(contactUserId), {
      method: 'PUT', body: { alias: alias || null }, token, signal,
    }),
  remove: (token, contactUserId, signal) => request(
    '/contacts/' + encodeURIComponent(contactUserId), { method: 'DELETE', token, signal }),
}

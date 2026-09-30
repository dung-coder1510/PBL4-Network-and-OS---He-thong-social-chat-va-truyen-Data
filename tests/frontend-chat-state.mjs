import assert from 'node:assert/strict'
import { createClientMessageId, upsertConversationMessage } from '../frontend/src/utils/chatState.js'

const preferred = createClientMessageId({ randomUUID: () => 'native-uuid' })
assert.equal(preferred, 'native-uuid')

const fallback = createClientMessageId({
  getRandomValues(bytes) {
    bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    return bytes
  },
})
assert.match(fallback, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

const conversation = { id: '12', peer: { displayName: 'B' }, createdAt: '2026-09-30T00:00:00Z' }
const firstMessage = { id: '1', conversationId: '12', senderId: 1, content: 'Xin chào', createdAt: '2026-09-30T01:00:00Z' }
const inserted = upsertConversationMessage([], firstMessage, conversation, {
  currentUserId: 2,
})
assert.equal(inserted.length, 1)
assert.equal(inserted[0].lastMessage.content, 'Xin chào')
assert.equal(inserted[0].unreadCount, 1)

const another = { id: '13', peer: { displayName: 'C' }, createdAt: '2026-09-30T00:00:00Z' }
const updated = upsertConversationMessage([another, inserted[0]], { ...firstMessage, id: '2', content: 'Mới nhất' })
assert.deepEqual(updated.map(item => item.id), ['12', '13'])
assert.equal(updated[0].lastMessage.content, 'Mới nhất')
assert.equal(updated[0].unreadCount, 1)
console.log('PASS UUID fallback and realtime conversation upsert.')

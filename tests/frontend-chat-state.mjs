import assert from 'node:assert/strict'
import { createClientMessageId, sortConversations, upsertConversationMessage } from '../frontend/src/utils/chatState.js'

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

const oldConversation = { ...conversation, id: '1', lastMessage: { ...firstMessage, createdAt: '2026-10-27T12:00:00Z' } }
const newConversation = { ...conversation, id: '9007199254740993', lastMessage: { ...firstMessage, createdAt: '2026-10-20T12:00:00Z' } }
const emptyConversation = { ...conversation, id: '3', createdAt: '2026-10-24T12:00:00Z' }
assert.deepEqual(sortConversations([newConversation, emptyConversation, oldConversation]).map(item => item.id),
  ['1', '3', '9007199254740993'])
const sameTime = [oldConversation, { ...oldConversation, id: '9007199254740993' }, { ...oldConversation, id: '9007199254740992' }]
assert.deepEqual(sortConversations(sameTime).map(item => item.id), ['9007199254740993', '9007199254740992', '1'])
const lateConversation = { ...conversation, id: '2', lastMessage: { ...firstMessage, id: '3', createdAt: '2026-10-25T12:00:00Z' } }
const lateMessage = { ...firstMessage, id: '4', conversationId: '2', createdAt: '2026-10-26T12:00:00Z' }
assert.deepEqual(upsertConversationMessage([oldConversation, lateConversation], lateMessage).map(item => item.id), ['1', '2'])
const newest = { ...lateMessage, id: '5', createdAt: '2026-10-28T12:00:00Z' }
assert.deepEqual(upsertConversationMessage([oldConversation, lateConversation], newest).map(item => item.id), ['2', '1'])
assert.deepEqual(upsertConversationMessage([oldConversation], lateMessage, lateConversation).map(item => item.id), ['1', '2'])
assert.equal(upsertConversationMessage([{ ...lateConversation, lastMessage: newest }], lateMessage)[0].lastMessage.id, '5')
console.log('PASS last-activity ordering, empty conversations, exact BIGINT ties and delayed messages.')

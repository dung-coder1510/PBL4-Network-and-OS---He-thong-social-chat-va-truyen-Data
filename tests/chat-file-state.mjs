import assert from 'node:assert/strict'
import { chatTimeline, fileTypeLabel, formatFileSize } from '../frontend/src/utils/chatTimeline.js'
import { latestConversationActivity, sortConversations, upsertConversationFile } from '../frontend/src/utils/chatState.js'

const message = { id: '1', senderId: 1, clientMessageId: 'm1', createdAt: '2026-10-28T01:00:00Z' }
const file = { id: '1', conversationId: '10', senderId: 1, fileName: 'report.docx', createdAt: '2026-10-28T01:01:00Z' }
const laterMessage = { ...message, id: '2', clientMessageId: 'm2', createdAt: '2026-10-28T01:02:00Z' }
const events = chatTimeline([laterMessage, message], [file])
assert.deepEqual(events.map(event => event.kind), ['text', 'file', 'text'])
assert.equal(new Set(events.map(event => event.key)).size, 3)

const conversation = { id: '10', createdAt: '2026-10-28T00:00:00Z', lastMessage: message, unreadCount: 2 }
const other = { id: '11', createdAt: '2026-10-28T01:00:30Z', lastMessage: null }
const changed = upsertConversationFile([other, conversation], file)
assert.equal(changed[0].id, '10')
assert.equal(changed[0].unreadCount, 2)
assert.equal(changed[0].lastMessage, message)
assert.equal(latestConversationActivity(changed[0]).fileName, 'report.docx')
assert.deepEqual(upsertConversationFile(changed, { ...file, status: 'completed' }), changed)
assert.equal(upsertConversationFile([], file, changed[0])[0].id, '10')
assert.equal(latestConversationActivity({ ...changed[0], lastMessage: laterMessage }), laterMessage)
assert.deepEqual(sortConversations(changed).map(item => item.id), ['10', '11'])
assert.equal(formatFileSize(0), '0 B')
assert.equal(formatFileSize(999.234), '999 B')
assert.equal(formatFileSize(1024), '1.0 KiB')
assert.equal(fileTypeLabel('REPORT.DOCX'), 'W')
assert.equal(fileTypeLabel('archive.zip'), 'ZIP')
console.log('PASS mixed timeline keys/order, file preview deduplication, unread preservation and empty/typed files.')

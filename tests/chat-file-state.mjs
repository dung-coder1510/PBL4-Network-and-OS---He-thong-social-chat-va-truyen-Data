import assert from 'node:assert/strict'
import { chatTimeline, fileTypeLabel, formatFileSize, formatTimeDivider, shouldShowTimeDivider } from '../frontend/src/utils/chatTimeline.js'
import { describeTransferMethod, estimateRemainingMs, fileCategory, formatDuration, shortHash, transferStatusLabel, transferStatusSummary, transferStepIndex } from '../frontend/src/utils/fileDetails.js'
import { formatDocumentTitle, NOTIFICATION_SETTINGS_KEY, readNotificationSettings, shouldNotifyIncomingMessage, sumUnreadCounts, truncatePreview } from '../frontend/src/utils/notificationState.js'
import { formatUserError } from '../frontend/src/utils/errorMessage.js'
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
assert.equal(formatFileSize(1024), '1.0 KB')
assert.equal(formatFileSize(110_000_000), '110.0 MB')
assert.equal(fileTypeLabel('REPORT.DOCX'), 'W')
assert.equal(fileTypeLabel('archive.zip'), 'ZIP')
assert.equal(fileTypeLabel('Thoại 261105_175025.m4a'), 'M4A')
assert.equal(fileTypeLabel('wiremess-speed-test-2gb.bin'), 'BIN')
assert.equal(fileTypeLabel('README'), 'FILE')
assert.equal(shouldShowTimeDivider(null, message), false)
assert.equal(shouldShowTimeDivider({ createdAt: '2026-11-21T10:00:00Z' }, { createdAt: '2026-11-21T10:10:00Z' }), false)
assert.equal(shouldShowTimeDivider({ createdAt: '2026-11-21T10:00:00Z' }, { createdAt: '2026-11-21T10:10:01Z' }), true)
assert.equal(shouldShowTimeDivider({ createdAt: '2026-11-21T10:00:00Z' }, { createdAt: '2026-11-21T10:05:00Z' }), false)
const dividerRef = new Date(2026, 10, 24, 20, 30)
assert.equal(formatTimeDivider(new Date(2026, 10, 24, 20, 2), dividerRef), '20:02 Hôm nay')
assert.equal(formatTimeDivider(new Date(2026, 10, 23, 17, 5), dividerRef), '17:05 Hôm qua')
assert.equal(formatTimeDivider(new Date(2026, 10, 21, 22, 25), dividerRef), '22:25 21/11/2026')
assert.equal(formatTimeDivider(new Date(2026, 11, 31, 23, 55), new Date(2027, 0, 1, 0, 5)), '23:55 Hôm qua')
assert.equal(
  formatUserError(new Error("An unexpected error occurred invoking 'OfferFile' on the server. HubException: Người nhận cần mở ứng dụng để nhận tệp.")),
  'Người nhận cần mở ứng dụng để nhận tệp.'
)
assert.equal(
  formatUserError(new Error("Cannot send data if the connection is not in the 'Connected' State.")),
  'Mất kết nối máy chủ. Bạn chờ kết nối lại rồi thử lại nhé.'
)
assert.equal(formatUserError(new Error('Tệp vượt dung lượng cho phép.')), 'Tệp vượt dung lượng cho phép.')
assert.equal(fileCategory('bao-cao.pdf'), 'document')
assert.equal(fileCategory('anh.png'), 'image')
assert.equal(fileCategory('clip.mp4'), 'video')
assert.equal(fileCategory('thoai.m4a'), 'audio')
assert.equal(fileCategory('demo.zip'), 'archive')
assert.equal(fileCategory('unknown.bin'), 'other')
assert.equal(transferStatusLabel({ status: 'offered' }, false), 'Chờ bạn nhận')
assert.equal(transferStatusLabel({ status: 'offered' }, true), 'Chờ người nhận')
assert.equal(transferStatusLabel({ status: 'transferring' }, false), 'Đang nhận…')
assert.equal(transferStatusLabel({ status: 'completed' }, true), 'Hoàn tất')
assert.equal(describeTransferMethod({ transport: 'https', relayConnectionCount: 4 }), 'Qua máy chủ (HTTPS - 4 kết nối)')
assert.equal(describeTransferMethod({ acceptedAt: '2026-11-24T00:00:00Z', channelCount: 4, protocolVersion: 'file-v7' }), 'Trực tiếp WebRTC (P2P) - 4 kênh - v7')
assert.equal(transferStepIndex({ status: 'transferring' }), 1)
assert.equal(formatDuration(95_000), '1 phút 35 giây')
assert.equal(estimateRemainingMs({ fileSizeBytes: 1000, transferredBytes: 400, bytesPerSecond: 200 }), 3000)
assert.equal(shortHash('a'.repeat(64)), 'aaaaaaaa…aaaaaaaa')
assert.ok(transferStatusSummary({ status: 'offered' }, false).includes('Chấp nhận'))

// Notification helpers
assert.deepEqual(readNotificationSettings({ getItem: () => null }), { inAppEnabled: true, soundEnabled: true, desktopEnabled: false })
assert.deepEqual(
  readNotificationSettings({ getItem: key => (key === NOTIFICATION_SETTINGS_KEY ? '{"inAppEnabled":false,"desktopEnabled":true}' : null) }),
  { inAppEnabled: false, soundEnabled: true, desktopEnabled: true }
)
assert.equal(truncatePreview('  Xin   chào\n  mọi người  ', 15), 'Xin chào mọi n…')
assert.equal(sumUnreadCounts({ '10': 2, '11': 5, '12': 0 }), 7)
assert.equal(formatDocumentTitle(0), 'Nối — PBL4 Realtime P2P')
assert.equal(formatDocumentTitle(3), '(3) Nối — PBL4 Realtime P2P')
assert.equal(formatDocumentTitle(120), '(99+) Nối — PBL4 Realtime P2P')

const incomingMsg = { senderId: 2, conversationId: '10', content: 'Alo' }
assert.deepEqual(shouldNotifyIncomingMessage({
  message: { ...incomingMsg, senderId: 1 }, currentUserId: 1, currentPage: 'files', initialSyncDone: true,
}), { incrementUnread: false, showInApp: false, playSound: false, showDesktop: false })
assert.deepEqual(shouldNotifyIncomingMessage({
  message: incomingMsg, currentUserId: 1, currentPage: 'files', initialSyncDone: false,
}), { incrementUnread: true, showInApp: false, playSound: false, showDesktop: false })
assert.deepEqual(shouldNotifyIncomingMessage({
  message: incomingMsg, currentUserId: 1, currentPage: 'chat', activeChat: { conversationId: '10', threadVisible: true }, isVisible: true, hasFocus: true, initialSyncDone: true,
}), { incrementUnread: false, showInApp: false, playSound: false, showDesktop: false })
assert.deepEqual(shouldNotifyIncomingMessage({
  message: incomingMsg, currentUserId: 1, currentPage: 'files', activeChat: { conversationId: '10', threadVisible: true }, isVisible: true, hasFocus: true, initialSyncDone: true,
}), { incrementUnread: true, showInApp: true, playSound: true, showDesktop: false })
assert.deepEqual(shouldNotifyIncomingMessage({
  message: incomingMsg, currentUserId: 1, currentPage: 'chat', activeChat: { conversationId: '10', threadVisible: true }, isVisible: false, hasFocus: false, initialSyncDone: true,
  settings: { inAppEnabled: false, soundEnabled: true, desktopEnabled: true },
}), { incrementUnread: true, showInApp: false, playSound: true, showDesktop: true })

console.log('PASS mixed timeline keys/order, file preview deduplication, unread preservation and empty/typed files.')

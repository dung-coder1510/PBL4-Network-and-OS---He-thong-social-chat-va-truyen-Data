import * as signalR from '@microsoft/signalr'

const HUB_URL = import.meta.env.VITE_CHAT_HUB_URL || '/hubs/chat'

// Tao ket noi SignalR co JWT trong bo nho; goi callback khi reconnect, noi lai hoac dong.
export function createChatConnection(token, lifecycle = {}) {
  const connection = new signalR.HubConnectionBuilder()
    .withUrl(HUB_URL, { accessTokenFactory: () => token })
    // Thu noi lai ngay, roi sau 2/5/10 giay; luong tai bu do provider xu ly khi ket noi lai.
    .withAutomaticReconnect([0, 2000, 5000, 10000])
    .configureLogging(signalR.LogLevel.Warning)
    .build()

  connection.onreconnecting(error => lifecycle.onReconnecting?.(error))
  connection.onreconnected(() => lifecycle.onReconnected?.())
  connection.onclose(error => lifecycle.onClosed?.(error))
  return connection
}

// Mo socket va thuong luong SignalR; tra Promise de provider xu ly thanh cong/loi.
export function startChatConnection(connection) {
  return connection.start()
}

// Dong ket noi khi ket thuc phien; tra Promise cua thao tac stop.
export function stopChatConnection(connection) {
  return connection.stop()
}

// Dang ky nhan tin server; tra ham huy dang ky de React khong nhan nhieu lan sau remount.
export function listenForMessages(connection, handler) {
  connection.on('MessageReceived', handler)
  return () => connection.off('MessageReceived', handler)
}

// Lang nghe thay doi conversation de provider kich hoat tai lai danh sach/lich su.
export function listenForConversationChanges(connection, handler) {
  connection.on('ConversationChanged', handler)
  return () => connection.off('ConversationChanged', handler)
}

// Lang nghe receipt da nhan/da doc; payload phan biet exact va cong don.
export function listenForMessageStatuses(connection, handler) {
  connection.on('MessageStatusChanged', handler)
  return () => connection.off('MessageStatusChanged', handler)
}

// Lang nghe online/offline cua tai khoan peer va tra ham don listener.
export function listenForPresence(connection, handler) {
  connection.on('PresenceChanged', handler)
  return () => connection.off('PresenceChanged', handler)
}

// Lang nghe tin hieu dang nhap tam thoi, khong phai noi dung tin nhan.
export function listenForTyping(connection, handler) {
  connection.on('TypingChanged', handler)
  return () => connection.off('TypingChanged', handler)
}

// Gui text bang duong SignalR cu; retry phai giu ClientMessageId de backend khong insert trung.
export function sendMessage(connection, { conversationId, clientMessageId, content }) {
  return connection.invoke('SendMessage', { conversationId, clientMessageId, content })
}

// Gui nhip song ung dung va nhan chu ky heartbeat do server quy dinh.
export function sendHeartbeat(connection) {
  return connection.invoke('Heartbeat')
}

// Gui ACK cong don cho client cu; khong dung voi mot frame P2P le khi con khoang trong.
export function acknowledgeDelivered(connection, conversationId, upToMessageId) {
  return connection.invoke('AcknowledgeDelivered', { conversationId, upToMessageId })
}

// Gui lenh doc cong don cua client cu den moc UpToMessageId trong conversation.
export function markAsRead(connection, conversationId, upToMessageId) {
  return connection.invoke('MarkAsRead', { conversationId, upToMessageId })
}

// Chon lenh bat/tat typing theo trang thai o soan tin; server tu kiem tra quyen va tan suat.
export function setTyping(connection, conversationId, isTyping) {
  return connection.invoke(isTyping ? 'StartTyping' : 'StopTyping', { conversationId })
}

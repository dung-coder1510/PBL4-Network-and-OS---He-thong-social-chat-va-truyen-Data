import * as signalR from '@microsoft/signalr'

const HUB_URL = import.meta.env.VITE_CHAT_HUB_URL || '/hubs/chat'

// Nhóm 1: quản lý đường truyền SignalR.
export function createChatConnection(token, lifecycle = {}) {
  const connection = new signalR.HubConnectionBuilder()
    .withUrl(HUB_URL, { accessTokenFactory: () => token })
    .withAutomaticReconnect([0, 2000, 5000, 10000])
    .configureLogging(signalR.LogLevel.Warning)
    .build()

  connection.onreconnecting(error => lifecycle.onReconnecting?.(error))
  connection.onreconnected(() => lifecycle.onReconnected?.())
  connection.onclose(error => lifecycle.onClosed?.(error))
  return connection
}

export function startChatConnection(connection) {
  return connection.start()
}

export function stopChatConnection(connection) {
  return connection.stop()
}

// Nhóm 2: lắng nghe sự kiện server → client. Hàm trả cleanup để React không nhân listener.
export function listenForMessages(connection, handler) {
  connection.on('MessageReceived', handler)
  return () => connection.off('MessageReceived', handler)
}

export function listenForMessageStatuses(connection, handler) {
  connection.on('MessageStatusChanged', handler)
  return () => connection.off('MessageStatusChanged', handler)
}

export function listenForPresence(connection, handler) {
  connection.on('PresenceChanged', handler)
  return () => connection.off('PresenceChanged', handler)
}

export function listenForTyping(connection, handler) {
  connection.on('TypingChanged', handler)
  return () => connection.off('TypingChanged', handler)
}

// Nhóm 3: client chủ động ra lệnh. Retry phải truyền lại đúng clientMessageId.
export function sendMessage(connection, { conversationId, clientMessageId, content }) {
  return connection.invoke('SendMessage', { conversationId, clientMessageId, content })
}

export function acknowledgeDelivered(connection, conversationId, upToMessageId) {
  return connection.invoke('AcknowledgeDelivered', { conversationId, upToMessageId })
}

export function markAsRead(connection, conversationId, upToMessageId) {
  return connection.invoke('MarkAsRead', { conversationId, upToMessageId })
}

export function setTyping(connection, conversationId, isTyping) {
  return connection.invoke(isTyping ? 'StartTyping' : 'StopTyping', { conversationId })
}

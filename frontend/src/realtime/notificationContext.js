import { createContext, useContext } from 'react'

const NOOP = () => {}

const DEFAULT_CONTEXT = {
  totalUnreadMessages: 0,
  pendingFileCount: 0,
  setPendingFileCount: NOOP,
  setActiveChat: NOOP,
  syncConversations: NOOP,
  notifyFile: NOOP,
  sendTest: NOOP,
}

export const NotificationContext = createContext(DEFAULT_CONTEXT)

export function useNotifications() {
  return useContext(NotificationContext)
}

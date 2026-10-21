import { createContext, useContext } from 'react'

export const ChatRealtimeContext = createContext(null)

// Lay ket noi, luong tin va trang thai P2P tu provider; bao loi neu component dung ngoai provider.
export function useChatRealtime() {
  const value = useContext(ChatRealtimeContext)
  if (!value) throw new Error('useChatRealtime must be used inside ChatRealtimeProvider.')
  return value
}

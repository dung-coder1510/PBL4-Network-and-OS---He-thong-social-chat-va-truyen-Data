import { createContext, useContext } from 'react'

export const ChatRealtimeContext = createContext(null)

export function useChatRealtime() {
  const value = useContext(ChatRealtimeContext)
  if (!value) throw new Error('useChatRealtime must be used inside ChatRealtimeProvider.')
  return value
}

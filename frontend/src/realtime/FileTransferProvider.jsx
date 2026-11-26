import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatRealtime } from './chatRealtimeContext.js'
import { FileTransferContext } from './fileTransferContext.js'
import { useNotifications } from './notificationContext.js'
import { createFileTransfers } from '../services/fileTransfers.js'
import LargeFileWarningDialog from '../components/files/LargeFileWarningDialog.jsx'
import '../styles/files.css'

export function FileTransferProvider({ token, user, developerMode, preferredChannelCount, parallelFileConnections,
  relayConnectionCount, webrtcConnectionCount = null, allowTurnForFiles = false, onRelayActivity, children }) {
  const { connection, connectionState } = useChatRealtime()
  const { notifyFile, setPendingFileCount } = useNotifications()
  const manager = useRef(null)
  const allowTurnRef = useRef(allowTurnForFiles)
  const tokenRef = useRef(token)
  const [snapshot, setSnapshot] = useState({ items: [], nextCursor: null })
  const [largeFile, setLargeFile] = useState(null)
  const confirmation = useRef(null)
  const finishConfirmation = useCallback(accepted => {
    const resolve = confirmation.current
    confirmation.current = null
    setLargeFile(null)
    resolve?.(accepted)
  }, [])
  const confirmLargeFile = useCallback(file => new Promise(resolve => {
    if (confirmation.current) { resolve(false); return }
    confirmation.current = resolve
    setLargeFile(file)
  }), [])
  // Giu callback on dinh de progress file khong kich hoat lai effect tai lich su trong ChatPage.
  const loadConversation = useCallback((...args) => manager.current?.loadConversation(...args) || Promise.resolve(), [])

  useEffect(() => {
    tokenRef.current = token
    manager.current?.setToken?.(token)
  }, [token])

  useEffect(() => {
    allowTurnRef.current = allowTurnForFiles
    manager.current?.setAllowTurnForFiles(allowTurnForFiles)
  }, [allowTurnForFiles])

  useEffect(() => {
    const current = createFileTransfers({
      token: tokenRef.current, userId: user.id, onChange: setSnapshot, onNotice: notifyFile, confirmLargeFile, onRelayActivity,
      allowTurnForFiles: allowTurnRef.current,
    })
    manager.current = current
    return () => {
      current.dispose()
      finishConfirmation(false)
      if (manager.current === current) manager.current = null
    }
  }, [user.id, confirmLargeFile, finishConfirmation, onRelayActivity, notifyFile])

  useEffect(() => {
    manager.current?.setConnection(connection ?? null)
    if (connectionState === 'connected')
      void manager.current?.load().catch(error => notifyFile(error.message, { kind: 'file-error' }))
    else manager.current?.disconnected()
  }, [connection, connectionState, user.id, notifyFile])

  useEffect(() => {
    const incomingOffers = snapshot.items.filter(item => item.senderId !== user.id && item.status === 'offered').length
    setPendingFileCount(incomingOffers)
  }, [snapshot.items, user.id, setPendingFileCount])

  useEffect(() => () => setPendingFileCount(0), [setPendingFileCount])

  return (
    <FileTransferContext.Provider value={{
      ...snapshot, connectionState, connectionId: connection?.connectionId,
      loadConversation, developerMode,
      offer: (conversationId, file, transport) =>
        manager.current.offer(conversationId, file, preferredChannelCount, parallelFileConnections, transport,
          relayConnectionCount, webrtcConnectionCount),
      action: (...args) => manager.current.action(...args),
      loadMore: () => manager.current.load(true),
      forgetDownload: id => manager.current.forgetDownload(id),
    }}>
      {children}
      {largeFile && <LargeFileWarningDialog file={largeFile}
        onConfirm={() => finishConfirmation(true)} onCancel={() => finishConfirmation(false)} />}
    </FileTransferContext.Provider>
  )
}

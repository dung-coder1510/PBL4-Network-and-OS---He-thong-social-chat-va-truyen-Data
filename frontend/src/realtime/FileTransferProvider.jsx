import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatRealtime } from './chatRealtimeContext.js'
import { FileTransferContext } from './fileTransferContext.js'
import { createFileTransfers } from '../services/fileTransfers.js'
import LargeFileWarningDialog from '../components/files/LargeFileWarningDialog.jsx'
import '../styles/files.css'

export function FileTransferProvider({ token, user, children }) {
  const { connection, connectionState } = useChatRealtime()
  const manager = useRef(null)
  const [snapshot, setSnapshot] = useState({ items: [], nextCursor: null })
  const [notice, setNotice] = useState('')
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
    if (!connection) return
    const current = createFileTransfers({
      connection, token, userId: user.id, onChange: setSnapshot, onNotice: setNotice, confirmLargeFile,
    })
    manager.current = current
    return () => {
      current.dispose()
      finishConfirmation(false)
      if (manager.current === current) manager.current = null
    }
  }, [connection, token, user.id, confirmLargeFile, finishConfirmation])

  useEffect(() => {
    if (connectionState === 'connected')
      void manager.current?.load().catch(error => setNotice(error.message))
    else manager.current?.disconnected()
  }, [connection, connectionState])

  return (
    <FileTransferContext.Provider value={{
      ...snapshot, connectionState, connectionId: connection?.connectionId,
      loadConversation,
      offer: (...args) => manager.current.offer(...args),
      action: (...args) => manager.current.action(...args),
      loadMore: () => manager.current.load(true),
      forgetDownload: id => manager.current.forgetDownload(id),
    }}>
      {notice && <div className="file-notice" role="status">
        <a href="#chat">{notice}</a>
        <button type="button" aria-label="Đóng thông báo tệp" onClick={() => setNotice('')}>×</button>
      </div>}
      {children}
      {largeFile && <LargeFileWarningDialog file={largeFile}
        onConfirm={() => finishConfirmation(true)} onCancel={() => finishConfirmation(false)} />}
    </FileTransferContext.Provider>
  )
}

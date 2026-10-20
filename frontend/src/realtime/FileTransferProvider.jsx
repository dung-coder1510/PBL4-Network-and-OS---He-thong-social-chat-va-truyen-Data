import { useEffect, useRef, useState } from 'react'
import { useChatRealtime } from './chatRealtimeContext.js'
import { FileTransferContext } from './fileTransferContext.js'
import { createFileTransfers } from '../services/fileTransfers.js'
import '../styles/files.css'

export function FileTransferProvider({ token, user, children }) {
  const { connection, connectionState } = useChatRealtime()
  const manager = useRef(null)
  const [snapshot, setSnapshot] = useState({ items: [], nextCursor: null })
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!connection) return
    const current = createFileTransfers({
      connection, token, userId: user.id, onChange: setSnapshot, onNotice: setNotice,
    })
    manager.current = current
    return () => {
      current.dispose()
      if (manager.current === current) manager.current = null
    }
  }, [connection, token, user.id])

  useEffect(() => {
    if (connectionState === 'connected')
      void manager.current?.load().catch(error => setNotice(error.message))
    else manager.current?.disconnected()
  }, [connection, connectionState])

  return (
    <FileTransferContext.Provider value={{
      ...snapshot, connectionState, connectionId: connection?.connectionId,
      offer: (...args) => manager.current.offer(...args),
      action: (...args) => manager.current.action(...args),
      loadMore: () => manager.current.load(true),
      forgetDownload: id => manager.current.forgetDownload(id),
    }}>
      {notice && <div className="file-notice" role="status">
        <a href="#files">{notice}</a>
        <button type="button" aria-label="Đóng thông báo tệp" onClick={() => setNotice('')}>×</button>
      </div>}
      {children}
    </FileTransferContext.Provider>
  )
}

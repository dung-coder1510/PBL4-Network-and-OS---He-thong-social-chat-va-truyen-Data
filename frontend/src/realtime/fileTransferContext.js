import { createContext, useContext } from 'react'

export const FileTransferContext = createContext(null)
export const useFileTransfers = () => useContext(FileTransferContext)

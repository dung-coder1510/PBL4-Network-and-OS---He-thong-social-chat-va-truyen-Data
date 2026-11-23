import { useEffect, useRef, useState } from 'react'
import { pickFileDestination } from '../../services/fileStorage.js'
import { measureRelayPath } from '../../services/fileRelayDiagnostics.js'

export default function RelayDiagnostics({ token }) {
  const active = useRef(null)
  const [status, setStatus] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => () => {
    active.current?.abort()
    active.current = null
  }, [])

  async function measure() {
    if (active.current) return
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    setResult(null)
    try {
      const target = await pickFileDestination('wiremess-speed-test-110mb.bin')
      const value = await measureRelayPath(token, target, controller.signal, setStatus)
      if (controller.signal.aborted) return
      setResult(value)
      setStatus('Đã đo xong và lưu tệp thử 110 MB. SHA-256 khớp.')
    } catch (error) {
      if (active.current === controller)
        setStatus(error.name === 'AbortError' ? 'Đã dừng phép đo.' : error.message)
    } finally {
      if (active.current === controller) {
        active.current = null
        setBusy(false)
      }
    }
  }

  return <div>
    <p>Đo riêng tải lên và tải xuống. Chọn nơi lưu tệp thử 110 MB, chạy phép đo khi các phiên gửi file đã kết thúc.</p>
    <button className="btn" type="button" disabled={busy} onClick={() => void measure()}>
      Đo đường truyền HTTPS
    </button>
    {busy && <button className="btn" type="button" onClick={() => active.current?.abort()}>Dừng đo</button>}
    <p role="status">{status}</p>
    {result && <dl>
      <dt>Máy này → máy chủ</dt><dd>{result.uploadMBps.toFixed(2)} MB/s · {result.uploadSeconds.toFixed(1)} giây</dd>
      <dt>Máy chủ → máy này và ghi đĩa</dt><dd>{result.downloadMBps.toFixed(2)} MB/s · {result.downloadSeconds.toFixed(1)} giây</dd>
    </dl>}
  </div>
}

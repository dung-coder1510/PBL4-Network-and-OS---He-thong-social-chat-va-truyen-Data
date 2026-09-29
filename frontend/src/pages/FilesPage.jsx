import Icon from '../components/Icon.jsx'
import { FILES, PEOPLE } from '../data/mockData.js'

const STATUS_LABELS = { done: 'Hoàn tất', cancelled: 'Đã hủy', active: 'Đang truyền' }

function FilesPage({ onNotify }) {
  return (
    <div className="page">
      <div className="page-header"><div><h1>Tệp đã chia sẻ</h1><p>Theo dõi các phiên truyền tệp trực tiếp qua WebRTC DataChannel.</p></div><button className="btn btn--primary" type="button" onClick={() => onNotify('Chọn tệp sẽ được nối với WebRTC sau.')}><Icon name="plus" size="ico-sm" />Gửi tệp</button></div>
      <div className="table-wrap"><table><thead><tr><th>Tên tệp</th><th>Người liên hệ</th><th>Thời gian</th><th>Trạng thái</th><th className="right">Thao tác</th></tr></thead><tbody>
        {FILES.map((file) => {
          const owner = PEOPLE.find((person) => person.id === file.owner)
          return <tr key={file.id}><td><div className="id-cell"><span className={`file-thumb${file.type === 'PDF' ? ' file-thumb--pdf' : file.type === 'ZIP' ? ' file-thumb--zip' : ''}`}><Icon name="file" /></span><div className="id-cell-text"><strong>{file.name}</strong><small>{file.size} · {file.type}</small></div></div></td><td>{owner.name}</td><td>{file.date}</td><td><span className={`pill pill--${file.status === 'done' ? 'green' : 'gray'}`}>{STATUS_LABELS[file.status]}</span>{file.status === 'cancelled' ? <div className="progress-track"><span style={{ width: `${file.progress}%` }} /></div> : null}</td><td className="right"><button className="tbl-action" type="button" onClick={() => onNotify(file.status === 'done' ? 'Đã chuẩn bị tệp mẫu để tải xuống.' : 'Phiên truyền sẽ được thử lại sau khi nối WebRTC.')}>{file.status === 'done' ? 'Tải xuống' : 'Thử lại'}</button></td></tr>
        })}
      </tbody></table></div>
    </div>
  )
}

export default FilesPage

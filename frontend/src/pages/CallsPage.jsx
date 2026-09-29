import Avatar from '../components/Avatar.jsx'
import Icon from '../components/Icon.jsx'
import { CALLS, PEOPLE } from '../data/mockData.js'

function CallsPage({ onNotify }) {
  return (
    <div className="page">
      <div className="page-header"><div><h1>Cuộc gọi</h1><p>Lịch sử cuộc gọi thoại qua WebRTC.</p></div><button className="btn btn--primary" type="button" onClick={() => onNotify('Chọn một người trong danh bạ để gọi.')}><Icon name="phone" size="ico-sm" />Gọi mới</button></div>
      <div className="section-label">Lịch sử gần đây</div>
      <div className="table-wrap"><table><thead><tr><th>Người liên hệ</th><th>Thời gian</th><th>Thời lượng</th><th className="right">Thao tác</th></tr></thead><tbody>
        {CALLS.map((call) => {
          const person = PEOPLE.find((item) => item.id === call.personId)
          const missed = call.result === 'missed'
          return <tr key={call.id}><td><div className="id-cell"><Avatar person={person} size="sm" /><div className="id-cell-text"><strong>{person.name}</strong><div className={`call-dir${missed ? ' missed' : ''}`}>{missed ? 'Cuộc gọi nhỡ' : call.direction === 'out' ? 'Cuộc gọi đi' : 'Cuộc gọi đến'}</div></div></div></td><td>{call.date}</td><td>{call.duration}</td><td className="right"><button className="tbl-action" type="button" onClick={() => onNotify(`Đang mô phỏng gọi lại ${person.name}.`)}>Gọi lại</button></td></tr>
        })}
      </tbody></table></div>
    </div>
  )
}

export default CallsPage

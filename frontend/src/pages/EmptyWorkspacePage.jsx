import Icon from '../components/Icon.jsx'

const PAGES = {
  chat: ['chat', 'Trò chuyện', 'Chưa có cuộc trò chuyện', 'Các cuộc trò chuyện của bạn sẽ xuất hiện ở đây.'],
  contacts: ['users', 'Danh bạ', 'Chưa có liên hệ', 'Những người bạn thêm vào danh bạ sẽ xuất hiện ở đây.'],
  calls: ['phone', 'Cuộc gọi', 'Chưa có cuộc gọi', 'Lịch sử cuộc gọi của bạn sẽ xuất hiện ở đây.'],
  files: ['folder', 'Tệp đã chia sẻ', 'Chưa có tệp', 'Các tệp bạn gửi và nhận sẽ xuất hiện ở đây.'],
  admin: ['shield', 'Quản trị', 'Quản lý tài khoản', 'Chức năng quản trị đang được chuẩn bị.'],
}

// Các trang chưa có nghiệp vụ thật không trình bày dữ liệu mock như dữ liệu tài khoản thật.
export default function EmptyWorkspacePage({ page, user }) {
  const [icon, title, heading, description] = PAGES[page] || PAGES.chat
  return (
    <div className="page">
      <div className="page-header"><div><h1>{title}</h1><p>Xin chào, {user.displayName}.</p></div></div>
      <div className="empty account-empty">
        <Icon name={icon} size="ico-lg" />
        <h2>{heading}</h2>
        <p>{description}</p>
      </div>
    </div>
  )
}


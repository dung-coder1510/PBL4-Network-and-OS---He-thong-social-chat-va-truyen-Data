export const CURRENT_USER = {
  id: 0,
  name: 'Nguyễn Thành Trung',
  username: 'thanhtrung',
  role: 'Admin',
  online: true,
  color: 'blue',
}

export const PEOPLE = [
  { id: 1, name: 'Nguyễn Hoàng Dũng', username: 'hoangdung', online: true, color: 'indigo', role: 'User', disabled: false },
  { id: 2, name: 'Nguyễn Hoàng Duy', username: 'hoangduy', online: true, color: 'green', role: 'User', disabled: false },
  { id: 3, name: 'Trần Minh Anh', username: 'minhanh', online: false, color: 'amber', role: 'User', disabled: false },
  { id: 4, name: 'Lê Khánh Linh', username: 'khanhlinh', online: false, color: 'rose', role: 'User', disabled: false },
  { id: 5, name: 'Phạm Gia Huy', username: 'giahuy', online: true, color: 'violet', role: 'User', disabled: false },
  { id: 6, name: 'Tài khoản thử nghiệm', username: 'demo_user', online: false, color: 'amber', role: 'User', disabled: true },
]

export const CONVERSATIONS = [
  { id: 1, time: '10:42', unread: 0 },
  { id: 2, time: '10:30', unread: 2 },
  { id: 3, time: 'Hôm qua', unread: 1 },
  { id: 4, time: 'Thứ Sáu', unread: 0 },
  { id: 5, time: 'Thứ Năm', unread: 0 },
]

export const INITIAL_MESSAGES = {
  1: [
    { id: 1, self: false, text: 'Trung ơi, mình gửi lại phần thiết kế cơ sở dữ liệu nha.', time: '10:35' },
    { id: 2, self: false, fileId: 'db', time: '10:36' },
    { id: 3, self: true, text: 'Mình nhận rồi. Phần UserAID và UserBID rõ ràng hơn nhiều.', time: '10:38' },
    { id: 4, self: false, text: 'Ừ, mình cũng bổ sung nhật ký Admin rồi.\nChiều nay xem lại luồng truyền file nhé?', time: '10:40' },
    { id: 5, self: true, text: 'Oke, 14h nha. Mình chuẩn bị phần giao diện trước.', time: '10:42' },
  ],
  2: [
    { id: 1, self: false, text: 'Mình vừa cập nhật báo cáo tiến độ trên Sheet.', time: '10:28' },
    { id: 2, self: false, text: 'Bạn xem giúp mình các mốc triển khai nha.', time: '10:30' },
  ],
  3: [{ id: 1, self: false, text: 'Cảm ơn bạn, mình sẽ xem tài liệu tối nay.', time: '19:20' }],
  4: [{ id: 1, self: true, text: 'Mình đã gửi bản đề cương qua đây rồi nhé.', time: '16:12' }],
  5: [{ id: 1, self: false, text: 'Mai trao đổi thêm phần kiểm thử nha.', time: '14:08' }],
}

export const FILES = [
  { id: 'db', name: 'Thiet_ke_CSDL.pdf', size: '1.8 MB', owner: 1, status: 'done', date: 'Hôm nay, 10:36', type: 'PDF', progress: 100 },
  { id: 'report', name: 'Bao_cao_PBL4.docx', size: '2.4 MB', owner: 2, status: 'done', date: 'Hôm qua, 16:20', type: 'DOCX', progress: 100 },
  { id: 'src', name: 'Tai_lieu_tham_khao.zip', size: '12.3 MB', owner: 3, status: 'cancelled', date: '18/09, 14:12', type: 'ZIP', progress: 37 },
]

export const CALLS = [
  { id: 1, personId: 1, direction: 'out', duration: '12 phút 34 giây', date: 'Hôm qua, 15:30', result: 'completed' },
  { id: 2, personId: 2, direction: 'in', duration: '8 phút 12 giây', date: 'Hôm qua, 10:15', result: 'completed' },
  { id: 3, personId: 3, direction: 'in', duration: 'Không trả lời', date: '19/09, 09:40', result: 'missed' },
]

export const AUDIT_LOGS = [
  { id: 1, time: 'Hôm nay, 09:12', actor: CURRENT_USER.name, target: 'demo_user', action: 'Khóa', reason: 'Tài khoản thử nghiệm trạng thái bị khóa.' },
  { id: 2, time: 'Hôm qua, 16:40', actor: CURRENT_USER.name, target: 'minhanh', action: 'Mở khóa', reason: 'Đã hoàn tất kiểm tra tài khoản.' },
]

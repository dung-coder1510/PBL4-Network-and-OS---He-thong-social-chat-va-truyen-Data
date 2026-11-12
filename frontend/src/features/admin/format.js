export const queryString = values => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== '' && value != null)).toString()
export const time = value => value ? new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : 'Chưa ghi nhận'
export const number = value => value == null ? 'Chưa đo' : Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 1 })
export const actionName = action => action === 'DisableUser' ? 'Khóa' : 'Mở khóa'
export function bytes(value) {
  if (value == null) return 'Chưa đo'
  const unit = value >= 1073741824 ? 3 : value >= 1048576 ? 2 : value >= 1024 ? 1 : 0
  return `${number(value / 1024 ** unit)} ${['B', 'KB', 'MB', 'GB'][unit]}`
}
export const fileStatus = value => ({ offered: 'Chờ nhận', accepted: 'Đã chấp nhận', transferring: 'Đang truyền',
  completed: 'Hoàn tất', cancelled: 'Đã hủy', failed: 'Lỗi', expired: 'Hết hạn' })[value] || value
export const stageName = value => ({ offered: 'Gửi lời mời', accepted: 'Chấp nhận', negotiating: 'Thương lượng kết nối',
  'channel-open': 'Kênh truyền đã mở', connecting: 'Đang kết nối', connected: 'Đã kết nối', transferring: 'Đang truyền', verifying: 'Kiểm tra dữ liệu',
  completed: 'Hoàn tất', cancelled: 'Đã hủy', failed: 'Lỗi', expired: 'Hết hạn', 'failure-report': 'Báo cáo lỗi' })[value] || value

export const sourceName = value => ({ backend: 'Máy chủ', 'client-A': 'Bên gửi', 'client-B': 'Bên nhận' })[value] || value

# Giám sát quản trị

## Sử dụng

Khởi động lại backend sau khi build, chạy frontend và đăng nhập tài khoản Admin hiện có.
Mở mục Quản trị (`#admin`). Không có endpoint tự nâng quyền tài khoản.
Trang lấy một snapshot mỗi 5 giây, chờ request trước kết thúc; tab ẩn tạm ngừng poll.
401/403 dừng poll; lỗi khác backoff tối đa 30 giây. Dữ liệu cũ vẫn hiển thị kèm tuổi mẫu.

## Phạm vi đo và giới hạn

- HTTP: route template, thời gian elapsed, số byte thực đọc/ghi ở stream ứng dụng.
  Không tính TLS/header; request bị lỗi trước response có thể chưa có byte phản hồi trong bộ đo.
- SignalR: invocation riêng theo method; byte là ước tính JSON arguments/result,
  không bao gồm envelope, broadcast hoặc toàn bộ lưu lượng WebSocket.
- Thời gian bao gồm chờ trong pipeline/phương thức, không phải RTT mạng.
- Kết nối: do Hub filter ghi nhận, một connection không đồng nghĩa một thiết bị.
  Heartbeat chỉ cập nhật sau khi xử lý thành công; kết nối còn mở không đồng nghĩa người dùng đang thao tác.
- Trạng thái file chính thức từ SQL. Giai đoạn/byte do client báo được ghi riêng nguồn,
  không dùng để cấp quyền hoặc hoàn tất phiên. Chỉ endpoint của phiên hoạt động được báo.
- Client báo cùng giai đoạn tối đa 5 giây/lần, thay đổi giai đoạn báo ngay;
  backend giới hạn 8 báo cáo/5 giây/kết nối và kiểm tra trạng thái không lùi, byte không giảm/vượt kích thước.
- FailFile nhận mã lỗi allowlist; không lưu exception text tùy ý. Lỗi client là lời báo cáo,
  backend có nguồn lỗi riêng cho hết hạn, ngắt kết nối, tài khoản bị khóa, mất registry.

## Lưu trữ và độ mới

- Hỗ trợ một backend instance. Chưa tổng hợp nhiều máy/instance.
- Tối đa 20.000 mẫu request trong 15 phút, 5.000 sự kiện file trong 24 giờ.
  Nếu tràn mẫu, UI báo rõ thống kê không còn phản ánh toàn bộ cửa sổ thời gian.
- Snapshot lưu mỗi 30 giây tại `PBL4/App_Data/monitoring/snapshot.json` (gitignored).
  Kết nối sống không được khôi phục. Dừng đột ngột có thể mất mẫu chưa ghi;
  lỗi lưu trữ chỉ ghi warning, không làm hỏng chat. Thư mục cần quyền ghi của tài khoản chạy service.
- API chỉ trả 50 user và 50 phiên bằng keyset pagination, tối đa 500 connection
  thuộc trang user và 500 sự kiện thuộc trang file. Không có dữ liệu không được hiểu là 0.
- Màu tuổi mẫu: xanh <=10s, vàng >10..20s, đỏ >20s, xám khi chưa có mẫu.
  Đồng hồ client dùng performance.now; tuổi báo cáo file tính theo timestamp server và thời gian elapsed.
  Backend gửi lại snapshot không làm mới timestamp của báo cáo client.
- Phiên đã kết thúc không đổi trạng thái vì tuổi telemetry. Lịch sử cũ hết retention vẫn có metadata SQL,
  nguyên nhân chi tiết có thể không còn; hiển thị UNKNOWN thay vì suy đoán.

## Bảo vệ

API `/api/v1/admin/monitoring` yêu cầu policy Admin ở backend và giới hạn 30 request/phút/IP,
không xếp hàng. Danh tính telemetry lấy từ JWT và connectionId, không nhận userId do client khai.
Không thu nội dung chat/file, JWT, mật khẩu, SDP hoặc payload request vào nhật ký.
API giám sát bị loại khỏi biểu đồ HTTP; lời gọi ReportFileObservation vẫn thấy riêng theo tên Hub.
Đây là dashboard theo dõi, không tự động chặn tài khoản hoặc thay thế rate limiting API nghiệp vụ.

## Kiểm tra

- `dotnet run --project tests/monitoring/MonitoringChecks.csproj`
- `CODEX_NODE_MODULES=<thư mục có playwright> node tests/monitoring-ui.e2e.mjs`
- `npm run lint` và `npm run build` trong frontend.

Test backend kiểm tra bộ đếm, p95, giới hạn bộ nhớ, stream không mất dữ liệu, archive và khai báo policy.
Test trình duyệt dùng API giả lập, kiểm tra 4 bảng/biểu đồ, lọc, timeline, màu theo thời gian và dừng poll khi 403.
Các test này không thay thế kiểm thử đăng nhập Admin/User và truyền file hai máy trên SQL triển khai thực tế.

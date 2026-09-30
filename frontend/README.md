# Frontend Nối

Giao diện React cho đồ án PBL4 chat, gọi thoại và truyền tệp 1–1. Đăng ký, đăng nhập và đăng xuất đã nối REST API với backend .NET và SQL Server.

## Chạy giao diện

```powershell
npm install
npm run dev
```

Mở `http://localhost:5173`. Vite chuyển tiếp `/api` và WebSocket `/hubs`
đến backend HTTPS tại `https://localhost:7117`.

## Kiểm tra

```powershell
npm run lint
npm run build
```

## Phạm vi hiện tại

- Có các màn hình trò chuyện, danh bạ, cuộc gọi, tệp, quản trị và cài đặt.
- Nền sáng là mặc định; lựa chọn nền tối được lưu trong `localStorage`.
- Token nằm trong bộ nhớ React; tải lại trang phải đăng nhập lại.
- Hồ sơ, cuộc trò chuyện và lịch sử tin nhắn dùng dữ liệu thật từ backend.
- Có tìm người, tạo/mở lại cuộc trò chuyện, tìm kiếm và phân trang danh sách.
- Chat web gửi/nhận realtime qua `ChatHub`; tin được lưu SQL Server và tải lại bằng REST.
- Có trạng thái kết nối/gửi/nhận/đọc, gửi lại cùng `ClientMessageId`, unread và phân trang lịch sử.
- Presence, typing, reconnect tải bù và danh bạ một chiều đã nối dữ liệu thật.
- Chưa có WebRTC; cuộc gọi và truyền tệp chưa nối API.

Xem [hướng dẫn xác thực](../docs/authentication.md) để chạy backend, cấu hình database có sẵn và kiểm thử.
Xem [hướng dẫn cuộc trò chuyện](../docs/conversations.md) để sử dụng và kiểm thử API cuộc trò chuyện.

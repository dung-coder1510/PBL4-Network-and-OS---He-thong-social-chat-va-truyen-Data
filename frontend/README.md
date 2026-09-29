# Frontend Nối

Giao diện React cho đồ án PBL4 chat, gọi thoại và truyền tệp 1–1. Đăng ký, đăng nhập và đăng xuất đã nối REST API với backend .NET và SQL Server.

## Chạy giao diện

```powershell
npm install
npm run dev
```

Mở `http://localhost:5173`. Vite chuyển tiếp request bắt đầu bằng `/api` đến backend HTTPS tại `https://localhost:7117`.

## Kiểm tra

```powershell
npm run lint
npm run build
```

## Phạm vi hiện tại

- Có các màn hình trò chuyện, danh bạ, cuộc gọi, tệp, quản trị và cài đặt.
- Nền sáng là mặc định; lựa chọn nền tối được lưu trong `localStorage`.
- Token nằm trong bộ nhớ React; tải lại trang phải đăng nhập lại.
- Hồ sơ hiển thị thông tin thật từ backend. Chat/danh bạ/cuộc gọi/tệp đang hiển thị trạng thái trống, chờ nối API nghiệp vụ.
- Các trang mẫu cũ vẫn giữ trong source; chưa có kết nối SignalR hoặc WebRTC.

Xem [hướng dẫn xác thực](../docs/authentication.md) để chạy backend, cấu hình database có sẵn và kiểm thử.

# Frontend Nối

Giao diện React cho đồ án PBL4 chat, gọi thoại và truyền tệp 1–1. Bản hiện tại dùng dữ liệu mẫu để hoàn thiện bố cục và luồng thao tác trước khi nối API.

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
- Tin nhắn gửi trong giao diện chỉ tồn tại trong bộ nhớ trình duyệt.
- Chưa có xác thực, SignalR, WebRTC hoặc dữ liệu thật từ backend.

# Đăng ký, đăng nhập và đăng xuất

## Chạy trên máy hiện tại

Backend dùng **SQL Server, database PBL4 có sẵn**. Module này không gọi
`EnsureCreated`, `Migrate` hay tạo/reset database. Bảng `Users` cần khớp model
hiện tại, bao gồm `AvatarPath` nullable. Không có chức năng tải ảnh đại diện.

Ở thư mục gốc repository, mở hai terminal:

```powershell
dotnet run --project PBL4 --launch-profile https
```

```powershell
cd frontend
npm install
npm run dev -- --host 127.0.0.1
```

Mở http://127.0.0.1:5173, chọn Đăng ký. Đăng ký thành công sẽ chuyển về
form đăng nhập, giữ tên đăng nhập và xóa mật khẩu khỏi form.

`PBL4/appsettings.json` là cấu hình riêng của máy và được Git bỏ qua.
Máy khác có thể sao chép `PBL4/appsettings.example.json` thành file này,
sửa Server cho đúng SQL Server của máy; vẫn trỏ đến database đã chuẩn bị sẵn.
Ví dụ dùng Windows Authentication, không chứa SQL password.
`TrustServerCertificate=True` và Vite `secure:false` chỉ phục vụ môi trường local.
Production cần chứng chỉ hợp lệ, HTTPS và reverse proxy cho `/api`.

## Quy tắc tài khoản

Tên đăng nhập dài 3–32 ký tự, gồm chữ Latin không dấu, số, dấu chấm và gạch
dưới. Server lưu dạng chữ thường. Unique index SQL ngăn tên trùng kể cả khi
hai request đến đồng thời. Tên hiển thị tối đa 100 ký tự, không được rỗng.
Mật khẩu đăng ký dài 12–128 ký tự; giữ nguyên khoảng trắng.

Server băm mật khẩu bằng `PasswordHasher<User>` của ASP.NET Core Identity;
không lưu mật khẩu gốc và không trả PasswordHash trong JSON. DTO đăng ký
không nhận quyền Admin, trạng thái khóa hay đường dẫn avatar. Tài khoản mới
luôn là User, chưa bị khóa, AvatarPath null.

## REST API

| Method | Đường dẫn | Công dụng |
| --- | --- | --- |
| POST | /api/v1/users | Đăng ký; 201 trả hồ sơ, chưa tạo phiên |
| POST | /api/v1/sessions | Đăng nhập; 201 trả sessionId, accessToken, expiresAt, user |
| GET | /api/v1/users/me | Hồ sơ tài khoản hiện tại; cần Bearer token |
| DELETE | /api/v1/sessions/current | Thu hồi phiên đang gọi; 204 |

Đăng ký gửi JSON `{ username, displayName, password }`.
Đăng nhập gửi JSON `{ username, password }`.
Nhập lại mật khẩu chỉ để frontend kiểm tra, không gửi thêm lên server.
Hồ sơ trả về `{ id, username, displayName, role, avatarPath }`.

Các API cần xác thực nhận header `Authorization: Bearer <accessToken>`.
Lỗi dùng Problem Details: 400 dữ liệu sai, 401 thông tin đăng nhập/token sai,
403 tài khoản bị khóa khi đăng nhập, 409 trùng tên, 429 quá nhiều lần thử.
Đăng nhập sai username và sai password cùng trả một thông báo chung.
Đăng ký và đăng nhập dùng chung giới hạn 20 request/IP/phút, trả Retry-After
khi vượt giới hạn. Nếu chạy nhiều người qua Vite proxy, họ có thể chung IP
nhìn từ backend; khi triển khai cần cấu hình trusted proxy và giới hạn phù hợp.

## Phiên và phân quyền

JWT ký HMAC-SHA256, hết hạn sau 30 phút. Backend kiểm tra chữ ký, issuer,
audience, thời hạn, sessionId và trạng thái user trong DB. Khi user bị khóa,
token bị từ chối; role được đọc lại từ DB ở mỗi request có xác thực.
Policy `Admin` đã có để áp dụng cho các controller quản trị sau này.

Frontend giữ token trong bộ nhớ React, không ghi localStorage hay sessionStorage.
Tải lại trang phải đăng nhập lại. Chưa có refresh token hoặc ghi nhớ đăng nhập.
Frontend kiểm tra phiên khi quay lại cửa sổ và mỗi phút khi trang đang hiển thị;
hết hạn/thu hồi sẽ quay về màn hình đăng nhập. Mất mạng tạm thời không bị coi
là thu hồi phiên.

Đăng xuất thu hồi đúng phiên; phiên trên thiết bị khác vẫn dùng được.
Nếu không gọi được server, giao diện báo lỗi và cho thử lại, chưa báo đã đăng xuất.
Danh sách phiên đang nằm trong bộ nhớ backend (tối đa 10.000 phiên), nên restart
server sẽ làm tất cả phiên cũ mất hiệu lực. Chưa dùng cho nhiều instance cân bằng tải;
giai đoạn đó cần kho phiên chung, ví dụ Redis, cùng khóa ký JWT thống nhất.

Development tự tạo khóa ký ngẫu nhiên mỗi lần chạy nếu chưa cấu hình.
Ngoài Development, bắt buộc đặt `Jwt__SigningKey` qua biến môi trường hoặc secret store:
chuỗi bí mật ngẫu nhiên mạnh, tối thiểu 32 byte UTF-8. Không commit khóa ký vào Git.

## Giao diện và phạm vi hiện tại

AuthPage xử lý form đăng ký/đăng nhập, authApi đóng gói HTTP, App giữ phiên
và xử lý đăng xuất. Các trang vẫn là file riêng. Profile hiển thị tên và username
thật từ DB ở chế độ chỉ đọc. User thường không có mục Quản trị.

Sau đăng nhập, các trang chat/danh bạ/cuộc gọi/tệp hiển thị trạng thái trống.
Các component giao diện mẫu cũ vẫn giữ trong source, chưa nối với dữ liệu thật.
SignalR, WebRTC, cập nhật hồ sơ và upload avatar nằm ngoài phần triển khai này.

## Kiểm thử

Build và lint:

```powershell
dotnet build PBL4/PBL4.csproj
cd frontend
npm run lint
npm run build
```

Kiểm thử tích hợp tại thư mục gốc, khi backend và Vite đang chạy:

```powershell
$env:AUTH_TEST_SQL_SERVER = 'TRUNG'
$env:AUTH_TEST_DATABASE = 'PBL4'
node tests/auth.integration.mjs
```

Cần sqlcmd và quyền Windows đọc/ghi DB local. Script dùng username ngẫu nhiên,
chỉ thay role/khóa các tài khoản tự tạo và xóa đúng tài khoản của lượt chạy
trong finally; không tạo DB hay sửa user sẵn có. Nếu ngắt tiến trình cưỡng bức,
cần kiểm tra tài khoản thử còn sót. Đổi AUTH_TEST_SQL_SERVER theo máy.

19 kiểm tra bao gồm validation, lưu hash, tên trùng và đăng ký đồng thời,
không cho tự cấp Admin, login, hồ sơ, JWT bị sửa, thay role, khóa tài khoản,
thu hồi từng phiên và rate limit. Sau test rate limit, chờ tối đa một phút
trước khi thử form hoặc chạy lại.

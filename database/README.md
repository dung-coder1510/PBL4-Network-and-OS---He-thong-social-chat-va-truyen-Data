# Database đề xuất cho PBL4

Bản thiết kế dựa trên README bạn cung cấp: chat, gọi thoại và truyền file 1–1 theo kiến trúc P2P kết hợp server. Chọn **SQL Server 2022 trở lên**, phù hợp backend ASP.NET Core / EF Core và công cụ SQL Server sẵn trên máy.

## Đọc gì trước?

1. [Nhận xét, ERD và giải thích thiết kế](../docs/database-design.md).
2. [SQL tạo 7 bảng, index, trigger và ràng buộc](01_schema.sql).
3. [Truy vấn danh sách chat, lịch sử, tin chưa nhận, file và cuộc gọi](02_queries.sql).
4. [Kiểm thử ràng buộc](tests/verify.sql) và [script chạy trên LocalDB](tests/run-verify.ps1).

## Quyết định quan trọng

- Server lưu bản sao **tất cả tin nhắn text** để phục vụ lịch sử và tin offline. Bản này chốt một điểm còn bỏ ngỏ trong README: chỉ lưu tin offline sẽ không có đủ lịch sử các tin P2P.
- File và âm thanh đi qua WebRTC; DB chỉ lưu metadata và trạng thái. Không có chức năng tải lại file từ server.
- `Contacts` là danh bạ một chiều. Đồng bộ từng thiết bị, chat nhóm và quy trình kết bạn nằm ngoài bản này.
- Backend đã đăng ký `AppDbContext` với SQL Server. Các API nghiệp vụ vẫn chưa được triển khai.

## Tạo database phát triển

Trong SSMS, kết nối SQL Server của bạn, tạo một database mới, ví dụ `PBL4_Realtime`, rồi chọn database đó để chạy `01_schema.sql`.

Hoặc dùng `sqlcmd` với Windows Authentication; thay server và tên database cho đúng máy:

```powershell
sqlcmd -S "(localdb)\MSSQLLocalDB" -E -b -d master -Q "CREATE DATABASE PBL4_Realtime;"
sqlcmd -S "(localdb)\MSSQLLocalDB" -E -b -f 65001 -d PBL4_Realtime -i .\database\01_schema.sql
```

Chạy lệnh từ thư mục gốc repository. LocalDB phải đang chạy. Với SQL Server Authentication, dùng cấu hình kết nối riêng; không ghi mật khẩu vào repository.

`01_schema.sql` chạy **một lần trên database mới**, từ chối system database và từ chối nếu đã có bảng trùng tên. Script không chuyển đổi dữ liệu của database cũ. Nếu dùng công cụ chạy SQL khác `sqlcmd`, chọn chế độ dừng khi gặp lỗi. Toàn bộ phần tạo bảng/index/trigger nằm trong một transaction.

## Kiểm thử độc lập trên LocalDB

```powershell
powershell -ExecutionPolicy Bypass -File .\database\tests\run-verify.ps1
```

Script khởi động instance LocalDB đã cài, tạo database riêng tên `PBL4_Review_Test`, tạo schema, chạy kiểm thử và chạy các truy vấn mẫu. File MDF/LDF và kết quả truy vấn nằm trong `database/tests/.local/`, được Git bỏ qua. Script không thay cấu hình backend.

Script dừng nếu database hoặc file test đã tồn tại. Dữ liệu test được giữ lại để mở bằng SSMS; test có password hash giả, chỉ dùng kiểm tra schema, không phải tài khoản đăng nhập mẫu. Muốn chạy lại trên database test đã tạo, suite `verify.sql` yêu cầu dữ liệu trống; hãy dùng một môi trường test mới hoặc chủ động quản lý database test trước khi chạy lại. Không chạy suite trên dữ liệu ứng dụng.

### Kết quả đã kiểm tra ngày 23/09/2026

- Chạy thực tế trên `MSSQLLocalDB` phiên bản `17.0.1000.7`, database `PBL4_Review_Test`.
- Tạo thành công **7 bảng và 5 trigger**, bao gồm `Role`, `AdminAuditLogs` và trigger bảo vệ nhật ký.
- **78/78 kiểm tra đạt**, bao gồm kiểm tra `Role`, tính hợp lệ và tính bất biến của `AdminAuditLogs`, cùng các ràng buộc chat, file và cuộc gọi.
- Chạy thành công cả 6 truy vấn mẫu; kết quả nằm trong `tests/.local/query-results.txt`.
- Đã kiểm tra cú pháp PowerShell của runner. Chưa kiểm thử tích hợp EF Core, API phân quyền hay luồng WebRTC vì các phần đó chưa được triển khai trong backend.

## Khi nối EF Core

- `int` ↔ `INT`, `long` ↔ `BIGINT`, `Guid` ↔ `UNIQUEIDENTIFIER`, `byte[]` ↔ `VARBINARY`/`ROWVERSION`.
- Map `RowVersion` bằng `.IsRowVersion()`. Khi cập nhật xung đột, đọc lại trạng thái và xử lý retry phù hợp; không ghi đè mù.
- Giữ `DATETIME2(3)` theo UTC. API gắn UTC rõ ràng khi serialize; SQL `datetime2` không lưu múi giờ.
- Map quan hệ xóa thành `DeleteBehavior.NoAction`; dùng `IsDisabled` khi khóa tài khoản.
- Bốn bảng có trigger cần cấu hình EF SQL Server `.ToTable(tb => tb.UseSqlOutputClause(false))`: `DirectConversations`, `Messages`, `FileTransfers`, `Calls`.
- Chọn một cách quản lý schema: dùng script này để khởi tạo rồi thiết lập migration baseline, hoặc chuyển đầy đủ bảng, index, CHECK và trigger sang migration. Không chạy đồng thời hai bộ khởi tạo lên cùng DB.
- API phải kiểm tra quyền, payload bất biến, thứ tự chuyển trạng thái và ACK. FK/CHECK/trigger không thay thế xác thực người dùng.

Nguồn kỹ thuật: [SQL Server CREATE TABLE](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-table-transact-sql?view=sql-server-ver17), [EF Core SQL Server: bảng có trigger](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/misc#savechanges-triggers-and-the-output-clause).

# Truyền file Web ↔ Web

## Chạy và sử dụng

Backend: `dotnet run --project PBL4/PBL4.csproj --launch-profile https`.
Frontend: tại `frontend`, chạy `npm install` nếu chưa cài dependency, rồi `npm run dev`.
Cấu hình SQL/JWT theo [authentication.md](authentication.md).
Không thêm thư viện runtime, migration hoặc cột database; sử dụng bảng `FileTransfers` có sẵn.

1. Đăng nhập hai tài khoản trong hai cửa sổ/tab. Tạo cuộc trò chuyện giữa hai người
   từ mục Trò chuyện hoặc Danh bạ.
2. Ngay trong cuộc trò chuyện, bấm **Gửi file** cạnh ô soạn tin rồi chọn file tối đa
   **100 MiB**. Lời mời tự gửi đến người đang trò chuyện, không cần chọn lại người nhận;
   bản nháp tin nhắn được giữ nguyên. Hoặc mở **Tệp**, chọn cuộc trò chuyện/file và bấm **Gửi lời mời**.
3. Người nhận thấy thông báo dù đang ở trang chat. Mở **Tệp**, chọn **Chấp nhận** hoặc **Từ chối**.
4. Giữ hai tab mở. Giao diện hiển thị số byte, tốc độ trung bình và trạng thái.
   Hết byte gửi chưa có nghĩa là đã hoàn tất: cần người nhận xác nhận đủ byte và SHA-256.
5. Người nhận bấm **Tải xuống** để lưu file về máy. Có thể đổi trang trong ứng dụng
   trong lúc truyền. Đóng/reload tab làm mất file chưa lưu; lịch sử SQL không chứa nội dung file.

## Đường truyền

```text
A -- SignalR/ChatHub: lời mời, chấp nhận, SDP, ICE, trạng thái --> Server --> B
A =============== WebRTC DataChannel: byte file ======================= B
Server ---------------- metadata, trạng thái ---------------------- SQL Server
```

MVP dùng ngay `ChatHub` cho báo hiệu file, chưa tạo `SignalingHub` riêng như bản thiết kế
dài hạn. Nhờ dùng cùng connection, server ràng buộc trực tiếp tab gửi và tab nhận,
không cần thêm socket hoặc `clientInstanceId`. SignalR chỉ mang metadata/báo hiệu;
TURN có thể relay lưu lượng WebRTC khi hai peer không nối trực tiếp được.

`FileTransferService` giữ registry endpoint trong RAM, tối đa 1.000 phiên toàn server
và 2 phiên chờ/đang truyền cho mỗi tài khoản. Các thay đổi trạng thái tuần tự qua semaphore;
SQL RowVersion ngăn lệnh từ phiên bản cũ ghi đè. Thiết kế này dành cho **một backend instance**.
Không tuyên bố đã kiểm thử tải 1.000 phiên truyền file.

JWT/filter xác thực mỗi lệnh. Server kiểm tra thành viên cuộc trò chuyện, tài khoản,
vai trò gửi/nhận và connection đã ràng buộc. Hai tab nhận cùng bấm chấp nhận thì chỉ một tab thắng.
SDP/ICE chỉ chuyển đến tab đã chọn; các tab khác chỉ nhận metadata trạng thái.
`ClientTransferId` chống trùng lời mời, không cho tái sử dụng ID với metadata khác.

## Giao thức tự viết

- Một file trên một DataChannel `file-v1`, ordered và reliable.
- Mỗi binary message: `uint32` big-endian thứ tự chunk (bắt đầu 0), theo sau tối đa
  **16 KiB** payload. DataChannel giữ ranh giới message.
- Khung cuối là chuỗi JSON chính xác `{"type":"end"}`; file rỗng chỉ cần khung này.
- Receiver từ chối chunk lặp, đảo thứ tự, quá lớn, vượt tổng byte hoặc kết thúc sớm.
- Sender đọc từng lát file; khi `bufferedAmount > 256 KiB` thì chờ xuống
  `64 KiB`, có hủy và timeout 30 giây. Không nạp toàn file vào hàng đợi DataChannel.
- Trước `CompleteFile`, receiver chờ metadata `transferring` từ server để dùng
  RowVersion mới. Dữ liệu WebRTC có thể đến trước thông báo SignalR; hủy,
  disconnect hoặc timeout sẽ dừng việc chờ và không xác nhận hoàn tất.
- Receiver ghép Blob, tính SHA-256 rồi gọi `CompleteFile`. Server chỉ đối chiếu
  **hash do receiver báo** với hash đã thỏa thuận, không tự đọc hay hash nội dung file.
  SHA-256 không phải công cụ phát hiện mã độc.
- `crypto.subtle.digest` cần ArrayBuffer đầy đủ; bước hash và ghép Blob còn sử dụng RAM
  theo kích thước file. Đây chưa phải cách stream file rất lớn trực tiếp xuống đĩa.
- Tab giữ tối đa 2 Blob đã nhận để tải xuống; tệp cũ hơn được giải phóng tự động.
  Nút **Giải phóng tệp**, logout, hủy và lỗi dọn URL/buffer/peer/timer tương ứng.
- Listener nằm trong `FileTransferProvider`, sống cùng phiên đăng nhập, không phụ thuộc
  trang Tệp đang mở. Đổi trang không làm dừng truyền.

WebRTC dùng mã hóa DTLS của trình duyệt; dùng HTTPS cho API và báo hiệu khi triển khai.
Không tự viết thuật toán mã hóa.

## Trạng thái và thời gian

```text
offered -> accepted -> transferring -> completed
offered -> rejected / expired / cancelled
accepted / transferring -> failed / cancelled
```

Lời mời hết hạn sau 60 giây, kết nối sau khi chấp nhận có 45 giây.
Worker quét mỗi 5 giây nên thông báo hết hạn có thể trễ thêm một nhịp quét.
Client ngừng phiên khi 60 giây không tiến triển; server giới hạn phiên truyền
30 phút kể từ `BeginFileTransfer`. Không dùng heartbeat presence làm bằng chứng
người nhận đã chấp nhận file.

Ngắt connection, token bị thu hồi/hết hạn hoặc tài khoản bị khóa làm kết thúc
phiên liên quan. Server restart khiến phiên còn dang dở trong SQL thành expired/failed
khi worker chạy; không phục hồi chunk hay resume. Lỗi/mất kết nối cần chọn và gửi lại file.
Các client tuân thủ sẽ đóng DataChannel khi nhận trạng thái kết thúc; server không thể
cưỡng ép hai client đã bị sửa tiếp tục hay ngừng truyền trên đường P2P.

## Cấu hình mạng

Mặc định `WebRtc:IceServers` là mảng rỗng, thích hợp thử localhost hoặc mạng mà
host ICE candidate liên lạc được. **Chưa bảo đảm kết nối qua Internet/khác NAT**.
Triển khai thật cần STUN và thường cần TURN. Cấu hình tương thích `RTCIceServer`:

```json
{
  "WebRtc": {
    "IceServers": [
      { "Urls": ["stun:stun.example.org:3478"] },
      {
        "Urls": ["turn:turn.example.org:3478"],
        "Username": "replace-with-turn-user",
        "Credential": "replace-with-turn-credential"
      }
    ]
  }
}
```

Các địa chỉ trên là ví dụ, không phải máy chủ đang chạy.
Đưa cấu hình nhạy cảm vào user-secrets/biến môi trường, không commit credential.
API `/api/v1/files/configuration` chỉ trả cấu hình cho người đã đăng nhập;
credential TURN được cấp cho browser, vì vậy triển khai public nên cấp credential ngắn hạn.
Chạy web trên HTTPS hoặc localhost để dùng Web Crypto. Nếu dùng domain khác,
cấu hình CORS/JWT/proxy như các phần chat hiện tại.

## API và mã nguồn

| Thành phần | Chức năng |
| --- | --- |
| `GET /api/v1/files?beforeId=...` | Lịch sử của chính thành viên, 50 dòng/trang, `nextCursor` |
| `GET /api/v1/files/configuration` | Giới hạn file và danh sách ICE server |
| `OfferFile` | Tạo lời mời, lưu metadata, phát `FileChanged` |
| `AcceptFile` / `RejectFile` | Quyết định của người nhận, kiểm tra RowVersion |
| `SendFileSignal` | `offer` / `answer` SDP và `ice` JSON, ràng buộc connection |
| `BeginFileTransfer` | Tab gửi báo DataChannel đã mở sau trao đổi SDP |
| `CompleteFile` | Tab nhận xác nhận đủ byte và SHA-256 |
| `CancelFile` / `FailFile` | Kết thúc bởi một trong hai endpoint |
| `FileChanged` / `FileSignal` | Server phát metadata / báo hiệu đến client |

Hợp đồng đầy đủ: `PBL4/Contracts/FileDtos.cs`. Không nhận SenderId từ client.
Các action gửi `{ transferId, expectedVersion }`; complete thêm
`receivedBytes, verifiedSha256Hex`. `SendFileSignal` gửi `{ transferId, kind, payload }`.
SDP tối đa 24.000 ký tự và vẫn chịu giới hạn message SignalR mặc định 32 KiB;
ICE tối đa 4.096 ký tự, 128 candidate mỗi phía/phiên.

Backend: `Services/FileTransferService.cs`, `Realtime/FileTransferMonitor.cs`,
`Realtime/ChatHub.cs`, `Controllers/FilesController.cs`.
Frontend: `services/fileProtocol.js` (frame/hash/backpressure),
`services/fileTransferState.js` (chờ đồng bộ trạng thái, hủy và timeout),
`services/fileTransfers.js` (WebRTC/lifecycle), `realtime/FileTransferProvider.jsx`,
`pages/FilesPage.jsx`.

## Kiểm thử

Không cần server:

```powershell
node --test tests/file-protocol.mjs tests/file-transfer-state.mjs tests/frontend-heartbeat.mjs
dotnet run --project tests/presence/PresenceChecks.csproj
```

API/SignalR thật, yêu cầu backend + Vite đang chạy, SQL cùng database của backend:

```powershell
$env:AUTH_TEST_SQL_SERVER = 'ten-sql-server-local'
$env:AUTH_TEST_DATABASE = 'PBL4'
$env:FILE_TEST_ORIGIN = 'http://127.0.0.1:5173'
node tests/files.integration.mjs
```

Script tạo tài khoản có prefix ngẫu nhiên, chỉ xóa dữ liệu mình tạo trong `finally`.
Có kiểm tra hết hạn thật nên mất hơn 60 giây. Bài này kiểm tra control plane;
nó mô phỏng SDP/hash, không thay thế bài truyền byte bằng browser.

Đã kiểm tra ngày 2026-10-20 trên Chrome local:

- File nhị phân 10 MiB + 17 byte: hash nội dung Blob nhận bằng hash nguồn.
- File rỗng và file 100 MiB hoàn tất qua WebRTC thật.
- Chuyển từ Tệp sang Chat ở phía gửi vẫn tiếp tục truyền.
- Hai tab cùng tài khoản nhận: chỉ tab chấp nhận có Blob tải xuống.
- Từ chối/hủy cập nhật cả hai phía; giải phóng file thu hồi Blob URL.
- Không có lỗi JavaScript chưa xử lý trong các ca trên.

10 nhóm kiểm tra API/SignalR và 6 bài protocol đều qua. 9 bài presence và
5 bài heartbeat frontend cũng qua. Có thêm 8 bài chờ trạng thái, kiểm tra
metadata đến chậm, phiên kết thúc, abort, timeout và dọn listener.
Kiểm tra browser với `transferring` đến chậm 2 giây: file 4 KiB và file rỗng
vẫn hoàn tất; hủy trong lúc chờ không tạo file tải xuống.
Test presence còn cảnh báo NuGet có sẵn
cho `System.Security.Cryptography.Pkcs 9.0.11`; tính năng này không thay đổi dependency đó.
Chưa đo khả năng chịu tải nhiều phiên file, RAM dài hạn hoặc kiểm thử TURN/WAN.

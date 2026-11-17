# Truyền file Web ↔ Web

## Chạy và sử dụng

Backend: `dotnet run --project PBL4/PBL4.csproj --launch-profile https`.
Frontend: tại `frontend`, chạy `npm install` nếu chưa cài dependency, rồi `npm run dev`.
Cấu hình SQL/JWT theo [authentication.md](authentication.md).
Sử dụng bảng `FileTransfers` có sẵn. Frontend dùng `@noble/hashes` 2.4.0
để tính SHA-256 theo từng phần. Chạy `npm install` sau khi cập nhật mã nguồn.
Để bật `file-v4` trên database đã có, áp dụng migration `DeferredFileHash` nếu
database được quản lý bằng EF. Với database khởi tạo từ SQL, chạy
[003_deferred_file_hash.sql](../database/migrations/003_deferred_file_hash.sql).
Migration giữ hash của các phiên đã lưu. Cập nhật backend và tải lại frontend ở
cả hai máy để dùng v4. Trên database chưa nâng cấp, client dùng v3 cho file lớn.

1. Đăng nhập hai tài khoản trong hai cửa sổ/tab. Tạo cuộc trò chuyện giữa hai người
   từ mục Trò chuyện hoặc Danh bạ.
2. Ngay trong cuộc trò chuyện, bấm **Gửi file** cạnh ô soạn tin rồi chọn file tối đa
   **10.737,4 MB** (10.737.418.240 byte). File **lớn hơn 1.073.741.824 byte**
   (xấp xỉ 1.073,7 MB) hiện cảnh báo trước khi gửi lời mời. Chọn **Tiếp tục gửi** hoặc **Hủy**.
   Lời mời tự gửi đến người đang trò chuyện, không cần chọn lại người nhận;
   bản nháp tin nhắn được giữ nguyên. Hoặc mở **Tệp**, chọn cuộc trò chuyện/file và bấm **Gửi lời mời**.
3. Ngay khi gửi lời mời, cả hai thấy một thẻ file xen kẽ tin nhắn trong đúng cuộc trò chuyện.
   Người nhận chọn **Nhận file** hoặc **Từ chối** ngay trên thẻ; người gửi có **Hủy gửi**.
   Trang **Tệp** vẫn hiển thị cùng phiên truyền để xem tổng hợp.
4. Giữ hai tab mở. Cùng thẻ đó cập nhật tiến độ, số byte, tốc độ trung bình và nút **Hủy**.
   Hết byte gửi chưa có nghĩa là đã hoàn tất: cần người nhận xác nhận đủ byte và SHA-256.
5. Trên trình duyệt hỗ trợ, **Nhận file** mở hộp **Lưu thành (Save As)** để chọn
   tên file và vị trí lưu. App ghi từng phần vào đích đã chọn rồi chốt file
   sau khi kiểm tra đủ byte và SHA-256. File tối đa **104,9 MB** (104.857.600 byte) có thể chọn **Nhận để tải xuống**
   để dùng cách nhận vào bộ nhớ. Trình duyệt thiếu API ghi file chỉ tự dùng cách này
   với file nhỏ; file lớn bắt buộc hai bên dùng phiên bản mới và máy nhận hỗ trợ ghi đĩa.
   Có thể đổi trang trong ứng dụng trong lúc truyền.

App chỉ xin quyền ghi một file qua `showSaveFilePicker`, không xin quyền quản lý
cả thư mục. Có thể chọn các thư mục thông thường trên ổ C, D hoặc ổ khác nếu
trình duyệt và tài khoản Windows cho phép ghi. Thư mục hệ thống hoặc vị trí bị
chặn vẫn không dùng được; bản web không thể bỏ qua giới hạn đó.
[Giới hạn thư mục của Chrome](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access#restricted-folders)

Bạn có thể đổi tên ngay trong hộp Lưu thành nhưng phải giữ đuôi file gốc
(không phân biệt chữ hoa/thường). Ví dụ `A.m4a` có thể lưu thành `Bản thu.m4a`,
không thể lưu thành `B.exe`. App lọc loại file trong picker nếu đuôi được API
hỗ trợ, rồi kiểm tra tên của handle trả về trước khi gọi `AcceptFile` hay mở
writer. Chọn sai đuôi hiện lỗi và giữ lời mời để chọn lại. Khi rút ngắn tên
dài hoặc thay tên dành riêng của Windows, tên gợi ý cũng giữ phần đuôi.
[Bộ lọc của File System Access](https://wicg.github.io/file-system-access/#file-picker-options)

Muốn giữ file đã tồn tại, hãy chọn tên mới. Trong Chrome, xác nhận thay thế
trong **Lưu thành** có thể làm rỗng file cũ ngay khi chọn đích. Hủy stream
chỉ bỏ phần ghi chưa công bố và không hoàn tác thao tác của picker.
Trình duyệt có thể tạo sẵn file đích rỗng, vẫn còn khi phiên thất bại.
[Cách Chromium xử lý Lưu thành](https://github.com/chromium/chromium/blob/main/content/browser/file_system_access/file_system_access_manager_impl.cc#L1950-L1969)

Thẻ hoàn tất hiển thị **Đã gửi** ở bên gửi. Bên nhận v2 trở lên thấy
**Đã lưu trên máy** sau khi file đích đã đóng thành công và server xác nhận.
Nếu mất phản hồi xác nhận, thẻ hiện **Đã lưu trên máy, chưa xác nhận với máy chủ**.
Với `file-v1`, tab giữ Blob và hiện **Sẵn sàng tải xuống**. Cần tải file đó
trước khi đóng/reload tab. Lịch sử trên SQL chứa metadata và trạng thái phiên.

Lịch sử riêng lấy từ `GET /api/v1/conversations/{id}/files?beforeId=...`, mỗi trang tối đa
50 phiên, kiểm tra quyền thành viên trước khi trả metadata. Trong chat, **Xem tin nhắn cũ hơn**
tải cả các trang text/file còn lại. Lời mời file cập nhật preview `[Tệp] tên_file` và thời gian
hoạt động của conversation; không chèn tin text giả vào bảng `Messages`.

## Đường truyền WebRTC

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

## Giao thức ghi đĩa

`OfferFile` thêm `supportedProtocols` và `requestedChannelCount`.
`AcceptFile` chọn `protocolVersion` và `channelCount`. Backend kiểm tra số kênh
được đề nghị rồi phát cấu hình qua `FileChanged`. File tối đa 100 MiB quảng bá
`file-v1` và `file-v2`. File lớn quảng bá `file-v4` nếu có Web Worker
và máy chủ hỗ trợ chốt hash sau lời mời; trường hợp còn lại dùng `file-v3`.
Hai tab cần dùng giao thức đã thương lượng.

DataChannel tin cậy và có thứ tự. File được chia thành khối tối đa 16 KiB.
`file-v2-0` giữ vị trí byte **uint32, 4 byte big-endian**, giới hạn 100 MiB.
Từ v3, khung dùng **uint64, 8 byte big-endian**, đủ cho
vị trí vượt 4 GiB; giới hạn 10 GiB. Máy nhận mở writer của đích đã chọn
trước khi chấp nhận và gửi `READY` khi kênh mở. Máy gửi gọi
`BeginFileTransfer` sau `READY`. Cách lưu này cần HTTPS hoặc
localhost và trình duyệt hỗ trợ File System Access.

V2/v3 giữ hạn mức chưa ACK 512 KiB và ACK mỗi 64 KiB. V4 dùng hạn mức
2 MiB và gom tối đa 256 KiB mỗi lượt ghi. Máy nhận ACK sau khi writer
ghi thành công từng lô và ở cuối. Tiến độ gửi tính theo ACK, tiến độ
nhận tính theo số byte đã ghi. Buffer WebRTC ở đầu gửi có hạn mức riêng.

V4 gửi lời mời với hash chưa chốt. Web Worker đọc lô 512 KiB, cập nhật SHA-256
theo thứ tự và chuyển buffer cho luồng gửi, tối đa một lô đọc trước.
Tab gửi gọi `FinalizeFileHash` với hash của toàn file trước khung `END`.
Server chỉ chấp nhận hash do tab gửi của phiên cung cấp và không cho đổi hash.
V1/v2/v3 vẫn tính hash nguồn trước lời mời.

Máy nhận cập nhật hash từ byte đã nhận và ghi thành công.
Sau `END`, máy nhận chờ đủ byte và hash đã chốt, so sánh rồi đóng writer.
`CompleteFile` chỉ được gọi sau khi đóng file thành công. Bản lưu được
giữ nếu mất phản hồi từ server. Lỗi trước khi chốt sẽ hủy writer.
Chrome có thể ghi vào file `.crswap` cạnh đích rồi đổi khi đóng writer.
App không ghi thêm bản OPFS hay chép toàn bộ file ở cuối.
[File System API](https://fs.spec.whatwg.org/#dom-filesystemwritablefilestream-write)

### Thử truyền từ 1 đến 8 kênh

Bật **Cài đặt → Nhà phát triển → Kích hoạt chế độ nhà phát triển** rồi chọn
**Số kênh truyền file**. Thiết lập lưu trên trình duyệt và áp dụng từ lời mời
tiếp theo. Mặc định là một kênh. Trong chế độ này, thẻ file hiện số kênh
đã chốt và tốc độ đo được trong phiên.

Khi bật thử nghiệm, lời mời thêm `file-v5` cùng giao thức một kênh phù hợp với
tệp. Cấu hình 1 kênh trong chế độ thử dùng v5 để đo cùng cách ghi và hạn mức
bộ đệm với các cấu hình 2–8 kênh. Tab nhận chọn v5 nếu hỗ trợ hoặc chấp nhận
bằng giao thức một kênh đã đề nghị. Với file lớn, server đã có migration hash
hỗ trợ gửi lời mời trước khi chốt SHA-256. Trên database cũ, nguồn tính
SHA-256 trước lời mời.

V5 mở các DataChannel có thứ tự trên cùng một `RTCPeerConnection`, chờ `READY`
ở tất cả kênh rồi gửi. Khối thứ `i` đi qua kênh `i % channelCount`. Máy nhận
kiểm tra offset theo từng kênh, giữ các khối đến sớm trong cửa sổ chung và ghi
byte liên tiếp vào một file đích. V5 dùng tổng cửa sổ 2 MiB và các lượt ghi
tối đa 256 KiB. Kênh 0 báo ACK cho số byte liên tiếp đã ghi. Máy nhận đợi `END`
từ mọi kênh trước khi kiểm tra SHA-256 và chốt file. Lỗi trên một kênh kết thúc
phiên. Đo riêng đường trực tiếp và TURN để chọn số kênh phù hợp.

### Thử hai kết nối WebRTC riêng

Bật **Hai kết nối WebRTC riêng** trong **Cài đặt → Nhà phát triển**. Lượt gửi
tiếp theo đề nghị `file-v6` với hai `RTCPeerConnection` và một DataChannel
trên mỗi kết nối. SignalR dùng `ConnectionIndex` 0 hoặc 1 để chuyển SDP và
ICE. Phiên chỉ bắt đầu gửi khi cả hai kênh báo `READY`. Cách chia khối,
cửa sổ ACK, ghi vào một file và xác minh SHA-256 dùng chung với v5.

Tab nhận chốt v6 nếu hỗ trợ. Nếu tab chỉ hỗ trợ v5 hoặc chế độ một kênh,
hai bên dùng giao thức tương thích đã ghi trong lời mời. Tắt công tắc
để thử lại bằng nhiều kênh chung một kết nối.

## Chuyển tiếp trực tiếp qua HTTPS

Trong **Trò chuyện** hoặc **Tệp**, chọn **Gửi qua máy chủ** để dùng HTTPS từ đầu.
Khi một phiên WebRTC đang dùng chế độ ghi đĩa gặp lỗi báo hiệu hoặc mất kênh,
ứng dụng chuyển chính thẻ đó sang **Qua máy chủ** và truyền lại từ byte đầu.
Máy nhận tiếp tục dùng file đích đã chọn nếu còn quyền ghi.

Hai bên giữ tab mở đến khi hoàn tất. Trước khi A tải lên, B bấm **Nhận file**,
chọn nơi lưu bằng trình duyệt hỗ trợ File System Access và mở luồng tải xuống.
Backend chuyển tiếp ngay sau mỗi lần đọc tối đa **64 KB**, giới hạn vùng đệm
payload do ứng dụng cấp phát ở **4 MB mỗi phiên**, với tối đa 16 phiên đã cấp vùng đệm.
Khi vùng đệm đầy, backend chờ luồng tải xuống giải phóng chỗ trước khi đọc tiếp.
Nginx, hệ điều hành và trình duyệt có bộ đệm riêng.

B ghi file theo luồng và kiểm tra đủ byte và SHA-256 trước khi đóng file đích.
Bên gửi tính SHA-256 trước khi tải lên bằng HTTPS.
B gửi một biên nhận sau khi lưu. Biên nhận dùng khóa riêng của phiên để hoàn tất
được cả khi JWT hết hạn trong lúc hai luồng HTTP đang chạy. Nếu mất một luồng,
phiên dừng và gửi lại từ đầu. SQL lưu metadata và trạng thái, còn nội dung file
và chế độ chuyển tiếp đang chạy nằm trong RAM của một backend instance.

API dưới `/api/v1/files` dùng `POST /relay` để tạo lời mời, `POST /{id}/relay`
để chuyển một phiên WebRTC, `POST /{id}/relay/accept` để nhận và `DELETE /{id}/relay`
để kết thúc sớm. Hai luồng `PUT` và `GET` dùng chung `/{id}/relay/content`.
B gửi biên nhận tới `POST /{id}/relay/complete`.
Khi frontend và API ở hai origin, khai báo origin frontend trong `Cors:AllowedOrigins`
để trình duyệt đọc header `X-File-SHA256`. [Cấu hình CORS trong ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/cors#set-the-exposed-response-headers)

Với cấu hình triển khai Nginx hiện có, thêm `location` sau trong `server` đang
phục vụ `/api/`. Giữ đường dẫn request và tắt gom body ở cả hai chiều trên route
truyền byte. [Tài liệu Nginx](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_request_buffering)

```nginx
location ~ ^/api/v1/files/[0-9]+/relay/content$ {
    proxy_pass http://127.0.0.1:5000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_cache off;
    client_max_body_size 10737418240;
    client_body_timeout 120s;
    proxy_send_timeout 120s;
    proxy_read_timeout 120s;
}
```

## Giao thức file-v1 tương thích

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
- Phía nhận `file-v1` ghép Blob và dùng `crypto.subtle.digest` với ArrayBuffer
  đầy đủ. Phía gửi luôn tính hash theo từng phần.
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
Client phát hiện đình trệ sau 60 giây khi đang truyền, ghi, băm hoặc lưu.
Máy gửi v2 trở lên chuyển sang chờ xác nhận khi toàn bộ byte đã được ACK. Server
giới hạn cả phiên 30 phút kể từ `BeginFileTransfer`. Phiên đăng nhập hiện cũng
hết hạn sau 30 phút tính từ đăng nhập; tăng giới hạn dung lượng không kéo dài
JWT hoặc bổ sung resume. File lớn cần hoàn tất trước khi phiên hết hạn.

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
| `GET /api/v1/files/configuration` | Giới hạn file và số kênh, danh sách ICE và hỗ trợ hash chốt sau |
| `OfferFile` | Tạo lời mời, lưu metadata, phát `FileChanged` |
| `AcceptFile` / `RejectFile` | Quyết định của người nhận, kiểm tra RowVersion |
| `SendFileSignal` | `offer` / `answer` SDP và `ice` JSON, ràng buộc connection |
| `BeginFileTransfer` | Tab gửi báo DataChannel đã mở sau trao đổi SDP |
| `FinalizeFileHash` | Tab gửi v4/v5 chốt SHA-256, không cho đổi hash đã lưu |
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
`services/fileStreamProtocol.js` (READY/ACK/END, băm từng phần và cửa sổ gửi),
`services/fileHashWorker.js` (đọc và băm từng lô ở bên gửi),
`services/fileStorage.js` (ghi đích, băm và chốt file đã xác minh),
`services/fileTransferState.js` (chờ đồng bộ trạng thái, hủy và timeout),
`services/fileTransfers.js` (WebRTC/lifecycle), `realtime/FileTransferProvider.jsx`,
`pages/FilesPage.jsx`.

## Kiểm thử

Không cần server:

```powershell
node --test tests/file-protocol.mjs tests/file-stream-protocol.mjs tests/file-large-protocol.mjs tests/file-storage.mjs tests/file-transfer-state.mjs tests/frontend-heartbeat.mjs
dotnet run --project tests/presence/PresenceChecks.csproj
dotnet run --project tests/file-relay/FileRelayChecks.csproj
```

API/SignalR thật, yêu cầu backend + Vite đang chạy, SQL cùng database của backend:

```powershell
$env:AUTH_TEST_SQL_SERVER = 'ten-sql-server-local'
$env:AUTH_TEST_DATABASE = 'PBL4_Test_Rieng'
$env:FILE_TEST_ORIGIN = 'http://127.0.0.1:5173'
node tests/files.integration.mjs
```

Script tạo tài khoản có prefix ngẫu nhiên, chỉ xóa dữ liệu mình tạo trong `finally`.
Có kiểm tra hết hạn thật nên mất hơn 60 giây. Bài này kiểm tra control plane;
nó mô phỏng SDP/hash, không thay thế bài truyền byte bằng browser.

Kiểm tra thẻ file ngay trong chat:

```powershell
node tests/chat-file-state.mjs
$env:TEXT_TEST_ORIGIN = 'http://127.0.0.1:5173'
$env:CODEX_NODE_MODULES = 'duong-dan-node_modules-co-playwright'
node tests/chat-files.e2e.mjs
node tests/file-stream.e2e.mjs
node tests/file-relay.e2e.mjs
node tests/file-large.e2e.mjs
```

Chạy một backend thử với database riêng; không dùng hai backend cùng database vì registry
phiên file nằm trong RAM từng tiến trình. Bài browser kiểm tra lời mời ở hai bên,
truyền byte/hash thật, nhận/từ chối/hủy/lỗi kênh, timeline, quyền truy cập, reload và phân trang file.

`file-large-protocol.mjs` sinh từng khối của file ảo 10 GiB qua sender/receiver,
kiểm tra vị trí liên tiếp và cửa sổ ACK mà không tạo file 10 GiB trên đĩa.
`file-large.e2e.mjs` mặc định tạo file thật **1 GiB + 1 byte**. Dùng
`FILE_TEST_BYTES=4294967297` để thử vượt 4 GiB. Đo thời gian từ xác nhận gửi đến
lời mời, từ bấm Nhận file đến lần ghi đầu tiên và đến khi hoàn tất. Kiểm tra
ghi trước khi chốt SHA-256 ở bên gửi, đối chiếu hash bản lưu và nhắn tin đồng thời.
Profile Chrome thường tạm giữ file nguồn và đích trên đĩa. Test dùng
handle OPFS để thay picker native, đồng thời chặn app tự mở file tạm OPFS.
Đích thay thế vẫn chịu quota của trình duyệt. Cần đủ đĩa cho hai bản sao thử.
Truyền file ảo 10 GiB không thay cho nghiệm thu file thật 10 GiB trên LAN/TURN.

Ngày 16/11/2026, bài lớn đã qua với **1.073.741.825 byte**, SHA-256 bản
lưu trùng nguồn, một kênh `file-v3-0`, chat đồng thời và không còn file tạm.
Lượt thử mất 333 giây, gồm kiểm tra cuối; đây không phải số đo LAN/TURN.
60 kiểm tra Node, 12 nhóm API file, 15 nhóm browser v2 và 6 nhóm browser v1
đã qua trên bản tăng giới hạn. Build backend và lint/build frontend qua.

Ngày 13/11/2026, bản một kênh đã qua kiểm thử Chrome với hai tài khoản và
WebRTC thật, gồm file rỗng, 16 KiB, 16 KiB + 1 byte và 100 MiB. Bài v2 thay
hộp Lưu thành native bằng một file đích trong OPFS dành riêng cho kiểm thử. Các thao
tác ghi, đóng, đọc file và đối chiếu SHA-256 dùng API trình duyệt thật.
Bài này cũng kiểm tra chọn tên khác, hủy hoặc từ chối quyền chọn file đích, quay
về v1, ghi chậm, nhắn tin trong khi truyền, hủy phiên, sai hash, hết chỗ ghi,
nhận từ trang Tệp và mất kết nối lúc `CompleteFile`. Sau đổi sang Lưu thành,
bài kiểm thử còn đối chiếu nội dung file cũ sau sai hash, lỗi khi đã ghi một
phần file đích và hủy trong lúc lưu.

Ngày 14/11 bổ sung ca âm thanh `A.m4a` nhận handle `B.exe`: lời mời vẫn
`offered`, tên/hash trong thẻ và API giữ nguyên, nội dung `B.exe` không đổi.
Chọn lại tên `.M4A` nhận thành công và hash đúng. `tests/file-storage.mjs`
kiểm tra thêm đổi tên cùng đuôi, tên dài, tên dành riêng của Windows, file
không có đuôi, đuôi không phù hợp bộ lọc API và hủy hộp lưu.

Ca hai phiên cùng chạy đã qua. Khi đóng DataChannel của một phiên trong
lúc writer đang chậm, phiên đó thất bại và phiên còn lại vẫn lưu đúng file.
40 kiểm tra Node, 82 nhóm kiểm tra API/SignalR về file, chat, hội thoại,
danh bạ và xác thực đã qua. Các kiểm tra presence, monitoring, giao diện
Admin và chat P2P cũng qua. Build backend, lint và build frontend thành công.

Bộ `chat-files.e2e.mjs` kiểm tra riêng đường tương thích v1. Bài
`files.integration.mjs` có thêm thương lượng một kênh v2, từ chối cấu hình
nhiều kênh và chuyển về v1 với client cũ. Cần nghiệm thu riêng hộp Lưu thành
của hệ điều hành và kết nối giữa hai máy thật/TURN.

Mốc kiểm tra trước đó ngày 2026-10-20 trên Chrome local:

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

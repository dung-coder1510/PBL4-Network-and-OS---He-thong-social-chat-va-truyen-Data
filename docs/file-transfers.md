# Truyền file Web ↔ Web

## Chạy và sử dụng

Backend: `dotnet run --project PBL4/PBL4.csproj --launch-profile https`.
Frontend: tại `frontend`, chạy `npm install` nếu chưa cài dependency, rồi `npm run dev`.
Cấu hình SQL/JWT theo [authentication.md](authentication.md).
Sử dụng bảng `FileTransfers` có sẵn. Frontend dùng `@noble/hashes` 2.4.0
để tính SHA-256 theo từng phần. Chạy `npm install` sau khi cập nhật mã nguồn.

1. Đăng nhập hai tài khoản trong hai cửa sổ/tab. Tạo cuộc trò chuyện giữa hai người
   từ mục Trò chuyện hoặc Danh bạ.
2. Ngay trong cuộc trò chuyện, bấm **Gửi file** cạnh ô soạn tin rồi chọn file tối đa
   **10 GiB** (10.737.418.240 byte). File **lớn hơn 1 GiB** hiện cảnh báo trước khi
   tính hash/gửi lời mời; chọn **Tiếp tục gửi** hoặc **Hủy**. Đúng 1 GiB không cảnh báo.
   Lời mời tự gửi đến người đang trò chuyện, không cần chọn lại người nhận;
   bản nháp tin nhắn được giữ nguyên. Hoặc mở **Tệp**, chọn cuộc trò chuyện/file và bấm **Gửi lời mời**.
3. Ngay khi gửi lời mời, cả hai thấy một thẻ file xen kẽ tin nhắn trong đúng cuộc trò chuyện.
   Người nhận chọn **Nhận file** hoặc **Từ chối** ngay trên thẻ; người gửi có **Hủy gửi**.
   Trang **Tệp** vẫn hiển thị cùng phiên truyền để xem tổng hợp.
4. Giữ hai tab mở. Cùng thẻ đó cập nhật tiến độ, số byte, tốc độ trung bình và nút **Hủy**.
   Hết byte gửi chưa có nghĩa là đã hoàn tất: cần người nhận xác nhận đủ byte và SHA-256.
5. Trên trình duyệt hỗ trợ, **Nhận file** mở hộp **Lưu thành (Save As)** để chọn
   tên file và vị trí lưu. File được ghi tạm, xác minh SHA-256 rồi lưu vào file
   đã chọn. File tối đa **100 MiB** có thể chọn **Nhận để tải xuống**
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

Nếu chọn file đã tồn tại, hộp lưu
cho phép xác nhận thay thế; app dùng đúng file đã chọn, không tự thêm hậu tố.
Nội dung cũ chỉ được thay khi file mới đã xác minh và đóng writer thành công.
Hủy/lỗi trước đó giữ nguyên nội dung cũ. Với tên file mới, trình duyệt có thể
tạo sẵn file rỗng khi chọn đích; file rỗng này có thể còn lại nếu phiên thất bại.

Thẻ hoàn tất hiển thị **Đã gửi** ở bên gửi. Bên nhận `file-v2`/`file-v3` thấy
**Đã lưu trên máy** sau khi file đích đã đóng thành công và server xác nhận.
Nếu mất phản hồi xác nhận, thẻ hiện **Đã lưu trên máy, chưa xác nhận với máy chủ**.
Với `file-v1`, tab giữ Blob và hiện **Sẵn sàng tải xuống**. Cần tải file đó
trước khi đóng/reload tab. Lịch sử trên SQL chứa metadata và trạng thái phiên.

Lịch sử riêng lấy từ `GET /api/v1/conversations/{id}/files?beforeId=...`, mỗi trang tối đa
50 phiên, kiểm tra quyền thành viên trước khi trả metadata. Trong chat, **Xem tin nhắn cũ hơn**
tải cả các trang text/file còn lại. Lời mời file cập nhật preview `[Tệp] tên_file` và thời gian
hoạt động của conversation; không chèn tin text giả vào bảng `Messages`.

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

## Giao thức ghi đĩa một kênh: file-v2 và file-v3

`OfferFile` thêm `supportedProtocols` và `requestedChannelCount`.
`AcceptFile` chọn `protocolVersion` và `channelCount`. Backend chấp nhận
một kênh ở phiên bản này và phát cấu hình qua `FileChanged`. File tối đa 100 MiB
quảng bá `file-v1` và `file-v2`; file lớn hơn chỉ quảng bá `file-v3`. Backend không
cho hạ file lớn về v1/v2. Client cũ thiếu trường mới chỉ gửi/nhận được tối đa 100 MiB.

DataChannel tin cậy và có thứ tự. File được chia thành khối tối đa 16 KiB.
`file-v2-0` giữ vị trí byte **uint32, 4 byte big-endian**, giới hạn 100 MiB.
`file-v3-0` dùng **uint64, 8 byte big-endian**, đủ cho vị trí vượt 4 GiB;
giới hạn 10 GiB. JSON kích thước/ACK vẫn dùng số nguyên an toàn của JavaScript,
C# dùng `long`, SQL dùng `BIGINT`, không cần migration. Máy nhận mở file
tạm OPFS trước khi chấp nhận và gửi `READY` khi kênh mở. Máy gửi gọi
`BeginFileTransfer` sau `READY`.

Hạn mức chưa ACK là 512 KiB. Máy nhận gửi ACK sau mỗi 64 KiB đã ghi và sau
khối cuối. Một hàng đợi ghi tuần tự giới hạn dữ liệu đang chờ trên máy nhận.
Tiến độ ở phía gửi tính theo ACK, ở phía nhận tính theo thao tác ghi hoàn tất.

Sau `END`, máy nhận chờ hàng đợi ghi xong, đóng file tạm, đọc từng phần
để xác minh SHA-256 rồi chép vào file đích đã chọn trong hộp Lưu thành.
`CompleteFile` được gọi sau khi đóng file đích. Lỗi trước khi lưu hoàn tất
dọn file tạm và hủy writer đích; không xóa file người dùng đã chọn. File đã lưu được giữ khi mất
phản hồi từ server. Trạng thái lưu tại máy được giữ trong phiên tab đang mở.

Máy nhận ghi file cần HTTPS hoặc localhost, File System Access, OPFS và Web Locks.
Trước khi tạo file tạm, kiểm tra `navigator.storage.estimate()` để từ chối khi
quota còn lại nhỏ hơn kích thước file. Đây chỉ là ước lượng; lỗi hết chỗ/quyền
ghi vẫn có thể xảy ra trong khi truyền hoặc lưu. Cần dung lượng cho cả file tạm
trong vùng lưu của trình duyệt và bản đích, thường khoảng hai lần dung lượng
file khi cùng ổ. [Đặc tả ước lượng dung lượng](https://storage.spec.whatwg.org/#dom-storagemanager-estimate)
Kế hoạch thử nhiều kênh được mô tả
trong [đặc tả v2](dac-ta-truyen-file-webrtc-v2.md).

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
  đầy đủ. Phía gửi hiện tính hash theo từng phần cho cả hai phiên bản.
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
Máy gửi v2/v3 chuyển sang chờ xác nhận khi toàn bộ byte đã được ACK. Server
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
`services/fileStreamProtocol.js` (READY/ACK/END, băm từng phần và cửa sổ gửi),
`services/fileStorage.js` (file tạm, ghi theo vị trí và xuất file đã xác minh),
`services/fileTransferState.js` (chờ đồng bộ trạng thái, hủy và timeout),
`services/fileTransfers.js` (WebRTC/lifecycle), `realtime/FileTransferProvider.jsx`,
`pages/FilesPage.jsx`.

## Kiểm thử

Không cần server:

```powershell
node --test tests/file-protocol.mjs tests/file-stream-protocol.mjs tests/file-large-protocol.mjs tests/file-storage.mjs tests/file-transfer-state.mjs tests/frontend-heartbeat.mjs
dotnet run --project tests/presence/PresenceChecks.csproj
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
node tests/file-large.e2e.mjs
```

Chạy một backend thử với database riêng; không dùng hai backend cùng database vì registry
phiên file nằm trong RAM từng tiến trình. Bài browser kiểm tra lời mời ở hai bên,
truyền byte/hash thật, nhận/từ chối/hủy/lỗi kênh, timeline, quyền truy cập, reload và phân trang file.

`file-large-protocol.mjs` sinh từng khối của file ảo 10 GiB qua sender/receiver,
kiểm tra vị trí liên tiếp và cửa sổ ACK mà không tạo file 10 GiB trên đĩa.
`file-large.e2e.mjs` tạo file thật **1 GiB + 1 byte**, kiểm tra cảnh báo ở Chat
và Tệp, Hủy/Escape, giao diện nhỏ, từ chối fallback RAM/thiếu quota, truyền
WebRTC v3 một kênh, ghi đĩa, SHA-256 và chat đồng thời. Bài thử yêu cầu trên
4 GiB dung lượng trống, dùng profile Chrome thường riêng cho máy nhận.
Picker được thay bằng file handle OPFS riêng của test, nên cả file tạm và
đích đều tính vào quota của website. Không dùng context ẩn danh cho bài lớn
này; lỗi quota vẫn là ca thất bại, không tự nâng quota trình duyệt trong test.
Hộp Windows native cần nghiệm thu riêng.
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

# Giải thích nguyên lý và mã nguồn truyền file

Tài liệu mô tả chức năng truyền file Web ↔ Web đang có trong dự án,
theo luồng một người A gửi `tailieu.pdf` cho người B.

## 1. Phương thức truyền file

Nội dung file đi giữa hai trình duyệt bằng **WebRTC DataChannel**.
**SignalR** chuyển lời mời, quyết định chấp nhận, thông tin kết nối và
trạng thái. **SQL Server** lưu thông tin của phiên truyền.

```text
A ── lời mời, chấp nhận, SDP, ICE ── Server ── B
A ═════════ nội dung file qua WebRTC ═══════ B
                                  Server ── thông tin phiên ── SQL
```

Khi kết nối trực tiếp không thực hiện được, WebRTC có thể đi qua TURN
nếu đã cấu hình. TURN chuyển tiếp dữ liệu; SQL vẫn chỉ lưu metadata.

Metadata là thông tin mô tả file: tên, kích thước, người gửi, cuộc trò
chuyện, hash, trạng thái và thời gian. Server ứng dụng không lưu nội dung
PDF vào SQL hoặc thư mục upload.

## 2. Luồng xử lý từ lúc chọn file đến khi tải xuống

### Bước 1: A chọn file trong cuộc trò chuyện với B

A bấm **Gửi file** cạnh ô soạn tin. Giao diện mở hộp chọn file, rồi gọi:

```js
files.offer(conversation.id, file)
```

`conversation.id` là cuộc trò chuyện đang mở. Backend xác định B từ cuộc
trò chuyện này; A không cần chọn lại người nhận. Bản nháp tin nhắn vẫn được
giữ nguyên.

Vị trí code:

- [ConversationThread.jsx](../frontend/src/components/chat/ConversationThread.jsx):
  nút **Gửi file**, input chọn file và hàm `selectFile()`.
- [ChatPage.jsx](../frontend/src/pages/ChatPage.jsx):
  truyền callback `onSendFile` và ID cuộc trò chuyện vào `files.offer()`.

Ngoài ra, A có thể chọn người nhận/file ở trang **Tệp** và bấm
**Gửi lời mời**. Hai cách cùng sử dụng một bộ xử lý truyền file.

### Bước 2: Máy A tính SHA-256 và gửi lời mời

Hàm `offer()` kiểm tra kích thước tối đa **100 MiB**, tạo
`clientTransferId` để chống trùng, rồi tính SHA-256 từ nội dung file.

SHA-256 có thể hiểu là dấu vân tay của dữ liệu. Khi nhận xong, B tính lại
để kiểm tra dữ liệu nhận có khớp file A đã khai báo hay không.

Lệnh `OfferFile` gửi qua SignalR gồm:

```text
conversationId   : ID cuộc trò chuyện
clientTransferId : ID chống gửi trùng
fileName         : tên file
fileSizeBytes    : kích thước theo byte
sha256Hex        : SHA-256 dạng hex
```

Ở bước này, client chỉ gửi metadata, chưa gửi nội dung file.

Code nằm trong `offer()` của
[fileTransfers.js](../frontend/src/services/fileTransfers.js).
Hàm tính hash là `sha256()` trong
[fileProtocol.js](../frontend/src/services/fileProtocol.js).

### Bước 3: Server kiểm tra, lưu metadata và thông báo cho B

`ChatHub.OfferFile()` chuyển yêu cầu đến `FileTransferService.OfferAsync()`.
Server lấy danh tính A từ JWT, không tin một SenderId do client tự gửi.

Server kiểm tra:

- A có thuộc cuộc trò chuyện không.
- Tài khoản B có còn khả dụng và có kết nối ứng dụng hợp lệ không.
- Tên file, kích thước và SHA-256 có hợp lệ không.
- ID lời mời có bị dùng lại với metadata khác không.
- Hai tài khoản có vượt giới hạn số phiên đang chờ/đang truyền không.

Sau đó server lưu bản ghi `FileTransfers` với trạng thái `offered` và
phát sự kiện `FileChanged` đến các kết nối hợp lệ của A và B.

Code nằm ở:

- [ChatHub.cs](../PBL4/Realtime/ChatHub.cs): các lệnh SignalR.
- [FileTransferService.cs](../PBL4/Services/FileTransferService.cs):
  hàm `OfferAsync()` kiểm tra và lưu dữ liệu.
- [FileDtos.cs](../PBL4/Contracts/FileDtos.cs): cấu trúc các gói dữ liệu.

### Bước 4: B chấp nhận hoặc từ chối

B nhận thông báo, mở mục **Tệp**, rồi bấm **Chấp nhận** hoặc **Từ chối**.
Giao diện gọi `AcceptFile` hoặc `RejectFile` qua SignalR.

Nếu B chấp nhận, server chuyển trạng thái thành `accepted` và gắn phiên
với đúng connection của tab nhận. Nếu B mở nhiều tab và hai tab cùng bấm
chấp nhận, chỉ một tab thắng. Tab khác không được nhận dữ liệu file hoặc
điều khiển phiên đã gắn với tab thắng.

Server dùng RowVersion và xử lý tuần tự các thay đổi trạng thái để tránh
lệnh từ trạng thái cũ ghi đè trạng thái mới.

Code nằm trong `ActAsync()` của
[FileTransferService.cs](../PBL4/Services/FileTransferService.cs).
Các nút chấp nhận/từ chối nằm trong
[FilesPage.jsx](../frontend/src/pages/FilesPage.jsx).

### Bước 5: Hai trình duyệt thiết lập kết nối WebRTC

Sau khi chấp nhận, hai bên tạo `RTCPeerConnection` và trao đổi thông tin
kết nối qua server:

| Thông tin | Ý nghĩa |
| --- | --- |
| SDP Offer | A đề nghị cách thiết lập kết nối |
| SDP Answer | B trả lời đề nghị đó |
| ICE candidate | Các địa chỉ/đường kết nối mà hai bên có thể thử |

Các thông tin này đi qua lệnh `SendFileSignal` và sự kiện `FileSignal`.
Server chỉ chuyển báo hiệu đến đúng tab đã gắn với phiên truyền.

A tạo DataChannel tên `file-v1`, cấu hình ordered và reliable, nghĩa là
kênh giao dữ liệu đúng thứ tự và tin cậy. Trình duyệt đảm nhiệm cơ chế
truyền tin cậy của kênh; ứng dụng vẫn kiểm tra thứ tự chunk và tổng byte.

Code frontend nằm trong
[fileTransfers.js](../frontend/src/services/fileTransfers.js):

- `createPeer()`: tạo kết nối, DataChannel và xử lý ICE candidate.
- `startPeer()`: khởi tạo trao đổi kết nối và tạo Offer ở phía gửi.
- `signalReceived()`: nhận Offer, Answer, ICE và áp dụng vào WebRTC.
- `attachChannel()`: gắn sự kiện mở kênh, nhận dữ liệu, đóng kênh và lỗi.

Code backend chuyển báo hiệu nằm trong `SignalAsync()` của
[FileTransferService.cs](../PBL4/Services/FileTransferService.cs).
MVP dùng ngay `ChatHub`, chưa tạo `SignalingHub` riêng.

### Bước 6: A chia file thành chunk và truyền dữ liệu

Khi DataChannel mở, A gọi `BeginFileTransfer`, rồi `sendFile()` đọc từng
lát file, mỗi lát tối đa **16 KiB = 16.384 byte**.

Mỗi binary message có định dạng:

```text
[Số thứ tự chunk: 4 byte][Nội dung chunk: tối đa 16 KiB]
```

Số thứ tự là `uint32` big-endian, bắt đầu từ `0`.
Ví dụ file **1 MiB** được chia thành **64 chunk**, đánh số `0` đến `63`.
Mỗi DataChannel dùng cho một file nên không cần lặp ID file trong mỗi khung.

Sau chunk cuối, A gửi khung kết thúc:

```json
{"type":"end"}
```

File rỗng không có binary chunk; chỉ cần khung kết thúc.

Để tránh dồn quá nhiều dữ liệu vào hàng đợi DataChannel, ứng dụng theo dõi
`bufferedAmount`. Khi vượt **256 KiB**, sender chờ xuống **64 KiB** rồi
mới tiếp tục. Cơ chế điều tiết này gọi là backpressure.

Code nằm ở:

- `sendFile()` trong [fileTransfers.js](../frontend/src/services/fileTransfers.js):
  đọc từng lát file và gọi `channel.send()`.
- `encodeChunk()` trong [fileProtocol.js](../frontend/src/services/fileProtocol.js):
  đóng khung thứ tự và payload.
- `waitForBuffer()` trong [fileProtocol.js](../frontend/src/services/fileProtocol.js):
  chờ bộ đệm, xử lý hủy, đóng kênh và timeout.

### Bước 7: B kiểm tra, xác nhận hoàn tất và tải file

`createFileReceiver()` kiểm tra từng chunk:

- Số thứ tự có đúng chunk đang chờ không.
- Kích thước khung có đúng giới hạn không.
- Tổng byte có vượt kích thước đã khai báo không.
- Khung kết thúc có đến sau khi nhận đủ byte không.

B ghép các phần thành `Blob`, tính lại SHA-256 và so với hash A đã gửi.
Trước khi xác nhận, B chờ metadata `transferring` từ server để dùng đúng
RowVersion mới. Bước này xử lý tình huống dữ liệu WebRTC đến trước thông
báo SignalR; hủy, disconnect hoặc timeout sẽ dừng việc chờ.
Nếu khớp và đủ byte, B gọi `CompleteFile` với số byte và hash đã kiểm tra.

Server kiểm tra quyền của tab nhận, đối chiếu số byte/hash và chuyển
trạng thái thành `completed`. Giao diện sau đó tạo Blob URL để B bấm
**Tải xuống** và lưu file về máy.

**A gửi hết chunk chưa có nghĩa là hoàn tất.** Còn cần B xác nhận đã nhận
đủ và hash khớp. Server chỉ đối chiếu hash B báo về; server không nhận
hay tự hash nội dung file.

Code nằm ở:

- `createFileReceiver()` trong
  [fileProtocol.js](../frontend/src/services/fileProtocol.js): kiểm tra và ghép chunk.
- `receiveEnd()` trong
  [fileTransfers.js](../frontend/src/services/fileTransfers.js): kiểm tra SHA-256,
  gọi `CompleteFile` và tạo URL tải xuống.
- `waitForTransferring()` trong
  [fileTransferState.js](../frontend/src/services/fileTransferState.js): chờ
  đúng trạng thái trước khi xác nhận, có abort và timeout.
- Nhánh `complete` trong `ActAsync()` của
  [FileTransferService.cs](../PBL4/Services/FileTransferService.cs).
- Nút **Tải xuống** trong [FilesPage.jsx](../frontend/src/pages/FilesPage.jsx).

## 3. Server lưu gì và file nằm ở đâu?

| Dữ liệu | Nơi lưu |
| --- | --- |
| File gốc | Thiết bị người gửi |
| Chunk đang nhận và Blob sau khi ghép | Bộ nhớ/tài nguyên tạm của trình duyệt người nhận |
| File sau khi bấm Tải xuống | Vị trí người nhận chọn trên máy |
| Metadata và trạng thái phiên | Bảng `FileTransfers` trong SQL Server |
| Danh sách endpoint của phiên đang chạy | RAM backend, trong `FileTransferService` |

Model SQL nằm ở [FileTransfer.cs](../PBL4/Models/FileTransfer.cs), mapping
ở [AppDBContext.cs](../PBL4/Data/AppDBContext.cs).
API lịch sử nằm trong [FilesController.cs](../PBL4/Controllers/FilesController.cs).

Đóng hoặc reload tab làm mất file tạm chưa lưu. Lịch sử trong SQL không
giúp tải lại nội dung file; nếu chưa lưu thì cần yêu cầu gửi lại.

## 4. Quản lý trạng thái và thời gian chờ

Luồng thành công:

```text
offered → accepted → transferring → completed
```

Các nhánh khác gồm `rejected`, `cancelled`, `expired` và `failed`.

| Giới hạn | Giá trị hiện tại |
| --- | --- |
| Kích thước file | Tối đa 100 MiB |
| Phiên chờ/đang truyền mỗi tài khoản | Tối đa 2 |
| Registry phiên đang hoạt động toàn backend | Tối đa 1.000, không phải kết quả đo tải |
| Thời gian chờ chấp nhận | 60 giây |
| Thời gian thiết lập kết nối sau khi chấp nhận | 45 giây |
| Không có tiến triển ở client | 60 giây |
| Chờ bộ đệm đang nghẽn | 30 giây |
| Thời gian truyền tối đa ở server | 30 phút kể từ BeginFileTransfer |
| Chu kỳ quét phiên hết hạn | 5 giây |
| Blob đã nhận được giữ để tải xuống mỗi tab | Tối đa 2 |

Worker [FileTransferMonitor.cs](../PBL4/Realtime/FileTransferMonitor.cs)
gọi `SweepAsync()` để kết thúc phiên hết hạn hoặc không còn endpoint hợp lệ.
Do quét mỗi 5 giây, thông báo hết hạn có thể trễ thêm một nhịp quét.

Đóng connection, lỗi và hủy sẽ dọn peer, timer và buffer liên quan.
`forgetDownload()` thu hồi Blob URL khi giải phóng file.
Phiên bị ngắt cần gửi lại; hiện chưa có resume từ chunk đang dở.

`FileTransferProvider` sống cùng phiên đăng nhập, nên chuyển từ trang Tệp
sang Chat vẫn tiếp tục truyền. Code ở
[FileTransferProvider.jsx](../frontend/src/realtime/FileTransferProvider.jsx)
và được gắn trong [App.jsx](../frontend/src/App.jsx).

Heartbeat online/offline và timeout truyền file là hai cơ chế riêng.
Trạng thái online không thay cho việc B chấp nhận lời mời.

## 5. Bảo mật và kiểm tra dữ liệu

- JWT xác định người gọi; filter kiểm tra phiên và tài khoản ở mỗi lệnh Hub.
- Server kiểm tra quyền thành viên của cuộc trò chuyện.
- Phiên truyền gắn với đúng connection của tab gửi và tab nhận.
- RowVersion chống thao tác dựa trên trạng thái đã cũ.
- ClientTransferId chống tạo trùng lời mời.
- Kiểm tra kích thước, thứ tự chunk, số byte và SHA-256 bảo vệ tính toàn vẹn.
- WebRTC dùng mã hóa DTLS của trình duyệt; API và báo hiệu cần HTTPS khi triển khai.

SHA-256 giúp đối chiếu nội dung với hash đã thỏa thuận, không phát hiện
mã độc. Người nhận hợp lệ vẫn là bên báo kết quả kiểm tra cho server.

## 6. Phần tự viết và phần dùng API có sẵn

| Phần tự viết trong ứng dụng | API/thư viện sử dụng |
| --- | --- |
| Lời mời, chấp nhận/từ chối, quản lý trạng thái | SignalR để chuyển lệnh và sự kiện |
| Điều phối Offer/Answer/ICE, ràng buộc tab | RTCPeerConnection |
| Khung chunk, chia/ghép, tiến độ, backpressure | RTCDataChannel, File, ArrayBuffer, Blob |
| Quy tắc đối chiếu hash và xác nhận hoàn tất | Web Crypto SHA-256 |
| Quyền truy cập và lịch sử phiên | ASP.NET Core, EF Core, SQL Server |

Ứng dụng chưa tự triển khai raw TCP/UDP socket cho web. Trình duyệt xử lý
WebRTC và cơ chế truyền tin cậy; phần tự viết phục vụ đồ án nằm ở giao thức
chunk và cách quản lý phiên ở tầng ứng dụng.

Bước hash hiện cần ArrayBuffer đầy đủ và receiver còn ghép Blob, nên RAM
tăng theo kích thước file. Chia chunk giúp điều tiết hàng đợi gửi nhưng
không có nghĩa là toàn bộ quá trình dùng RAM cố định.

## 7. Những giới hạn triển khai cần biết

- Hai bên cần giữ ứng dụng mở đến khi hoàn tất.
- Cần HTTPS hoặc localhost để sử dụng Web Crypto.
- Cấu hình `WebRtc:IceServers` mặc định là mảng rỗng. Kết nối khác NAT có
  thể cần STUN/TURN; chưa kiểm thử TURN/WAN.
- Backend hiện thiết kế cho một instance; registry endpoint lưu trong RAM.
- Chưa đo tải nhiều phiên truyền file hoặc RAM dài hạn.

Hướng dẫn chạy, cấu hình STUN/TURN và kiểm thử nằm trong
[file-transfers.md](file-transfers.md).

## 8. Thứ tự đọc code để học hoặc thuyết trình

Đọc theo thứ tự sau để theo dõi một file từ đầu đến cuối:

```text
ConversationThread.selectFile()
    → ChatPage: files.offer(conversation.id, file)
    → fileTransfers.offer()
    → ChatHub.OfferFile()
    → FileTransferService.OfferAsync()
    → FilesPage: AcceptFile
    → FileTransferService.ActAsync("accept")
    → fileTransfers.startPeer() / createPeer() / signalReceived()
    → fileTransfers.sendFile()
    → fileProtocol.encodeChunk() / waitForBuffer()
    → fileProtocol.createFileReceiver()
    → fileTransfers.receiveEnd()
    → ChatHub.CompleteFile()
    → FileTransferService.ActAsync("complete")
    → FilesPage: Tải xuống
```

Đã kiểm tra trên Chrome local: file rỗng, file nhị phân 10 MiB + 17 byte,
file 100 MiB, gửi từ nút trong chat, giữ bản nháp và chuyển người nhận.
Các bài kiểm tra protocol và API/SignalR nằm ở
[file-protocol.mjs](../tests/file-protocol.mjs) và
[files.integration.mjs](../tests/files.integration.mjs).

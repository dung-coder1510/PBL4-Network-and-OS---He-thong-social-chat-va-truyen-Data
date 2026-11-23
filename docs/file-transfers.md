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

V2/v3 giữ hạn mức chưa ACK **524.288 byte**, ACK mỗi **65.536 byte**. V4/v5/v6
bắt đầu với cửa sổ **2.097.152 byte**, gom tối đa **262.144 byte** mỗi lượt ghi.
Máy nhận ACK sau khi writer
ghi thành công từng lô và ở cuối. Tiến độ gửi tính theo ACK, tiến độ
nhận tính theo số byte đã ghi. Buffer WebRTC ở đầu gửi có hạn mức riêng.

### Cửa sổ tự điều chỉnh và thống kê đường truyền

Từ bản cập nhật ngày 21/11/2026, tab nhận mới quảng bá `maxWindowBytes: 8000000`
trong `READY` của v4/v5/v6. Tab gửi chỉ bật điều chỉnh sau khi nhận khả năng này
trên kênh 0. Nếu `READY` không có trường mới, cửa sổ giữ nguyên **2,10 MB**
để tương thích tab cũ. V2/v3 giữ hạn mức ban đầu.

Cửa sổ payload của cả file thay đổi trong khoảng **2.097.152–8.000.000 byte**,
dựa trên tốc độ ACK, RTT nếu có, thời gian phải chờ cửa sổ và thời gian ghi mỗi
lô do máy nhận trả trong `ACK.writeMs`. Mỗi lượt điều chỉnh cách nhau ít nhất
500 ms. Máy nhận ghi chậm hoặc ACK bị ngắt quãng dài làm cửa sổ giảm về tối
thiểu mức ban đầu 2,10 MB. Số đo RTT ở đây là của ICE, dùng để ước lượng,
không phải toàn bộ thời gian SCTP và xác nhận ghi đĩa. Tốc độ thấp ở đầu phiên
không được làm cửa sổ giảm xuống dưới mức ban đầu.
Số kênh không nhân trần 8 MB lên. Máy nhận từ chối khối vượt cửa sổ quảng bá.

V4/v5/v6 giữ tổng ngân sách đệm gửi **1.048.576 byte** (khoảng 1,05 MB),
chia đều giữa các kênh. Ngưỡng báo đệm thấp là **65.536 byte**. Sender kiểm
tra lại chỗ trống thực tế trước khi gửi tiếp để không nhận nhầm sự kiện cũ
trong hàng đợi. Thử nghiệm giới hạn bốn khung suốt phiên đã được bỏ sau khi
phép đo 110 MB phát hiện tốc độ duy trì giảm. Worker vẫn giữ một lô đọc và
một lô đọc trước.
Trần 8 MB áp dụng cho payload
chưa ACK của ứng dụng, không phải tổng RAM của tab, SCTP hay hệ điều hành.
`bufferedAmount` chỉ đo dữ liệu chờ gửi trong trình duyệt, không đo hàng đợi
ghi đĩa ở máy nhận. [RTCDataChannel bufferedAmount](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmount)

Thẻ Chat và trang Tệp hiển thị đường **WebRTC trực tiếp**, **qua TURN** hoặc
chưa xác định từ cặp ICE được chọn. Trong chế độ nhà phát triển, mở **Thống kê
WebRTC** để xem từng kết nối, RTT, tốc độ byte trên mạng, cửa sổ, byte chưa ACK,
đệm gửi/hàng đợi ghi và thời gian chờ. Vòng đo `getStats()` chạy một lần mỗi
giây, dừng khi phiên kết thúc, hủy, logout hoặc đổi sang HTTPS. Số đo là cục bộ
trong tab, không lưu SQL, không gửi IP, SDP hoặc TURN credential lên dashboard.
Thiếu thống kê không được suy ra là đường trực tiếp.
[WebRTC Stats](https://www.w3.org/TR/webrtc-stats/)

Tốc độ trên thanh tiến độ là số byte đã ghi/được ACK trong cửa sổ khoảng một
giây gần nhất, sau khi có hai mẫu dữ liệu. Thời gian chờ byte đầu tiên không
làm giảm tốc độ hiện tại. Khi WebRTC ngừng tiến triển, vòng thống kê lấy mẫu
byte không đổi để tốc độ hiện tại về 0. Tốc độ trung bình từ lúc mở kênh vẫn
được giữ trong `averageBytesPerSecond` và dùng cho kết quả cuối phiên.

Thay đổi này không tự chọn số kênh, không thêm resume/ICE restart và không
cam kết tăng tốc trên mọi mạng. Cần đo riêng giữa hai máy và qua TURN để so
với cấu hình cũ.

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

### Mặc định tự động

Khi tắt chế độ nhà phát triển, file không quá **104.857.600 byte** (khoảng
104,9 MB) giữ một kết nối như trước. File lớn hơn ưu tiên hai kết nối riêng
nếu cấu hình API có `supportsParallelFileConnections: true` và
`maximumFileChannels >= 2`. Lời mời đặt v6/v5 trước giao thức một kênh phù
hợp để máy nhận chọn phương án tương thích. Máy chủ thiếu khả năng này
vẫn dùng một kết nối.

Đây là lựa chọn theo dung lượng và khả năng hỗ trợ, không phải phép đo
băng thông tự động trong từng phiên. Chế độ nhà phát triển ưu tiên cấu
hình thủ công đã chọn. Đệm gửi vẫn khoảng 1,05 MB cho cả file; cửa sổ ACK
v4/v5/v6 vẫn 2,10–8 MB, dùng chung giữa các kênh/kết nối.

### Thử truyền từ 1 đến 8 kênh

Bật **Cài đặt → Nhà phát triển → Kích hoạt chế độ nhà phát triển** rồi chọn
**Số kênh truyền file**. Thiết lập lưu trên trình duyệt và áp dụng từ lời mời
tiếp theo. Bộ chọn thủ công khởi đầu ở một kênh. Trong chế độ này, thẻ file hiện số kênh
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
byte liên tiếp vào một file đích. V5 dùng cửa sổ chung đã thương lượng và các
lượt ghi tối đa **262.144 byte**. Kênh 0 báo ACK cho số byte liên tiếp đã ghi. Máy nhận đợi `END`
từ mọi kênh trước khi kiểm tra SHA-256 và chốt file. Lỗi trên một kênh kết thúc
phiên. Đo riêng đường trực tiếp và TURN để chọn số kênh phù hợp.

### Hai kết nối WebRTC riêng

File lớn ở chế độ tự động đề nghị v6 khi máy chủ hỗ trợ. Để chủ động thử
với mọi dung lượng, bật **Hai kết nối WebRTC riêng** trong
**Cài đặt → Nhà phát triển**. Lượt gửi
tiếp theo đề nghị `file-v6` với hai `RTCPeerConnection` và một DataChannel
trên mỗi kết nối. SignalR dùng `ConnectionIndex` 0 hoặc 1 để chuyển SDP và
ICE. Phiên chỉ bắt đầu gửi khi cả hai kênh báo `READY`. Cách chia khối,
cửa sổ ACK, ghi vào một file và xác minh SHA-256 dùng chung với v5.

Tab nhận chốt v6 nếu hỗ trợ. Nếu tab chỉ hỗ trợ v5 hoặc chế độ một kênh,
hai bên dùng giao thức tương thích đã ghi trong lời mời. Trong chế độ
nhà phát triển, tắt công tắc để thử lại bằng nhiều kênh chung một kết nối.
Tắt chế độ nhà phát triển để quay lại mặc định tự động.

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
location ~ ^/api/v1/files/([0-9]+/relay/content|relay/diagnostics)$ {
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

Nếu tên miền chính đi qua proxy ngoài, có thể đặt
`VITE_FILE_RELAY_CONTENT_BASE_URL=https://rt.wiremess.io.vn/api/v1` khi build
frontend để truyền byte qua tên miền trực tiếp. Biến này áp dụng cho `PUT` và
`GET` trên `/{id}/relay/content`. Lời mời, trạng thái và biên nhận dùng API
theo `VITE_API_BASE_URL`. Tên miền trực tiếp cần cấu hình route Nginx ở trên
và khai báo origin frontend trong `Cors:AllowedOrigins` của backend.

### Thử 1, 2 và 4 kết nối HTTPS

Trong **Cài đặt → Nhà phát triển**, bật chế độ nhà phát triển rồi chọn
**Số kết nối HTTPS**. Giá trị mặc định là 1. Lựa chọn được chốt theo file
khi gửi lời mời và dùng cả khi WebRTC tự chuyển sang HTTPS.

Với 2 hoặc 4 kết nối, A gọi `POST /api/v1/files/{id}/relay/upload` với
`{ sha256Hex, connectionCount }`, rồi mở các `PUT /relay/content?channel=0`
đến `channel=connectionCount-1`. Kênh 0 gửi các khối 64.000 byte số 0, N,
2N và tiếp tục như vậy, kênh 1 gửi khối số 1, N+1, 2N+1. Body của từng
PUT là một Blob ghép từ các lát file. Mỗi kênh chỉ được claim một lần,
có Content-Length xác định và khai báo SHA-256 của file gốc.

Backend dành một phần vùng đệm cho từng kênh và đọc luân phiên đúng thứ
tự khối. Tổng payload chờ là 3.968.000 byte với 1 hoặc 2 kết nối,
3.840.000 byte với 4 kết nối. B tiếp tục dùng một GET và writer tuần tự,
kiểm tra SHA-256 rồi đóng file. Hủy một phiên giải phóng tất cả luồng
của phiên. Số kết nối của phiên đang chạy có trong `relayConnectionCount`.
Sau khi phiên đã rời bộ nhớ, lịch sử dùng giá trị mặc định của trường này.

Nút **Đo đường truyền HTTPS** chạy riêng PUT 110 MB rồi GET 110 MB tại
`/api/v1/files/relay/diagnostics`. Người dùng chọn nơi lưu file thử, thời
gian tải xuống gồm cả ghi đĩa, xác minh và đóng file. Cần áp dụng route
streaming Nginx trên cho endpoint này. Phép đo cần đăng nhập, giới hạn
110 MB mỗi request, 12 request mỗi phút mỗi tài khoản và tối đa hai
request chẩn đoán đồng thời trên một backend. Khi rời trang hoặc bấm
**Dừng đo**, client hủy phép đo và writer chưa hoàn tất.

Để so 1/2/4 kết nối, dùng đúng hai máy, cùng file và nơi lưu, chạy ba lượt
mỗi mức, so thời gian từ bấm nhận đến lưu xong và SHA-256. Bộ
`tests/file-relay.e2e.mjs` thực hiện phép so 110 MB trong Chrome, đồng thời
kiểm tra hủy và tự chuyển từ WebRTC. Số đo trên cùng máy phục vụ kiểm tra
triển khai, còn mức cải thiện qua WAN cần đo giữa hai máy thật.

Lượt kiểm tra ngày 20/11/2026 trên cùng máy Windows, Chrome, backend dùng
DB kiểm thử riêng, cùng tệp 110 MB, cho số đo từ bấm nhận đến lưu xong:

| Kết nối tải lên | Lượt 1 | Lượt 2 | Lượt 3 | Trung vị |
| --- | ---: | ---: | ---: | ---: |
| 1 | 18,43 MB/s | 18,90 MB/s | 18,56 MB/s | 18,56 MB/s |
| 2 | 17,68 MB/s | 18,65 MB/s | 20,25 MB/s | 18,65 MB/s |
| 4 | 18,46 MB/s | 19,49 MB/s | 21,13 MB/s | 19,49 MB/s |

Cả 9 lượt đều đúng SHA-256. Các mức chênh lệch này bao gồm thời gian
ghi đĩa và xử lý của trình duyệt trên một máy. Mặc định giữ 1 kết nối
để người dùng chọn mức thử nghiệm sau khi đo trên đường WAN của mình.

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

Lựa chọn mặc định tự động được kiểm tra trong
`tests/file-offer-policy.mjs`: file lớn dùng hai kết nối khi được hỗ trợ,
lựa chọn thủ công được giữ, cấu hình máy chủ cũ lui về một kết nối và
luồng HTTPS không đổi. Tổng bộ kiểm tra Node liên quan hiện qua **68 test**.
Hai bộ kiểm tra Chrome `tests/file-flow.e2e.mjs` và
`tests/file-stream.e2e.mjs` qua **32 nhóm kiểm tra**, gồm chế độ tự động,
máy chủ cũ, SHA-256, chat đồng thời, hủy phiên và chuyển sang HTTPS.
Số đo bổ sung trên giao diện thật, gồm file 330 MB và các mức dao động,
có trong [báo cáo thử cấu hình](nghien-cuu-bo-dem-webrtc.md#cập-nhật-lựa-chọn-mặc-định-tự-động).

Đợt thử tăng đệm gửi lên 2–32 MB, ACK tới 64 MB và khối gửi 32/64 KB
chưa tìm được cấu hình nhanh hơn mức hiện tại trên cùng máy. Mức đệm gửi
32 MB gây lỗi đầy hàng đợi của Chrome. Tham số bản chính được giữ nguyên;
xem [số đo và giới hạn của phép thử](nghien-cuu-bo-dem-webrtc.md).

Bản sửa hồi quy ngày 21/11/2026 qua **59 kiểm tra Node**, lint và build
frontend; cả hai browser suite bên dưới cũng được chạy lại thành công với
SQL riêng. Hai lượt 110 MB với một DataChannel trên một kết nối WebRTC đạt
**4,90–5,78 MB/s** sau sửa, so với **2,92 MB/s** ở bản bị chậm. Đúng mã nguồn
commit `a539676` đạt **5,11–5,74 MB/s** trong hai lượt đối chiếu. Các lượt dùng
cùng nguồn, writer, xác minh SHA-256 và hai context Chrome trên cùng máy;
mọi bản lưu đều khớp hash. Kết quả cho thấy tốc độ trở lại gần bản commit cũ,
không chứng minh nhanh hơn bản cũ trên mọi lần chạy.

Phép thử ngắn 32 MB trước đó cho thấy lợi ích ở đầu phiên nhưng đã bỏ sót
suy giảm tốc độ duy trì khi giới hạn đệm ở bốn khung. Giới hạn này và việc
giảm cửa sổ dưới mức ban đầu đều đã được sửa. Đây là số đo loopback với
đích OPFS thay picker, không xác định tốc độ tối đa trên LAN/TURN hoặc mọi
thư mục Windows. Giới hạn của browser và điều kiện chạy vẫn ảnh hưởng kết quả.

Ngày 21/11/2026, bản cửa sổ tự điều chỉnh qua **52 kiểm tra Node**, lint/build
frontend và build .NET. Hai browser suite `file-flow.e2e.mjs` và
`file-stream.e2e.mjs` chạy Chrome thật với SQL riêng, qua các trường hợp:
110 MB có SHA-256 khớp và chat đồng thời; 1/2/4/8 kênh; hai kết nối riêng;
`READY` cũ không quảng bá cửa sổ; máy nhận ghi chậm; hủy; sai hash; lỗi ghi;
giữ file đã lưu khi mất xác nhận; chuyển WebRTC sang HTTPS và nhận từ trang Tệp.
Giao diện thống kê được xem ở 1365 × 900 và 390 × 844.

Picker trong các test được thay bằng handle OPFS dành riêng cho fixture.
Đây là kiểm tra chức năng giữa hai context Chrome trên cùng máy, không phải
phép đo tốc độ LAN giữa hai thiết bị hay qua TURN thật. Chưa có kết quả khẳng
định mức tăng tốc trên các đường mạng đó. Dữ liệu thử và backend thử đã dọn
sau khi hoàn tất, database `PBL4` của người dùng không được dùng cho các test này.

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
node --test tests/file-flow-control.mjs tests/file-rtc-diagnostics.mjs
node --test tests/file-startup-buffer.mjs tests/file-transfer-rate.mjs
$env:TEXT_TEST_ORIGIN = 'http://127.0.0.1:5173'
$env:CODEX_NODE_MODULES = 'duong-dan-node_modules-co-playwright'
node tests/chat-files.e2e.mjs
node tests/file-stream.e2e.mjs
node tests/file-flow.e2e.mjs
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

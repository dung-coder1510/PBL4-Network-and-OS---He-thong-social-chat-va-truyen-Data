# Kiến trúc kết nối, lưu trữ và đồng bộ

Ngày cập nhật: 30/09/2026. Trạng thái: **đặc tả cho các bước triển khai tiếp theo**.
Bước 0 chỉ thống nhất tài liệu; không thay đổi code, schema hay database `PBL4` đang có.

## 1. Quy tắc đã chốt

P2P là mô hình liên lạc trực tiếp; WebRTC là công nghệ dùng để xây đường truyền
đó. Chọn đường truyền và chọn nơi lưu lịch sử là hai quyết định riêng.

| Hai endpoint tham gia | Tìm nhau và thiết lập kết nối | Đường truyền ưu tiên | Nơi lưu tin nhắn text |
|---|---|---|---|
| Web ↔ Web | Server tìm người dùng; SignalR chuyển SDP/ICE | WebRTC | Server |
| Web ↔ Desktop | Server; desktop phải kết nối signaling để nhận lời mời từ web | WebRTC | Server và SQLite trên desktop tham gia |
| Desktop ↔ Desktop trong LAN | Dò LAN, xác thực peer, trao đổi SDP/ICE qua kênh local | WebRTC trực tiếp trong LAN | SQLite trên từng desktop |
| Desktop ↔ Desktop khi LAN không khả dụng | Nhờ server tìm endpoint/signaling; TURN hoặc chuyển tiếp text khi cần | WebRTC nếu có thể | Vẫn local; chuyển tiếp không tự bật lưu lịch sử server |

Desktop ↔ Desktop chỉ đưa lịch sử lên server khi người dùng bấm **Đồng bộ lên
server**, hoặc đã bật **Tự động sao lưu lên server**. Server còn phục vụ đăng ký,
cấp danh tính thiết bị và các lần đồng bộ này, không chỉ xử lý P2P gặp sự cố.

Web đọc lịch sử từ server: chỉ thấy tin đã được lưu hoặc đồng bộ lên đó. Không
cam kết web nhìn thấy toàn bộ lịch sử LAN còn nằm riêng trên desktop.
Không đặt lưu lịch sử lâu dài bằng IndexedDB làm yêu cầu trong giai đoạn này.

Quy tắc được xác định theo **endpoint thực sự gửi/nhận từng tin**. Một tài khoản
có thể dùng web và desktop cùng lúc; không thêm `Users.ClientType` cố định hoặc
gắn vĩnh viễn một loại lưu trữ cho cả conversation. Khi chuyển endpoint, xác định
lại chính sách cho tin mới; không tự tải lên những tin LAN cũ.

## 2. Ba luồng kết nối

### 2.1. Có web tham gia

Hai phía đăng nhập, kết nối SignalR, chọn endpoint đích và trao đổi SDP Offer,
SDP Answer, ICE. WebRTC kiểm tra các đường kết nối; dùng TURN nếu không nối
trực tiếp được. Text/file đi DataChannel, âm thanh đi media.

Server vẫn giữ lịch sử text theo bảng trên dù payload realtime đi P2P.
Khi mất server, web chưa thể xác nhận đã lưu; UI giữ trạng thái chờ/thất bại
và retry cùng ID khi kết nối lại. Bước đầu chưa cam kết gửi mới từ web khi server
mất hẳn hoặc giữ được bản nháp đang chờ sau khi đóng trình duyệt.

Desktop ở chế độ chỉ LAN không nhận được lời mời từ web qua server. Muốn nhận
lời mời đó, desktop cần kết nối server; việc này không buộc bật sao lưu tin LAN.
Không giả định website thông thường tự phát hiện desktop bằng UDP.

### 2.2. Desktop ↔ Desktop trong LAN

1. Dò endpoint trong LAN bằng UDP discovery hoặc mDNS; chọn một phương án khi
   triển khai desktop và kiểm tra trên hai máy thật.
2. Xác minh danh tính peer trước khi chấp nhận cuộc trò chuyện. Gói discovery
   chỉ giúp tìm địa chỉ, không chứng minh chủ tài khoản.
3. Trao đổi signaling qua kênh local đã xác thực, rồi thiết lập WebRTC.
4. Lưu tin vào SQLite phía gửi, gửi trực tiếp; phía nhận lưu SQLite rồi gửi ACK.
5. Khi peer tạm mất kết nối, giữ outbox local để thử lại với cùng ID.

Luồng này không gọi API tạo conversation hoặc chờ server cấp MessageId.
Cuộc gọi và truyền file LAN cũng cần ID local và điều khiển qua peer; không
phụ thuộc `StartCall`/`OfferFile` trên Hub trước khi bắt đầu.

### 2.3. Fallback và trạng thái kết nối

Nếu dò LAN hoặc kết nối trực tiếp thất bại, thử server signaling và đường
WebRTC/TURN phù hợp. Nếu vẫn không có DataChannel, có thể dùng kênh chuyển tiếp
text riêng qua server. Kênh chuyển tiếp này chỉ phục vụ hai endpoint đang kết
nối, không dùng `SendMessage` có tác dụng ghi `Messages` cho tin local-only.
Không ghi payload local-only vào DB, hàng đợi bền vững hoặc log ứng dụng.

Nếu người nhận không online và chưa cho phép sao lưu, giữ tin ở outbox local;
không âm thầm lưu server để giao sau. Chưa biết loại endpoint đích thì chưa
chọn chế độ LAN local-only; dùng chế độ có server đã hiển thị rõ hoặc chờ chọn
endpoint. Không tự đổi một tin local-only thành tin cloud khi peer mất kết nối.

Presence server và khả năng liên lạc LAN là hai trạng thái riêng. Mất SignalR
không tự đóng một kết nối LAN đang tốt. Phiên LAN dùng heartbeat/timeout local;
các quy tắc TTL của `SignalingHub` chỉ áp dụng phiên do server quản lý.

## 3. Danh tính và các ID

Thiết kế ban đầu dùng tài khoản đã đăng ký và thiết bị đã được cấp thông tin
xác thực trước khi hoạt động offline. Đăng ký tài khoản mới hoàn toàn không có
server chưa thuộc phạm vi này.

| Trường dự kiến | Ý nghĩa |
|---|---|
| `UserId` | ID tài khoản đã được server cấp |
| `DeviceId` | Danh tính một cài đặt desktop đã đăng ký; không thay thế xác thực |
| `EndpointId`, `ClientKind` | Một phiên/tab/app và khả năng web/desktop đã thương lượng |
| `LocalConversationId` | UUID local; hai máy có thể dùng UUID khác nhau cho cùng cặp người |
| `ServerConversationId` | ID SQL nullable trong local DB; chỉ có sau khi ánh xạ với server |
| `ClientMessageId` | UUID tạo một lần tại bên gửi, giữ nguyên ở mọi bản sao và khi retry |
| `ServerMessageId` | ID SQL nullable tại desktop; không phải điều kiện để gửi LAN |
| `PeerSessionId` | ID một phiên WebRTC; không phải ID lịch sử |

Giữ cặp chuẩn hóa `UserAID = min(id1, id2)`, `UserBID = max(id1, id2)`.
Khi đồng bộ, server lấy hoặc tạo conversation theo cặp đã xác thực, trả ID
server; mỗi desktop lưu ánh xạ từ conversation local của mình.

Envelope LAN dự kiến chứa phiên bản protocol, ID tin, cặp người, người gửi,
thiết bị gửi, nội dung, thời gian gốc và bằng chứng nguồn gốc. Peer phải kiểm tra
thành viên, danh tính và payload; không tin `SenderId` chỉ vì nó có trong JSON.
Nội dung tối đa 4.000 ký tự và cùng quy tắc chuẩn hóa ở hai phía.

**Điều kiện trước khi lập trình LAN:** chốt thư viện WebRTC WPF và cơ chế chứng
thực thiết bị/chữ ký bằng thư viện chuẩn. Khóa riêng nằm trên thiết bị; không
chia sẻ khóa ký JWT của server cho desktop. Cần quy định hết hạn thông tin
xác thực offline và cách cập nhật thu hồi khi online. Server không thể áp dụng
lệnh khóa mới tức thì cho hai máy đang hoàn toàn offline.

## 4. Lưu tin và trạng thái

### Tin thuộc chế độ lưu server

Client gửi lệnh lưu với `ClientMessageId`; backend lấy người gửi từ phiên
xác thực, kiểm tra quyền, lưu SQL và trả ID chuẩn. Sau đó phát qua SignalR ở
bước chat đầu tiên, hoặc qua DataChannel khi đã triển khai P2P. Mất ACK thì
tra/retry cùng ID. Desktop tham gia còn phải lưu bản nhận/gửi vào SQLite.

### Tin Desktop ↔ Desktop local-only

Desktop ghi tin và outbox trong một transaction SQLite trước khi gửi.
Receiver chống trùng bằng `(SenderId, ClientMessageId)`, lưu thành công rồi ACK.
Mất ACK thì gửi lại; receiver trả ACK cũ, không thêm bóng tin thứ hai. Không
đánh dấu đã nhận chỉ vì hàm gửi trả về thành công.

| Trục trạng thái | Các trạng thái dự kiến | Bằng chứng |
|---|---|---|
| Gửi/nhận | Chờ gửi, đã gửi, đã nhận, đã đọc, lỗi | Kết quả gửi, ACK nhận, ACK đọc của đúng peer; chế độ server có thêm xác nhận commit |
| Lưu cloud | Chỉ trên máy, chờ đồng bộ, đang đồng bộ, đã đồng bộ, lỗi đồng bộ | ACK lưu từng tin từ server |

Hai trục độc lập: tin LAN có thể **đã đọc, chỉ trên máy**. Upload thành công
không chứng minh người nhận đã nhận/đọc. ACK LAN cũng không chứng minh server
đã lưu. UI cần hiển thị trạng thái lưu cloud riêng để tránh hiểu nhầm.

Thời gian gốc do thiết bị khai báo phải tách khỏi thời gian server tiếp nhận.
Đồng hồ hai máy có thể lệch; không dùng timestamp client làm bằng chứng quyền
hoặc thứ tự tuyệt đối. `Messages.CreatedAt` hiện do server cấp. Trước bước sync,
thiết kế trường nguồn thời gian/import và kiểm tra các ràng buộc receipt; không
chép mù timestamp offline vào schema hiện tại.

## 5. Đồng bộ thủ công và sao lưu tự động

**Đồng bộ lên server** là upload lịch sử text đang có trên desktop của người
dùng. Chưa đồng nghĩa với đồng bộ hai chiều hoàn chỉnh mọi thiết bị hoặc sao
lưu bytes file, audio. Sau upload, thành viên còn lại cũng có thể đọc các tin
được lưu qua lịch sử server của conversation; cần nêu điều này ở màn hình cài đặt.

1. Người dùng chọn conversation hoặc toàn bộ lịch sử local của tài khoản hiện
   tại. Kết nối server và xác thực lại nếu cần.
2. Tạo batch từ các tin chưa có xác nhận cloud; giữ nguyên UUID/payload gốc.
3. Server xác thực người upload là thành viên, ánh xạ cặp người sang conversation.
   Với tin do peer gửi, phải kiểm chứng bằng chứng nguồn gốc của peer. Nếu chưa
   có cơ chế này, từ chối nhập tin của người khác; không gán SenderId bằng claim
   người upload hoặc tin tùy ý một SenderId trong request.
4. Server dedupe `(SenderId, ClientMessageId)`: cùng payload/cặp người trả kết
   quả cũ; khác payload trả lỗi xung đột, không ghi đè. Hai desktop cùng upload
   một tin vẫn chỉ tạo một bản ghi server.
5. Trả kết quả riêng cho từng tin: đã lưu/đã tồn tại/bị từ chối, kèm ID server.
   Desktop chỉ đánh dấu đã đồng bộ sau khi nhận kết quả thành công và ghi local.
6. Mất mạng giữa batch thì retry các mục chưa xác nhận; không xóa bản local.
   Tách việc upload lịch sử khỏi giao lại tin chưa nhận; không phát tin cũ như
   tin mới hoặc tự đổi receipt thành đã đọc khi import.

Cài đặt cần nút đồng bộ, công tắc tự động sao lưu, phạm vi conversation, số tin
đang chờ, thời điểm thành công gần nhất và lỗi có thể thử lại. **Đề xuất mặc định
tắt tự động sao lưu** để giữ hành vi local-only; người dùng bật mới chạy.
Sao lưu tự động dùng cùng pipeline upload, chạy khi online và có dữ liệu chờ,
retry có giãn cách. Tắt công tắc dừng lịch upload mới, không xóa dữ liệu đã lên server.
Chu kỳ và giới hạn batch sẽ chọn khi triển khai, chưa có worker chạy hiện tại.

## 6. Hiện trạng triển khai

| Thành phần | Trách nhiệm |
|---|---|
| `ChatHub` cơ bản | Đã có gửi/nhận text, lưu SQL, chống trùng và phát tới hai tài khoản |
| `SignalingHub` | Chưa có; sẽ trao đổi SDP/ICE ở bước 3 |
| Registry endpoint | Theo dõi client kind/khả năng theo phiên, chọn đúng endpoint |
| LAN discovery và signaling local | Tìm và xác thực peer; tạo phiên không qua Hub |
| SQLite repository, local outbox | Lịch sử, receipt, ID mapping; tách dữ liệu theo tài khoản |
| Bộ chọn đường truyền | LAN/WebRTC/server fallback; giữ nguyên chính sách lưu của tin |
| Sync service và API import | Batch, kiểm chứng nguồn gốc, dedupe, kết quả từng tin |
| Cài đặt backup | Lựa chọn phạm vi, tự động sao lưu, tiến độ và lỗi |

SQL Server hiện có thiết kế bảy bảng: `Users`, `Contacts`,
`DirectConversations`, `Messages`, `Calls`, `FileTransfers`, `AdminAuditLogs`.
Chưa có schema SQLite, đăng ký thiết bị, bằng chứng nguồn tin, import metadata
hoặc outbox bền vững. Chốt các phần này rồi mới viết migration riêng; không
chạy lại script tạo schema trên database `PBL4` hiện có.

Code hiện đã có auth, REST conversation/lịch sử/danh bạ và chat web qua
SignalR, gồm ACK/read, chống trùng/retry, unread, presence/typing và reconnect
tải bù. WebRTC, desktop và đồng bộ còn là kế hoạch. Xem
[đặc tả SignalR](signalr-implementation-spec.md),
[conversation đã triển khai](conversations.md) và
[schema server có Admin](database-design-admin.md).

## 7. Lộ trình thực hiện

| Bước | Công việc | Điều kiện hoàn thành |
|---|---|---|
| 0 | Thống nhất README, kiến trúc, SignalR và DB docs | Không còn yêu cầu mọi tin LAN phải commit server trước khi gửi |
| 1 | Chat web qua SignalR; lưu tin và API lịch sử | Hai web gửi nhận thật; reload vẫn còn lịch sử |
| 2 | ACK/read, retry, chống trùng, presence/typing, reconnect, danh bạ | Mất mạng/gửi lại không tạo trùng hoặc báo đã đọc sai |
| 3 | Signaling, WebRTC text, STUN/TURN và fallback | Web ↔ Web P2P hoạt động, server vẫn giữ lịch sử |
| 4 | Gọi thoại | Nhận/từ chối/hủy/mute/timeout, dọn microphone đúng |
| 5 | Truyền file | Chunk/backpressure, tiến độ, SHA-256, hủy và dọn tài nguyên |
| 6 | WPF, SQLite, danh tính thiết bị, LAN và Web ↔ Desktop | Hai desktop LAN chat khi server tắt; web chat được với desktop online server |
| 7 | Đồng bộ thủ công và tự động sao lưu | Retry/batch gián đoạn/upload từ hai máy không trùng; web đọc được phần đã sync |
| 8 | Admin/audit, kiểm thử, triển khai, UML, báo cáo và demo | Chứng minh đủ ba cặp thiết bị và các trường hợp mất kết nối |

## 8. Kiểm thử chấp nhận kiến trúc

| Tình huống | Kết quả cần chứng minh |
|---|---|
| Web ↔ Web qua P2P | Tin tồn tại trên server; reload tải lại được |
| Web ↔ Desktop | Cùng tin xuất hiện trên server và SQLite desktop |
| Hai desktop LAN, server tắt | Chat và đọc lịch sử local được sau khi đã cấp danh tính thiết bị |
| Desktop local-only, server đang online | Không tạo bản sao text server dù có kết nối signaling |
| Desktop chuyển tiếp qua server, backup tắt | Không ghi payload vào DB/log/queue bền vững; receiver offline thì chờ local |
| Một tài khoản mở web và desktop | Tin LAN chưa sync không tự fan-out sang web |
| Hai desktop sync cùng tin; mất response rồi retry | Một bản ghi server, local giữ đúng mapping và trạng thái |
| Một batch có tin không hợp lệ | Báo lỗi từng tin; chỉ đánh dấu synced cho mục được xác nhận |
| Giả SenderId hoặc thay payload cùng UUID | Từ chối, không ghi đè hoặc mạo danh người gửi |
| Backup thành công nhưng peer chưa đọc | Trạng thái cloud cập nhật; trạng thái đã đọc không tự đổi |
| Tắt backup hoặc đăng xuất giữa upload | Dừng việc mới; dữ liệu/ACK không ghi sang tài khoản khác |


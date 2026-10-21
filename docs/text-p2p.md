# Chat text WebRTC Web ↔ Web

Text ưu tiên WebRTC DataChannel khi hai tab đã kết nối. Server vẫn lưu
lịch sử SQL theo chính sách Web ↔ Web. SignalR phục vụ xác thực phiên,
SDP/ICE, receipt, đồng bộ các tab phụ và giao dự phòng.

## Chạy và dùng

1. Cấu hình SQL/JWT theo [authentication.md](authentication.md).
2. Chạy backend: `dotnet run --project PBL4/PBL4.csproj --launch-profile https`.
3. Trong `frontend`, chạy `npm install` nếu cần, rồi `npm run dev`.
4. Đăng nhập hai tài khoản trong hai cửa sổ trình duyệt. Mở cuộc trò chuyện.
5. Quan sát dòng đường gửi text dưới tên người nhận. Khi đang kết nối, tin
   mới vẫn gửi SignalR ngay; không phải đợi P2P sẵn sàng.

Các nhãn gồm WebRTC trực tiếp, WebRTC qua TURN, WebRTC chưa xác định đường
mạng và SignalR dự phòng. Chỉ hiện trực tiếp/TURN khi `getStats()` cung cấp
candidate pair được chọn; không suy ra trực tiếp chỉ từ trạng thái connected.

## Luồng dữ liệu

```text
A -- StartTextSession / SDP / ICE qua ChatHub --> B
A -- CommitPeerMessage --> SQL; trả DTO đã lưu cho A
A =========== chat-v1: DTO text ===============> B
B -- AcknowledgePeerMessage + hash text --> Server
B <--- receipt + thời gian gốc SQL ----------- Server
B =========== chat-v1: ACK ===================> A
```

Commit không phát `MessageReceived` đến tab nhận P2P đã chọn. Những tab
còn lại của hai tài khoản vẫn được đồng bộ qua SignalR. Một tài khoản có
nhiều tab chỉ có một endpoint P2P cho phiên; tab phụ có thể chat qua server.

Receiver kiểm tra protocol, phiên, conversation, sender, ID, độ dài text
và hash SHA-256 của nội dung với bản đã commit trước khi nhận/ACK. Server
trả thời gian SQL để không dùng thời gian do peer tự nhận làm thứ tự chuẩn.
Đây không phải mã hóa đầu cuối bản sao SQL: text vẫn gửi lên server để lưu.

Mỗi tin giữ `(SenderId, ClientMessageId)` qua P2P, SignalR và retry.
BIGINT server dùng chuỗi trong JavaScript. UI merge theo danh tính tin,
giữ receipt đã có khi một bản sao cũ đến muộn và xếp tin đã lưu theo ID SQL.

## Fallback và receipt

- Chưa có kênh ready: `SendMessage` hiện có lưu và giao SignalR ngay.
- Có kênh ready: commit trước rồi gửi DataChannel.
- Send lỗi hoặc không có ACK sau 5 giây: `RelayCommittedMessage` tìm bản
  đã lưu của đúng sender/UUID và phát SignalR, không tạo tin mới.
- Mất phản hồi commit: thử lại cùng UUID bằng SendMessage. SQL dedupe
  trả bản cũ hoặc tạo một bản nếu lần trước chưa commit.
- Nếu tab gửi đóng sau commit nhưng trước khi giao P2P, thông báo kết thúc
  phiên làm bên nhận tải bù các tin đang chờ trên server.
- Reconnect đổi ConnectionId: bỏ peer cũ, tải bù lịch sử, thiết lập phiên mới.
- Web mất server chưa hỗ trợ gửi mới chỉ qua P2P hoặc outbox bền vững.

Commit hoặc `channel.send()` không tự đánh dấu đã nhận. Client mới dùng
ACK/read theo từng MessageId; `MessageStatusDto.messageId` khác null nghĩa
là exact receipt. ACK cộng dồn cũ vẫn tồn tại cho client cũ; client mới không
dùng nó cho một frame P2P lẻ. Read chỉ chạy khi thread đang visible. Server
trả unread count sau exact read, không xóa toàn bộ unread khi chỉ đọc một tin.

## Phiên và giới hạn

MVP chạy một backend instance. Phiên nằm trong RAM, UUID do server cấp,
ràng buộc conversation và hai connection ID. Initiator tạo offer; hai bên
khởi tạo đồng thời hội tụ cùng phiên. Server chọn tab đích khả dụng theo
ConnectionId, không suy ra loại thiết bị từ tài khoản.

| Giới hạn | Giá trị |
|---|---:|
| Nội dung | 1–4.000 ký tự sau trim |
| Thương lượng | 15 giây |
| Chờ ACK text | 5 giây |
| Dọn phiên | mỗi 5 giây |
| Idle phiên ready | 20 phút từ hoạt động server gần nhất |
| Tổng phiên | 1.000 |
| Phiên mỗi tài khoản | 8 |
| SDP | 24.000 ký tự |
| ICE payload | 4.096 ký tự, 128 candidate mỗi phía |

Một phiên chỉ có một offer/answer. ICE đến sớm được queue tới khi có remote
description. Client thử thiết lập lại các conversation đã mở mỗi 15 giây.
Mất kết nối, thu hồi token, khóa tài khoản hoặc logout làm dọn phiên và
peer/channel/timer/listener trong app. Server không cưỡng ép được client P2P
đã bị sửa. Text dùng peer riêng nên kết thúc truyền file không đóng text.

Các lỗi signaling dùng tiền tố `TEXT_`, ví dụ `TEXT_WRONG_ENDPOINT`,
`TEXT_SESSION_CLOSED`, `TEXT_PEER_NOT_READY`, `TEXT_SIGNAL_LIMIT`.
Giới hạn registry/candidate không thay thế bảo vệ tải ở reverse proxy.

## API và source

| Hub method | Input / ý nghĩa |
|---|---|
| `StartTextSession` | conversationId; trả phiên hoặc null nếu chưa có endpoint |
| `SendTextSignal` | sessionId, kind offer/answer/ice, payload |
| `TextSessionReady` | sessionId; tab báo DataChannel mở |
| `CloseTextSession` | sessionId; kết thúc phiên của đúng endpoint |
| `CommitPeerMessage` | sessionId, message với conversationId/clientMessageId/content |
| `RelayCommittedMessage` | conversationId/clientMessageId của tin do chính caller gửi |
| `AcknowledgePeerMessage` | sessionId/messageId/clientMessageId/contentSha256Hex |
| `AcknowledgeMessage` | conversationId/messageId; exact delivered |
| `ReadMessage` | conversationId/messageId; exact read và unread count |

Sự kiện mới: `TextSessionStarted`, `TextSignal`, `TextSessionClosed`.
Receipt dùng `MessageStatusChanged` hiện có, thêm MessageId/UnreadCount
nullable. `SendMessage`, ACK/read cộng dồn và API lịch sử cũ giữ contract.

Backend: `TextPeerSessionService`, `TextPeerMonitor`, `ChatHub`,
`MessageService`, `MessageReceiptService`, `TextPeerDtos`.
Frontend: `textChatTransport.js`, `textProtocol.js`, `ChatRealtimeProvider`,
`chatState.js`, `ChatPage`, `ConversationThread`.

## Cấu hình mạng

Dùng chung `WebRtc:IceServers` và `/api/v1/files/configuration` với truyền
file; xem [file-transfers.md](file-transfers.md#cấu-hình-mạng).
Mặc định ICE server rỗng chỉ phù hợp thử host candidate có thể liên lạc.
Khác mạng/NAT cần cấu hình và kiểm tra STUN/TURN thật. Web cần HTTPS hoặc
localhost để hash bằng Web Crypto. Không commit TURN credential.

## Kiểm thử

Unit không cần server:

```powershell
node --test tests/text-chat.mjs tests/frontend-chat-state.mjs
```

API/SignalR và browser dùng backend/Vite đang chạy, SQL cùng database:

```powershell
$env:AUTH_TEST_SQL_SERVER = 'localhost'
$env:AUTH_TEST_DATABASE = 'PBL4'
$env:TEXT_TEST_ORIGIN = 'http://127.0.0.1:5173'
node tests/text-p2p.integration.mjs

# Thư mục node_modules có playwright, Chrome đã cài.
$env:CODEX_NODE_MODULES = 'duong-dan-tuyet-doi/toi/node_modules'
node tests/text-p2p.e2e.mjs
```

Không chạy song song các script integration/browser vì có giới hạn auth
20 request/IP/phút. Script chỉ xóa tài khoản, conversation, tin và metadata
file có tên ngẫu nhiên do chính lượt chạy tạo, trong `finally`.

Kiểm thử browser instrument API WebSocket/DataChannel, không thêm test hook
vào app. Nó chặn payload MessageReceived của tin chứng minh P2P, kiểm tra
frame DataChannel thật, giả lập mất ACK, rồi kiểm tra một row SQL/một bubble.
Có thử tab phụ, nhận khi ở Tệp, thread ẩn trên màn hình nhỏ không read hoặc
xóa unread, reload lịch sử, cắt DataChannel sau commit, đóng tab gửi trước
khi payload đi và truyền file 1 MiB đồng thời với text, đối chiếu hash bytes
tải xuống. Tải bù khi đóng phiên chạy nền, giữ thread đang hiển thị.

Kiểm thử hồi quy SignalR cũ tắt WebRTC trong browser test để kiểm tra riêng
đường dự phòng. Trình duyệt online trở lại sẽ tải bù dù lần mất mạng quá ngắn
để SignalR kịp chuyển sang disconnected.

Đã có bằng chứng trên hai Chrome context cùng máy localhost ngày 21/10/2026.
**Chưa nghiệm thu hai máy LAN vật lý, WAN/khác NAT hoặc ép TURN thật.**
Không dùng kết quả localhost để tuyên bố độ trễ WAN hoặc sức tải chat/file.

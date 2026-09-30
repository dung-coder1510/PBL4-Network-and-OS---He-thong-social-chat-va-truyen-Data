# Cuộc trò chuyện 1–1

## Phạm vi

Đã nối dữ liệu thật cho tìm người, tạo/mở lại cuộc trò chuyện, gửi/nhận text
qua SignalR và tải lịch sử Messages bằng REST. Dùng các bảng có sẵn trong
database PBL4; không tạo DB, migration hay thay đổi schema. Không cần thêm
danh bạ trước.

`ChatHub` hiện hoàn thành nghiệp vụ chat web của bước 2: ACK đã nhận/đã đọc,
retry giữ nguyên `ClientMessageId`, unread, presence nhiều kết nối, typing và
reconnect tải bù từ REST. Conversation mới, preview và trạng thái tin được cập
nhật realtime, không cần tải lại trang. Chưa có WebRTC hoặc tin local của desktop.

## Cách sử dụng

Chạy backend và frontend theo [hướng dẫn xác thực](authentication.md).
Tạo hai tài khoản qua Đăng ký. Đăng nhập tài khoản thứ nhất, vào Trò chuyện,
bấm nút bút ở đầu danh sách hoặc Bắt đầu trò chuyện. Nhập ít nhất hai ký tự,
chọn người tìm được và bấm Bắt đầu trò chuyện.

Nếu cặp người dùng đã có cuộc trò chuyện, hệ thống mở lại bản ghi cũ.
Đăng nhập tài khoản còn lại sẽ thấy cùng cuộc trò chuyện trong danh sách.
Mở cuộc trò chuyện và gửi tin từ hai cửa sổ trình duyệt. Tin được lưu SQL
trước khi Hub phát `MessageReceived`; tải lại trang và đăng nhập lại vẫn đọc
được lịch sử. Frontend tạo một `ClientMessageId`, giữ nguyên ID khi bấm gửi lại.
Receiver gửi `AcknowledgeDelivered` khi nhận event và `MarkAsRead` khi đang mở
conversation; sidebar lấy số chưa đọc thật từ server.

Ở cửa sổ rộng, danh sách và khung trò chuyện nằm cạnh nhau. Ở cửa sổ hẹp,
chọn người để mở khung chat, dùng nút mũi tên quay về danh sách.
Hộp tìm người dùng dialog native, giữ focus trong hộp và đóng bằng Escape
khi không có thao tác tạo đang chạy. Truy vấn tìm kiếm có debounce 300 ms
và hủy request cũ, tránh kết quả cũ ghi đè kết quả mới.

## REST API

Mọi endpoint dưới đây đều yêu cầu `Authorization: Bearer <accessToken>`.

| Method | URL | Kết quả |
| --- | --- | --- |
| GET | /api/v1/users?search=dung | Mảng thông tin tối đa 20 người phù hợp |
| POST | /api/v1/conversations | 201 khi tạo mới, 200 khi mở lại bản ghi đã có |
| GET | /api/v1/conversations?limit=30&beforeId=100&search=dung | Danh sách phân trang của mình |
| GET | /api/v1/conversations/15 | Chi tiết cuộc trò chuyện mà mình tham gia |
| GET | /api/v1/conversations/15/messages?limit=50&beforeId=200 | Lịch sử text phân trang |
| GET | /api/v1/contacts | Danh bạ một chiều của tài khoản |
| POST | /api/v1/contacts | Thêm liên hệ và alias tùy chọn |
| PUT | /api/v1/contacts/8 | Đổi hoặc xóa alias |
| DELETE | /api/v1/contacts/8 | Xóa liên hệ |

Search tìm theo username hoặc displayName, bỏ qua chính mình và user bị khóa.
Query tìm người có dưới hai ký tự trả mảng rỗng; tối đa 100 ký tự.
Không trả PasswordHash, Role, trạng thái phiên hay navigation entities.

POST nhận đúng thông tin cần thiết:

```json
{ "peerUserId": 8 }
```

ID người đang thao tác luôn lấy từ token, không lấy từ body.
Phản hồi ConversationDto:

```json
{
  "id": "15",
  "peer": {
    "id": 8,
    "username": "hoangdung",
    "displayName": "Nguyễn Hoàng Dũng",
    "avatarPath": null,
    "isDisabled": false,
    "isOnline": true,
    "lastSeenAt": null
  },
  "createdAt": "2026-09-29T08:00:00Z",
  "hasMessages": false,
  "lastMessage": null,
  "unreadCount": 0
}
```

ID cuộc trò chuyện là **chuỗi** trong JSON vì SQL BIGINT có thể vượt độ chính xác
của Number bên JavaScript. Frontend giữ nguyên chuỗi khi chọn và gọi API.
Ngày giờ trả về UTC. Peer luôn là người đối diện, tùy tài khoản đang xem.
AvatarPath có trong DTO nhưng chưa có upload/hiển thị ảnh mới; UI dùng chữ viết tắt.

Danh sách trả `{ items: [...], nextCursor: "15" }`; nextCursor null khi hết.
Truyền nextCursor vào beforeId để lấy trang kế tiếp. Limit mặc định 30,
cho phép 1–100. Danh sách xếp theo ID giảm dần (mới tạo trước), chưa xếp theo
tin nhắn cuối. Tìm kiếm danh sách chạy trên server, không chỉ lọc trang đã tải.

POST 201 kèm header Location trỏ đến GET chi tiết. Mã lỗi: 400 cho dữ liệu sai
hoặc chọn chính mình, 401 khi chưa xác thực/phiên hết hạn, 404 khi người được
chọn không còn khả dụng hoặc cuộc trò chuyện không thuộc tài khoản.
409 nếu dữ liệu người dùng thay đổi làm vi phạm khóa ngoại lúc INSERT.

Lịch sử trả tối đa 100 tin, mỗi trang theo thứ tự cũ đến mới để render.
`nextCursor` là ID của tin cũ nhất trong trang; truyền vào `beforeId` để tải
trang cũ hơn. Người ngoài conversation nhận cùng lỗi 404 như ID không tồn tại.

## SignalR chat

Kết nối đến `/hubs/chat` bằng JWT. Vite proxy cả HTTP `/api` và WebSocket
`/hubs`. Trình duyệt dùng `accessTokenFactory`; backend chỉ đọc query
`access_token` trên route Hub và `IUserIdProvider` lấy đúng claim `sub`.

Client gọi `SendMessage`:

```json
{
  "conversationId": "15",
  "clientMessageId": "b86ff549-ef04-45f6-8bf1-6fa98513304d",
  "content": "14h họp nhóm nha"
}
```

Backend lấy `SenderId` từ JWT, kiểm tra thành viên, trim nội dung 1–4000 ký tự,
lưu DB rồi phát `MessageReceived` tới mọi connection SignalR của hai tài khoản.
Kết quả invoke và event cùng là `MessageDto`; frontend upsert theo
`(senderId, clientMessageId)` nên event/response đến khác thứ tự không tạo hai bóng tin.

Retry cùng `ClientMessageId`, conversation và nội dung trả bản ghi cũ. Dùng lại
UUID đó với payload khác bị từ chối. Đây là chống trùng khi gửi, chưa phải ACK
đã nhận/đã đọc. `messageId`, `conversationId` và cursor giữ kiểu chuỗi ở JS.

## Bảo toàn dữ liệu và quyền truy cập

Server lưu UserAID = min(currentUserId, peerUserId), UserBID = max(...).
Unique constraint của DB quyết định tính duy nhất. Nếu hai request vượt qua
bước kiểm tra tồn tại cùng lúc, request thua unique constraint đọc lại bản ghi
đã được tạo và trả 200. Không chỉ dựa vào việc vô hiệu hóa nút trên giao diện.

Danh sách và chi tiết luôn lọc theo UserAID hoặc UserBID bằng ID của người
đang đăng nhập. Admin cũng không được bỏ qua kiểm tra thành viên.
Chi tiết trả cùng thông báo 404 cho cuộc trò chuyện không tồn tại và không
có quyền xem, tránh tiết lộ sự tồn tại của cuộc trò chuyện riêng.
Tạo cuộc trò chuyện không tạo tin nhắn, liên hệ, cuộc gọi hay file transfer.

## Các file chính

| File | Trách nhiệm |
| --- | --- |
| PBL4/Controllers/UsersController.cs | Tìm người dùng, giữ các API tài khoản có sẵn |
| PBL4/Controllers/ConversationsController.cs | Tạo, chống trùng, danh sách và kiểm tra quyền xem |
| PBL4/Contracts/ConversationDtos.cs | DTO request/response |
| PBL4/Contracts/MessageDtos.cs | DTO gửi tin, tin đã lưu và trang lịch sử |
| PBL4/Services/MessageService.cs | Quyền thành viên, validation, idempotence và lưu SQL |
| PBL4/Realtime/ChatHub.cs | Lệnh SendMessage và event MessageReceived strongly typed |
| PBL4/Realtime/SubClaimUserIdProvider.cs | Ánh xạ claim sub sang SignalR UserIdentifier |
| PBL4/Controllers/MessagesController.cs | GET lịch sử có phân trang và kiểm tra thành viên |
| frontend/src/services/apiClient.js | HTTP, Bearer token, lỗi và timeout dùng chung |
| frontend/src/services/conversationsApi.js | Các request nghiệp vụ cuộc trò chuyện |
| frontend/src/services/chatConnection.js | Ba nhóm hàm connection, server event và client command |
| frontend/src/pages/ChatPage.jsx | Conversation, SignalR, lịch sử và optimistic message |
| frontend/src/components/chat/ConversationList.jsx | Danh sách, tìm kiếm, làm mới, xem thêm |
| frontend/src/components/chat/NewConversationDialog.jsx | Tìm người và tạo/mở cuộc trò chuyện |
| frontend/src/components/chat/ConversationThread.jsx | Danh sách tin, tự cuộn, composer, lỗi và gửi lại |
| frontend/src/styles/conversations.css | Bố cục và hộp tìm người |

## Kiểm thử

Build backend, lint/build frontend như trong hướng dẫn xác thực. Kiểm thử tích hợp
ở thư mục gốc repository khi backend và Vite đang chạy:

```powershell
$env:AUTH_TEST_SQL_SERVER = 'TRUNG'
$env:AUTH_TEST_DATABASE = 'PBL4'
node tests/conversations.integration.mjs
```

Script cần sqlcmd và Windows Authentication. Tạo ba user có username ngẫu nhiên,
chỉ cập nhật các user thử và dọn các cuộc trò chuyện giữa chúng trong finally.
Không sửa/xóa dữ liệu người dùng có sẵn. Không chạy đồng thời với bộ auth test;
nếu vừa chạy auth test, chờ qua cửa sổ rate limit một phút trước khi tạo fixture.

18 kiểm tra gồm xác thực, tìm tên tiếng Việt, dữ liệu trả ra, user bị khóa,
chọn chính mình, hai phía tạo đồng thời, tạo lặp, quyền riêng tư kể cả Admin,
phân trang, lọc danh sách, giữ cuộc trò chuyện sau đăng nhập lại và không tạo Messages.

Kiểm thử chat chạy trực tiếp với backend trên một cổng local riêng:

```powershell
$env:AUTH_TEST_SQL_SERVER = 'TRUNG'
$env:AUTH_TEST_DATABASE = 'PBL4'
$env:MESSAGE_TEST_ORIGIN = 'http://127.0.0.1:5255'
node tests/messages.integration.mjs
```

Script kiểm tra ba kết nối Hub có JWT, phát realtime đúng người, lịch sử hai
thành viên, quyền riêng tư, retry chống trùng, xung đột UUID và phân trang.
Nó dọn đúng tài khoản/conversation/message có prefix ngẫu nhiên của lượt chạy.

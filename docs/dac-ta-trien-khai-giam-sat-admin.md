# Đặc tả triển khai chức năng giám sát quản trị

Ngày lập: 01/11/2026. Tài liệu mô tả code đã triển khai trong repository PBL4, không phải danh sách tính năng dự kiến.

## 1. Phạm vi và kiến trúc

Mục tiêu: cung cấp cho Admin một màn hình theo dõi người dùng/kết nối, request, lưu lượng/thời gian xử lý backend và các phiên truyền file. Chức năng giám sát phục vụ quan sát, không thay thế kiểm tra quyền hoặc máy trạng thái nghiệp vụ truyền file.

| Thành phần | Trách nhiệm trong triển khai | Nguồn dữ liệu / nơi lưu |
|---|---|---|
| HTTP middleware | Đo từng request API đi qua vùng middleware: thời gian, kết quả, byte đọc/ghi | Gửi mẫu vào `MonitoringService` |
| SignalR Hub filter | Đo lời gọi phương thức Hub; theo dõi kết nối, heartbeat; hạn chế báo cáo file | Bộ nhớ của `MonitoringService` |
| Dịch vụ truyền file | Ghi chuyển trạng thái, báo hiệu offer/answer và nguyên nhân thất bại; xác thực báo cáo client | Metadata chính thức trong SQL; sự kiện chẩn đoán trong bộ nhớ |
| Client truyền file | Báo mở kênh, tiến độ, kiểm tra file; gửi mã lỗi qua thao tác thất bại | SignalR `ReportFileObservation` và `FailFile` |
| API quản trị | Kiểm tra quyền; ghép người dùng/phiên file từ SQL với snapshot giám sát | `GET /api/v1/admin/monitoring` |
| Trang quản trị | Poll có kiểm soát; bảng, biểu đồ, timeline và màu độ mới | Snapshot gần nhất nhận thành công |
| Worker lưu trữ | Lưu mẫu request và sự kiện file theo lô, khôi phục sau restart | `App_Data/monitoring/snapshot.json` dưới content root backend |

Đơn vị triển khai hiện tại là **một backend instance**. Byte của file đi qua WebRTC giữa A và B không đi qua bộ đo HTTP/SignalR này. Tiến độ do client báo không phải phép đo lưu lượng mạng độc lập của server.

## 2. Bảng công việc triển khai chi tiết

Các đường dẫn trong bảng tính từ thư mục gốc repository.

### 2.1. Người dùng và kết nối

| Mã | Công việc đã làm | Module / hàm | Xử lý cụ thể | Ràng buộc / kết quả |
|---|---|---|---|---|
| U01 | Lấy danh sách người dùng | `PBL4/Controllers/MonitoringController.cs` — `Get` | Truy vấn `Users.AsNoTracking()`, lọc `Id > afterUserId`, tăng dần theo ID; lấy 51 để xác định còn trang sau | Trả tối đa 50 người dùng; cursor âm bị trả 400 |
| U02 | Chọn thông tin hiển thị | `MonitoringController.Get` | Lấy ID, username, display name, role, trạng thái khóa và lần xuất hiện cuối | Không trả mật khẩu/token; dữ liệu tài khoản lấy từ SQL |
| U03 | Ghi kết nối mới | `PBL4/Services/MonitoringService.cs` — `OnConnectedAsync` | Sau khi chuỗi xử lý kết nối thành công, lưu connection ID, user ID lấy từ claim `sub`, thời điểm kết nối và hoạt động | Một user có thể có nhiều connection; không suy luận mỗi connection là một thiết bị |
| U04 | Xóa kết nối đóng | `MonitoringService.OnDisconnectedAsync` | Gọi phần xử lý tiếp theo; xóa connection trong `finally` | Không giữ connection sống qua restart |
| U05 | Cập nhật hoạt động | `MonitoringService.InvokeMethodAsync` | Cập nhật `LastSeenAt` khi lời gọi đi qua filter; cập nhật `LastHeartbeatAt` sau khi `Heartbeat` thành công | Heartbeat thành công không chứng minh người dùng đang thao tác UI |
| U06 | Tổng hợp kết nối | `MonitoringService.Snapshot` | Đếm tổng connection, số user phân biệt; lọc connection theo trang user đang xem | Response có tối đa 500 connection cho trang user; số tổng vẫn tính toàn instance |
| U07 | Bảng và tìm kiếm | `frontend/src/pages/MonitoringPage.jsx` | Hiện tài khoản, vai trò, trạng thái, ID connection rút gọn, thời điểm mở và heartbeat; lọc theo username/display name | Tìm kiếm chỉ trong 50 user của trang hiện tại; có nút về đầu và trang tiếp |

### 2.2. Request HTTP API và SignalR

| Mã | Công việc đã làm | Module / hàm | Xử lý cụ thể | Ràng buộc / kết quả |
|---|---|---|---|---|
| R01 | Gắn bộ đo HTTP | `PBL4/Program.cs` — middleware | Đo request thuộc `/api`, loại API giám sát; dùng `Stopwatch` quanh `await next()` | Không tính mọi request của toàn web server; không tự tạo tải thống kê từ poll dashboard |
| R02 | Chuẩn hóa tên thao tác | HTTP middleware | Ghép HTTP method với route template; thiếu endpoint dùng `unmatched` | Không dùng URL chứa từng ID/query làm nhãn thống kê |
| R03 | Phân loại HTTP | HTTP middleware | Exception hủy → `cancelled`; exception khác → `error`; HTTP 5xx → `error`; HTTP 4xx chưa có lỗi khác → `rejected` | HTTP 5xx có thể ghi đè phân loại trước đó theo thứ tự code |
| R04 | Đo Hub invocation | `MonitoringService.InvokeMethodAsync` | Đo riêng từng phương thức Hub; tăng bộ đếm trước xử lý và giảm trong `finally` | Không coi mỗi frame WebSocket là một request HTTP |
| R05 | Phân loại Hub | `MonitoringService.InvokeMethodAsync` | `OperationCanceledException` → hủy; `HubException` → từ chối; exception khác → lỗi; trả bình thường → thành công | Giữ tên method để thấy riêng `Heartbeat`, `SendFileSignal`, `ReportFileObservation`… |
| R06 | Lưu mẫu hữu hạn | `MonitoringService.Record`, `Trim` | Đưa mẫu vào queue, xóa mẫu quá tuổi hoặc quá số lượng dưới khóa | Tối đa 20.000 mẫu và 15 phút; tràn dung lượng tăng `droppedSamples` |
| R07 | Gom dữ liệu biểu đồ | `MonitoringService.Snapshot` | Gom theo loại HTTP/SignalR và bucket 5 giây; `requestsPerSecond = số mẫu / 5` | Tần suất là trung bình mỗi bucket; mẫu được ghi khi xử lý kết thúc |
| R08 | Vẽ hai biểu đồ | `MonitoringPage.jsx` — `RequestChart` | SVG gồm 60 bucket × 5 giây; bổ sung giá trị 0 ở bucket không có mẫu | Hiển thị 5 phút gần nhất; thống kê bảng có thể dùng đến 15 phút mẫu còn giữ |
| R09 | Báo dữ liệu bị cắt | `MonitoringPage` | Khi `droppedSamples > 0`, hiện số mẫu đã loại và thời điểm mẫu cũ nhất còn giữ | Không khẳng định biểu đồ đại diện toàn bộ lưu lượng khi đã tràn queue; bộ đếm loại mẫu không được lưu vào archive |

### 2.3. Lưu lượng và thời gian xử lý backend

| Mã | Công việc đã làm | Module / hàm | Xử lý cụ thể | Phạm vi phép đo |
|---|---|---|---|---|
| M01 | Đếm byte HTTP | `PBL4/Services/MeasuredStream.cs` và middleware | Bọc stream request/response; chuyển tiếp thao tác đọc/ghi đồng bộ và bất đồng bộ; cộng byte thực tế | Không lưu payload; không bao gồm TLS/header; chỉ đếm những byte đi qua wrapper |
| M02 | Bảo toàn stream | HTTP middleware | Giữ stream gốc, gắn wrapper trong thời gian xử lý, trả stream gốc trong `finally` | Wrapper không sở hữu/đóng stream gốc; exception handler ngoài vùng đo có thể tạo response chưa được tính |
| M03 | Ước tính byte SignalR | `MonitoringService.Estimate` | Serialize arguments/result sang UTF-8 JSON để lấy độ dài; không giữ mảng byte sau phép tính | Không phải số byte WebSocket thực; không gồm envelope, broadcast, TLS; serialize lỗi trả null |
| M04 | Bộ đếm đang xử lý | `EnterHttp`, `LeaveHttp`, `InvokeMethodAsync` | Tăng/giảm bằng `Interlocked`; snapshot đọc giá trị hiện tại | Tách HTTP và Hub; dashboard không tính chính request poll của nó |
| M05 | Thống kê theo thao tác | `MonitoringService.Snapshot` | Group theo `Kind + Operation`; tính count, errors, rejected, cancelled, tổng byte, trung bình thời gian | Nếu không có mẫu đo byte thì tổng tương ứng là null; nếu đo một phần thì tổng chỉ từ mẫu có giá trị |
| M06 | Tính p95 | `MonitoringService.Snapshot` | Sắp xếp thời gian tăng dần; lấy phần tử tại `ceil(n × 0.95) - 1` | p95 của các mẫu còn giữ, không phải của toàn bộ lịch sử |
| M07 | Hiển thị số liệu | `MonitoringPage` | Bảng loại/thao tác, số mẫu, lỗi/từ chối/hủy, TB/p95, byte vào/ra; null hiện “Chưa đo” | Thời gian bao gồm chờ và xử lý trong vùng đo; không phải RTT mạng A–server hoặc A–B |

### 2.4. Theo dõi phiên truyền file

| Mã | Công việc đã làm | Module / hàm | Xử lý cụ thể | Ràng buộc / kết quả |
|---|---|---|---|---|
| F01 | Lấy metadata phiên | `MonitoringController.Get` | Đọc `FileTransfers` và conversation để suy ra người nhận; giảm dần theo ID; lấy 51 | Trả tối đa 50 phiên; cursor `beforeFileId` nếu có phải >0; không trả tên/nội dung file hoặc SHA |
| F02 | DTO báo cáo | `PBL4/Contracts/FileDtos.cs` — `FileObservationDto` | Nhận `TransferId`, `Stage`, `Bytes?`, `Reason?` | Không nhận user ID/connection ID do client tự khai |
| F03 | Điểm nhận SignalR | `PBL4/Realtime/ChatHub.cs` — `ReportFileObservation` | Chuyển DTO cùng `CurrentUserId` và `Context.ConnectionId` vào service | Danh tính gắn với phiên kết nối được xác thực |
| F04 | Giới hạn tần suất tổng | `MonitoringService.InvokeMethodAsync` | Tối đa 8 lần gọi báo cáo trong cửa sổ 5 giây cho mỗi connection | Chặn trước khi chạm semaphore dịch vụ file; lần bị chặn tại đây hiện chưa đi vào `Record` thống kê Hub |
| F05 | Kiểm tra dữ liệu | `PBL4/Services/FileTransferService.cs` — `ReportAsync` | Parse ID; kiểm tra allowlist stage/reason; byte không âm và không vượt giới hạn file | Sai định dạng/giá trị bị `HubException`; giới hạn file hiện tại là 100 MiB |
| F06 | Kiểm tra endpoint | `ReportAsync` | Dưới semaphore: tìm phiên active; đối chiếu cả user ID và connection ID của A hoặc B | Phiên không còn active được bỏ qua; tab khác bị từ chối |
| F07 | Kiểm tra tính tiến triển | `ReportAsync` | Không nhận khi quá deadline, byte vượt kích thước thật hoặc giảm; không nhận stage lùi | Thứ tự `channel-open → transferring → verifying → failed`; bên gửi không được báo `verifying` |
| F08 | Hạn chế mẫu mỗi phía | `ReportAsync` | Lưu stage, byte và thời điểm báo riêng cho A/B; cùng stage tối thiểu 5 giây; đổi stage nhận ngay nếu hợp lệ | Mẫu bị bỏ qua không thay đổi trạng thái nghiệp vụ |
| F09 | Gửi báo cáo client | `frontend/src/services/fileTransfers.js` — `observe` | Gọi `ReportFileObservation`; mỗi phiên tối đa một invocation đang chờ và một mẫu mới nhất xếp sau | Cùng stage giới hạn 5 giây; lỗi telemetry được bỏ qua để không làm hỏng truyền file; không bảo đảm gửi mọi mẫu |
| F10 | Gắn báo cáo vào luồng file | `fileTransfers.js` — callback mở kênh, `progress`, xử lý kết thúc nhận | Kênh mở báo `channel-open`; cập nhật byte báo `transferring`; nhận đủ và bắt đầu xác minh báo `verifying` | Bộ đo tiến độ không thay thế việc nhận chunk hoặc so sánh SHA-256 |
| F11 | Ghi sự kiện backend | `FileTransferService.PublishAsync`, `SignalAsync` | Ghi trạng thái được publish và báo hiệu offer/answer | Không ghi payload SDP hoặc từng ICE candidate vào journal |
| F12 | Nhận mã lỗi client | `FileActionDto.FailureCode`, `fileTransfers.js` — `fail`, service `ActAsync` | Client ánh xạ lỗi thành mã; gửi cùng `FailFile`; service lưu `failure-report` có nguồn | Mã allowlist; không lưu exception text tùy ý; nhãn client là lời báo cáo, không phải xác nhận độc lập |
| F13 | Ghi nguyên nhân server | Nhánh quét phiên của `FileTransferService` | Ghi mất registry, tài khoản khóa, quá hạn lời mời/truyền, endpoint ngắt | Phân biệt nguồn backend với client-A/client-B |
| F14 | Lưu nhật ký | `MonitoringService.File` | Gắn timestamp UTC tại server; enqueue sự kiện có ID, nguồn, stage, byte, reason | Tối đa 5.000 sự kiện trong 24 giờ; API chỉ trả tối đa 500 sự kiện thuộc trang phiên hiện tại |
| F15 | Hiển thị phiên và timeline | `MonitoringPage` | Bảng ID, A→B, kích thước, trạng thái SQL, báo cáo client gần nhất; bấm ID mở timeline | Nếu failed không có nguyên nhân thì hiện UNKNOWN; timeline có thể không đầy đủ do retention/cap |
| F16 | Dọn dữ liệu phía client | `fileTransfers.js` — xử lý terminal/disconnected | Xóa entry theo phiên khi kết thúc; clear quan sát khi ngắt kết nối | Không duy trì hàng đợi báo cáo vô hạn |

## 3. Hợp đồng dữ liệu và mã trạng thái

### 3.1. API dashboard

`GET /api/v1/admin/monitoring?afterUserId=0&beforeFileId=...`

| Trường response | Nội dung | Nơi sử dụng |
|---|---|---|
| `users` | Tối đa 50 tài khoản | Bảng người dùng |
| `files` | Tối đa 50 metadata phiên file | Bảng phiên |
| `nextUserId` / `nextFileId` | Cursor trang sau, null khi hết | Nút phân trang độc lập cho hai bảng |
| `metrics.generatedAt` | Thời điểm tạo snapshot server | Mốc tính tuổi sự kiện file |
| `metrics.totalConnections`, `connectedUsers` | Số tổng của instance | Tổng quan |
| `metrics.connections`, `connectionLimit` | Kết nối trong trang user và giới hạn trả về | Chi tiết kết nối |
| `metrics.activeHttp`, `activeHub` | Số thao tác đang xử lý | Nhóm thời gian/lưu lượng |
| `metrics.operations` | Thống kê theo HTTP route/Hub method | Bảng số liệu |
| `metrics.series` | Bucket 5 giây theo loại request | Biểu đồ |
| `metrics.fileEvents` | Sự kiện thuộc trang phiên file | Tiến độ, lý do lỗi, timeline |
| `metrics.droppedSamples`, `sampleWindowStart`, `scope` | Phạm vi và dấu hiệu dữ liệu bị giới hạn | Cảnh báo và mô tả phép đo |

### 3.2. Nguyên nhân file được ghi nhận

| Mã | Ý nghĩa | Nguồn |
|---|---|---|
| `HASH_MISMATCH` | Client báo vấn đề xác minh SHA | Client |
| `INVALID_CHUNK` | Client báo chunk không hợp lệ | Client |
| `WEBRTC_FAILED` | Client báo lỗi liên quan WebRTC | Client |
| `TRANSFER_TIMEOUT` | Quá thời gian truyền/không có tiến triển theo nhánh xử lý | Client hoặc backend; đọc kèm source |
| `OFFER_TIMEOUT` | Lời mời hết hạn | Backend |
| `ENDPOINT_DISCONNECTED` | Endpoint của phiên không còn kết nối hợp lệ | Backend |
| `ACCOUNT_DISABLED` | Một tài khoản liên quan bị khóa | Backend |
| `SERVER_STATE_LOST` | Không còn trạng thái registry cần thiết | Backend |
| `UNKNOWN` | Không phân loại được hoặc thiếu bằng chứng còn lưu | Giá trị dự phòng |

Client hiện ánh xạ lỗi dựa vào chuỗi thông báo trong `fail`; đây chưa phải hệ thống exception có mã lỗi kiểu hóa xuyên suốt toàn bộ ứng dụng.

## 4. Đồng bộ, độ mới và lưu trữ

| Mã | Hạng mục | Cách triển khai | Ràng buộc |
|---|---|---|---|
| S01 | Poll | `MonitoringPage` gọi API, chờ hoàn tất rồi đặt `setTimeout` 5 giây | Không có hai poll đồng thời trong cùng vòng đời effect; thời gian giữa hai lần bắt đầu còn phụ thuộc thời gian API |
| S02 | Lỗi kết nối | Tăng số thất bại, delay `min(30s, 5s × 2^failures)` | Giữ snapshot cũ và hiện lỗi; thành công reset backoff |
| S03 | Mất quyền | Gặp 401/403 dừng vòng poll | Không tiếp tục tự gọi cùng vòng effect khi bị từ chối |
| S04 | Vòng đời trang | `AbortController` và xóa timer khi unmount/token/cursor đổi | Tab ẩn không phát poll mới; không tự hủy request đã bắt đầu chỉ vì tab vừa ẩn |
| S05 | Màu độ mới | `Freshness`: xám chưa có mẫu, xanh ≤10s, vàng >10 đến 20s, đỏ >20s | Đây là tuổi cập nhật, không phải RTT hoặc kết luận server lỗi |
| S06 | Tuổi dashboard | Dùng `performance.now()` từ lần nhận snapshot thành công; tick mỗi giây | Không phụ thuộc đồng hồ lịch client để tính thời gian đã trôi |
| S07 | Tuổi báo cáo file | `server generatedAt − event.At + elapsed client` | Poll mới không làm mới timestamp báo cáo file; chỉ hiện tuổi ở phiên active; hiện tại dùng báo cáo client gần nhất chung của phiên, chưa có hai đồng hồ A/B riêng |
| S08 | Lưu theo lô | `MonitoringArchiveWorker.ExecuteAsync` gọi `Save` mỗi 30 giây | Không ghi SQL theo từng heartbeat hoặc chunk |
| S09 | Ghi snapshot | Export dưới khóa; serialize/ghi ngoài khóa; ghi `snapshot.tmp` rồi thay `snapshot.json` | Tránh giữ khóa bộ nhớ trong thời gian I/O; không phải cam kết lưu từng sự kiện ngay lập tức |
| S10 | Khôi phục | `StartAsync` đọc file ≤16 MiB, deserialize; `Restore` giới hạn số lượng, loại mẫu quá tuổi/timestamp tương lai | Chỉ khôi phục mẫu và sự kiện; không khôi phục connection, inflight hoặc bộ đếm droppedSamples |
| S11 | Dừng/lỗi lưu | `StopAsync` thử lưu; lỗi lưu/đọc ghi warning | Dừng đột ngột có thể mất phần chưa lưu; tài khoản chạy backend cần quyền ghi thư mục |

## 5. Quyền truy cập và bảo vệ tài nguyên

| Nội dung | Cơ chế đã có | Giới hạn cần hiểu |
|---|---|---|
| Quyền đọc dashboard | Controller áp dụng policy `Admin` ở backend | Ẩn trang ở frontend không được coi là cơ chế bảo mật chính |
| Rate limit API giám sát | Policy `monitoring` trong `AuthSetup.cs`: 30 request/phút/IP, không queue | Nhiều Admin chung IP chia sẻ hạn mức; không thay thế hạn mức API nghiệp vụ |
| Báo cáo giả từ tab khác | Đối chiếu user và connection với cặp endpoint active | Tiến độ hợp lệ về cấu trúc vẫn là dữ liệu client tự báo |
| Bộ nhớ | Queue request/sự kiện có cap và retention; response có phân trang | Registry connection phản ánh số kết nối sống, không có cap 500 trong bộ nhớ; 500 là giới hạn response |
| Dữ liệu nhạy cảm | Không lưu JWT, mật khẩu, nội dung chat/file, SDP vào journal | Thông tin định danh user/connection vẫn là dữ liệu chỉ Admin được đọc |
| Đồng thời | Lock ngắn trong kho giám sát, `Interlocked` cho inflight; semaphore dịch vụ file | Snapshot tổng hợp dưới lock; chưa kiểm thử tải lớn để định lượng chi phí |
| Tính độc lập nghiệp vụ | SQL quyết định trạng thái phiên; telemetry stale không chuyển trạng thái | Dashboard không tự chặn user, không tự kết luận mất file |

## 6. Luồng xử lý đầu cuối

| Luồng | Thứ tự các bước |
|---|---|
| HTTP | Request API → middleware bọc stream và bắt đầu đo → auth/rate limit/controller/service → response hoặc exception → phục hồi stream, ghi Sample → snapshot → bảng/biểu đồ Admin |
| SignalR | Client invoke → MonitoringService filter → filter xác thực/Hub/service → result hoặc exception → ghi thời gian/kết quả/ước tính byte → snapshot → Admin |
| Kết nối | Kết nối Hub thành công → thêm Link → invocation/heartbeat cập nhật Link → ngắt kết nối → xóa Link |
| Tiến độ file | DataChannel mở/byte tăng/bắt đầu xác minh → observe → ReportFileObservation → kiểm tra tần suất → ChatHub → ReportAsync kiểm tra endpoint/giai đoạn/byte → FileEvent → API Admin → tiến độ/timeline |
| Trạng thái file | Nghiệp vụ file cập nhật metadata → PublishAsync ghi sự kiện backend → SQL + journal được đọc ở poll tiếp theo → Admin thấy trạng thái |
| Lưu trữ | Queue mẫu/sự kiện → Export → ghi snapshot mỗi 30 giây → restart → Restore mẫu còn hợp lệ → tiếp tục thu mới |

## 7. Danh sách file đã thêm hoặc sửa

| File | Loại thay đổi | Nội dung |
|---|---|---|
| `PBL4/Services/MonitoringService.cs` | Thêm | Bộ đệm, tổng hợp, Hub filter, registry kết nối, xuất/khôi phục |
| `PBL4/Services/MeasuredStream.cs` | Thêm | Stream đếm byte |
| `PBL4/Services/MonitoringArchiveWorker.cs` | Thêm | Lưu/đọc snapshot theo lô |
| `PBL4/Controllers/MonitoringController.cs` | Thêm | API Admin, truy vấn phân trang |
| `PBL4/Program.cs` | Sửa | Đăng ký DI/worker/filter và HTTP middleware |
| `PBL4/Auth/AuthSetup.cs` | Sửa | Rate policy monitoring |
| `PBL4/Contracts/FileDtos.cs` | Sửa | DTO quan sát và FailureCode tùy chọn |
| `PBL4/Realtime/ChatHub.cs` | Sửa | Method ReportFileObservation |
| `PBL4/Services/FileTransferService.cs` | Sửa | Validate báo cáo, nhật ký giai đoạn/nguyên nhân |
| `frontend/src/services/fileTransfers.js` | Sửa | Gửi telemetry giới hạn, ánh xạ mã lỗi, dọn trạng thái |
| `frontend/src/pages/MonitoringPage.jsx` | Thêm | Dashboard bốn nhóm, polling và freshness |
| `frontend/src/styles/monitoring.css` | Thêm | Bố cục responsive, bảng/biểu đồ/màu |
| `frontend/src/App.jsx` | Sửa | Gắn trang vào nhánh Admin |
| `.gitignore` | Sửa | Loại snapshot và thư mục build thử khỏi Git |
| `tests/monitoring/MonitoringChecks.csproj`, `Program.cs` | Thêm | Kiểm thử backend dạng executable |
| `tests/monitoring-ui.e2e.mjs` | Thêm | Kiểm thử trình duyệt với API giả lập |
| `docs/admin-monitoring.md` | Thêm | Hướng dẫn vận hành và phạm vi |
| `docs/dac-ta-trien-khai-giam-sat-admin.md` | Thêm | Đặc tả triển khai này |

## 8. Kiểm thử và mức độ xác nhận

| Hạng mục | Đã thực hiện ở đợt triển khai | Điều chưa được chứng minh bởi kiểm thử đó |
|---|---|---|
| Backend | Build; chạy MonitoringChecks: phân nhóm, byte, p95, hủy/lỗi, cap queue, stream không mất dữ liệu, archive, inflight và khai báo policy | Chưa thay thế test tích hợp đăng nhập Admin/User với SQL thật |
| Frontend | `npm run lint`, `npm run build` thành công | Không thay thế kiểm thử mọi trình duyệt/mạng |
| Dashboard browser | API giả lập: đủ bốn nhóm, tìm user, timeline, màu xanh/vàng/đỏ, dừng poll khi 403, viewport nhỏ, không lỗi trang | Không xác nhận API production hoặc luồng SQL/SignalR thật |
| Hồi quy file/chat | Các bộ `file-protocol`, `file-transfer-state`, `chat-file-state`, `frontend-chat-state` đã qua | Chưa xác nhận truyền file thực tế giữa hai máy sau thay đổi |
| Kiểm tra diff | `git diff --check` đã qua ở đợt triển khai | Không phải kiểm thử nghiệp vụ |

Backend còn cảnh báo NuGet đã có về `System.Security.Cryptography.Pkcs 9.0.11`; đợt giám sát này không nâng dependency đó.

## 9. Cách vận hành và giới hạn còn lại

1. Khởi động lại backend để nạp middleware, Hub filter và worker mới.
2. Chạy frontend, đăng nhập tài khoản Admin hiện có, mở **Quản trị** (`#admin`). Không cần migration SQL cho đợt thay đổi này.
3. Dùng tài khoản thường để tạo hoạt động chat/truyền file, quan sát dashboard ở tài khoản Admin.
4. Kiểm tra thực tế riêng quyền Admin/User, phiên file hai máy và khả năng ghi snapshot trước khi dùng làm số liệu báo cáo chính thức.

| Chưa triển khai / giới hạn | Hệ quả |
|---|---|
| Đo RTT mạng, WebRTC getStats, lưu lượng card mạng | Chỉ có thời gian xử lý backend và phạm vi byte đã mô tả |
| Tổng hợp nhiều backend instance | Mỗi instance có registry, số liệu và archive riêng |
| Lịch sử dài hạn / cơ sở dữ liệu time-series | Retention ngắn, không dùng cho báo cáo tháng/năm |
| Tìm user toàn hệ thống từ ô tìm kiếm | Hiện chỉ lọc trang đang xem |
| Telemetry đầy đủ tuyệt đối | Có thể thiếu do throttle, ngắt kết nối, hết retention, cap hoặc dừng trước snapshot |
| Cảnh báo tự động hoặc chống tấn công toàn hệ thống | Màu cảnh báo chỉ phục vụ quan sát; chưa có cảnh báo đẩy/chặn tự động |
| Kiểm thử tải, tích hợp SQL và hai máy LAN | Cần thực hiện trên môi trường chạy thật; không suy ra đã đạt từ test giả lập |


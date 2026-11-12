# Đề xuất chi tiết chức năng quản trị Admin cho PBL4

Ngày lập: **02/11/2026**\
Bản code đối chiếu: **`e46f8d7` — Update UI**\
Trạng thái tài liệu: **Đề xuất chức năng và hướng triển khai; chưa phải chức năng đã hoàn thành.**

## 1. Mục đích và cơ sở đánh giá

Tài liệu đề xuất phần Admin dựa trên mã nguồn ứng dụng: backend ASP.NET Core, frontend React, các luồng SignalR/WebRTC, mô hình dữ liệu, SQL, migration và cấu hình triển khai. Không lấy nội dung các file Markdown hiện có làm yêu cầu, không coi giao diện Admin mẫu là phạm vi bắt buộc.

Những nhận định “đã có” trong tài liệu có nghĩa là đã tìm thấy mã hoặc cấu trúc dữ liệu tương ứng. Chưa thực hiện triển khai Admin, chạy lại kiểm thử hay xác nhận tình trạng máy chủ đang chạy trong lượt lập tài liệu này.

Định hướng đề xuất: **Admin quản lý tài khoản, phiên truy cập và hoạt động trao đổi dữ liệu; có khả năng theo dõi tình trạng hệ thống và truy vết thao tác quản trị.**

Các quy tắc và API ghi là “đề xuất” bên dưới là phần cần xây dựng. Chúng không được trình bày như hành vi hiện đã tồn tại trong ứng dụng.

## 2. Phạm vi tổng thể

### 2.1. Sáu nhóm chức năng

| Nhóm | Mục đích | Chức năng chính |
| --- | --- | --- |
| Tổng quan hoạt động | Nắm tình hình sử dụng | Tài khoản, online, tin nhắn, phiên truyền file, thống kê theo thời gian |
| Quản lý tài khoản | Tra cứu và xử lý tài khoản | Danh sách, tìm/lọc, chi tiết, khóa/mở khóa có lý do |
| Phiên và kết nối realtime | Phân biệt đăng nhập, kết nối và online | Thông tin phiên, số kết nối, thu hồi phiên, buộc đăng xuất |
| Giám sát truyền file | Theo dõi vòng đời truyền dữ liệu | Danh sách phiên, trạng thái, thời gian, kích thước, kết quả xác nhận |
| Giám sát hệ thống | Nhận biết sự cố vận hành | Backend, SQL, các bộ quản lý phiên, giới hạn cấu hình hiện tại |
| Nhật ký quản trị | Truy vết quyết định quản trị | Người thực hiện, đối tượng, thao tác, lý do, thời gian và kết quả |

### 2.2. Bố trí thành năm tab

| Tab | Nội dung |
| --- | --- |
| **Tổng quan** | Các chỉ số chính, biểu đồ theo ngày, tóm tắt tình trạng hệ thống |
| **Tài khoản** | Danh sách và chi tiết; khóa/mở khóa; thông tin phiên và buộc đăng xuất |
| **Truyền file** | Danh sách phiên truyền và chi tiết kỹ thuật cần thiết |
| **Vận hành** | Kết nối realtime, phiên text/file trong RAM, sức khỏe backend/SQL, giới hạn vận hành |
| **Nhật ký** | Tra cứu thao tác quản trị |

Thông tin phiên của từng người đặt trong chi tiết tài khoản. Số liệu kết nối toàn hệ thống đặt ở tab Vận hành, tránh tạo thêm một tab có nội dung trùng nhau.

## 3. Nền tảng hiện có trong code

Các mã nguồn C01–C27 trong bảng sau được liên kết tại mục 14.

| Thành phần | Đã có trong code | Còn thiếu để phục vụ Admin | Nguồn |
| --- | --- | --- | --- |
| Phân quyền | Vai trò User/Admin; policy Admin; đọc lại vai trò từ DB khi xác thực HTTP | API quản trị áp dụng policy và kiểm tra nghiệp vụ | C01, C02 |
| Tài khoản | Username, tên hiển thị, vai trò, IsDisabled, ngày tạo, LastSeenAt, RowVersion | Danh sách quản trị, chi tiết, khóa/mở khóa thật | C03, C04 |
| Phiên đăng nhập | JWT 30 phút; registry trong RAM; thu hồi từng sid | Liệt kê phiên, tra theo user, thu hồi toàn bộ, dữ liệu thời điểm cấp phục vụ UI | C05, C06, C07 |
| Presence | Heartbeat, nhiều kết nối trên một user, timeout và thông báo online/offline | Snapshot tổng hợp, số lượng phục vụ Admin, phối hợp thu hồi toàn bộ phiên | C08, C09, C10 |
| Tin nhắn | Lưu SQL, xác nhận đã nhận/đã đọc, tải bù, kiểm tra thành viên | API thống kê tổng hợp cho quản trị | C11, C12, C13 |
| Text P2P | Chọn hai tab, báo hiệu, ready, timeout, đóng và dọn phiên | Snapshot quản trị; dữ liệu lịch sử đường truyền nếu muốn thống kê | C14, C15 |
| Truyền file | Metadata, trạng thái, giới hạn, hash, timeout, dọn phiên | Danh sách Admin toàn hệ thống; nguyên nhân lỗi có cấu trúc; dữ liệu tiến độ tập trung | C16, C17, C18 |
| Sức khỏe dịch vụ | Health live và ready; kiểm tra kết nối SQL | Màn hình vận hành và API tổng hợp cho Admin | C19, C20 |
| Nhật ký | Entity, bảng, ràng buộc và mã yêu cầu chống trùng | API ghi/đọc nghiệp vụ; mở rộng nếu có thao tác ngoài khóa/mở khóa | C21, C22, C23 |
| Giao diện Admin | Trang mẫu dùng mockData | Nối trang thật vào App, API client, trạng thái tải/lỗi và thao tác xác nhận | C24, C25 |

**Lưu ý:** API tìm người dùng hiện tại phục vụ tìm người để trò chuyện/thêm liên hệ. API này loại chính mình, loại tài khoản bị khóa và chỉ trả tối đa 20 kết quả. Không dùng nguyên API đó làm danh sách quản trị.

## 4. Các khái niệm phải thống nhất trên giao diện

| Khái niệm | Ý nghĩa khi triển khai |
| --- | --- |
| Tài khoản được phép hoạt động | Tài khoản có IsDisabled = false; không đồng nghĩa đang online |
| Tài khoản bị khóa | IsDisabled = true; bị từ chối sử dụng các luồng cần xác thực |
| Phiên đăng nhập | Một phiên đã được cấp JWT/sid và còn hợp lệ theo registry cùng thời hạn token |
| Kết nối realtime | Một kết nối SignalR được theo dõi; một tài khoản có thể có nhiều kết nối |
| Người online | Một tài khoản có heartbeat còn hiệu lực và phiên tương ứng còn hợp lệ |
| Phiên text P2P | Phiên báo hiệu/điều phối giữa hai tab; server có thể biết ready nhưng chưa chắc biết đường ICE đang chọn |
| Phiên truyền file | Một bản ghi và vòng đời truyền file; không phải một file được lưu trên server |
| Tin chưa xác nhận nhận | Tin có DeliveredAt = null; người nhận offline cũng có thể tạo trạng thái này |

Ví dụ: một người có hai phiên đăng nhập, ba kết nối ứng dụng và ít nhất một heartbeat hợp lệ thì số người online tính là **một**. Không cộng số tab vào số người online.

Trong code hiện tại, LastSeenAt được cập nhật khi hệ thống công bố offline. Trường này không phải lịch sử đăng nhập hoặc thời điểm thao tác cuối cùng của người dùng. Không đổi nhãn thành “Đăng nhập lần cuối”.

## 5. Chức năng chi tiết

### 5.1. Tổng quan hoạt động

#### 5.1.1. Các chỉ số nên có

| Chỉ số | Cách hiểu và nguồn dữ liệu |
| --- | --- |
| Tổng tài khoản | Đếm tài khoản, gồm cả User và Admin; có thể tách thêm theo vai trò |
| Được phép hoạt động / bị khóa | Tách theo IsDisabled |
| Người online | Đếm tài khoản phân biệt, còn được phép hoạt động và có presence hợp lệ |
| Tài khoản mới | CreatedAt nằm trong khoảng thời gian được chọn |
| Tin nhắn đã lưu | Đếm bản ghi Messages; không đếm số lần retry/fallback thành tin mới |
| Tin chưa xác nhận nhận | DeliveredAt còn null; hiển thị như số liệu theo dõi, không tự kết luận sự cố |
| Phiên truyền file | Đếm theo trạng thái hoặc thời gian; ghi rõ cách chọn khoảng thời gian |
| Dung lượng file hoàn tất | Tổng kích thước metadata của các phiên completed; không gọi là băng thông server |

Biểu đồ ban đầu có thể gồm tài khoản mới theo ngày, tin nhắn được lưu theo ngày và kết quả phiên truyền file.

#### 5.1.2. Quy tắc thời gian và thống kê

- Mặc định xem 7 ngày; có lựa chọn hôm nay, 30 ngày và khoảng ngày tùy chọn.
- Lưu và trao đổi timestamp UTC; ranh giới ngày trên biểu đồ mặc định theo Asia/Ho_Chi_Minh.
- Số tài khoản mới và tin nhắn mới dựa trên CreatedAt.
- Phân bố trạng thái file theo lứa phiên được tạo trong khoảng chọn dựa trên CreatedAt.
- Số file hoàn tất trong khoảng chọn dựa trên FinishedAt. Không lấy hai tập thời gian khác nhau chia cho nhau rồi gọi là tỷ lệ thành công.
- Nếu hiển thị tỷ lệ hoàn tất, phải ghi rõ mẫu số, chẳng hạn số phiên đã có kết quả trong cùng một tập phiên. Tách rejected, cancelled và expired khỏi nhóm lỗi kỹ thuật.
- Chưa dùng LastSeenAt để suy ra số người sử dụng trong 7/30 ngày, vì chưa có lịch sử hoạt động đủ cho phép tính đó.

#### 5.1.3. Hiển thị và nghiệm thu

- Có thời điểm cập nhật gần nhất; có nút làm mới.
- Đề xuất cập nhật tự động khoảng 15 giây khi tab đang hiển thị, tránh truy vấn đếm toàn bộ DB mỗi giây.
- Lỗi tải dữ liệu phải hiển thị lỗi hoặc số liệu cũ kèm nhãn chưa cập nhật; không thay bằng số 0.
- Một tin gửi lại cùng mã chống trùng không làm tăng số tin đã lưu.
- Mở thêm tab của cùng một tài khoản không làm tăng số người online.

### 5.2. Quản lý tài khoản

#### 5.2.1. Danh sách và chi tiết

Danh sách nên có mã tài khoản, username, tên hiển thị, vai trò, trạng thái khóa, online/offline và ngày tạo. Sử dụng hình đại diện mặc định nếu chưa có luồng ảnh thật; không coi trường AvatarPath là bằng chứng đã có chức năng tải ảnh.

Chức năng tra cứu:

- Tìm theo username hoặc tên hiển thị; chuẩn hóa khoảng trắng đầu/cuối.
- Lọc vai trò User/Admin, được phép hoạt động/bị khóa, online/offline.
- Phân trang; đề xuất 25 dòng mặc định và tối đa 100 dòng mỗi trang.
- Sắp xếp theo ngày tạo hoặc username; có khóa phụ ổn định để tránh trùng/bỏ dòng.
- Chi tiết hiển thị thông tin cơ bản, số liệu phiên hiện tại và lịch sử quản trị liên quan.

Nếu lọc online, backend cần áp dụng tập user online vào truy vấn trước khi phân trang. Không lấy một trang SQL rồi lọc online riêng trang đó, vì có thể trả thiếu kết quả và tính sai tổng số.

Không trả PasswordHash, JWT, khóa ký, thông tin kết nối SQL hoặc thông tin xác thực TURN trong DTO tài khoản.

#### 5.2.2. Khóa và mở khóa

Quy tắc đề xuất cho bản đầu:

- Chỉ xử lý tài khoản có vai trò User.
- Không cho Admin tự khóa mình hoặc khóa Admin khác trong giao diện này.
- Bắt buộc nhập lý do cho cả khóa và mở khóa, tối đa 500 ký tự; từ chối lý do rỗng/toàn khoảng trắng.
- Hiển thị username và thao tác sắp thực hiện trước khi xác nhận.
- Giữ hồ sơ, lịch sử trò chuyện, danh bạ và metadata liên quan khi khóa.
- Mở khóa cho phép đăng nhập mới; không phục hồi những phiên đã bị thu hồi.
- Chưa có khóa hẹn giờ ở bản đầu: model hiện chỉ có cờ IsDisabled.

Luồng đề xuất:

1. Client nhận trạng thái tài khoản và RowVersion hiện tại.
2. Admin chọn thao tác, nhập lý do; client tạo một RequestId cho lần xác nhận này.
3. Backend kiểm tra quyền, đối tượng, trạng thái và phiên bản dữ liệu.
4. Cập nhật IsDisabled và thêm audit trong cùng giao dịch SQL.
5. Sau khi commit, phối hợp thu hồi phiên và dọn trạng thái runtime nếu là thao tác khóa.
6. Client tải lại trạng thái tài khoản, số liệu liên quan và nhật ký.

Hai phần SQL và runtime phải phân biệt rõ: SQL transaction không tự hoàn tác các thao tác trong RAM hoặc thông báo SignalR. Nếu bước dọn runtime lỗi, không báo rằng SQL đã rollback; cần ghi nhận lỗi và có cơ chế thử lại/khôi phục phù hợp. Tài khoản đã khóa vẫn phải bị chặn ở các yêu cầu tiếp theo.

#### 5.2.3. Tác động của thao tác khóa

- Chặn đăng nhập mới và yêu cầu HTTP/Hub mới không còn hợp lệ.
- Thu hồi mọi phiên cũ, kể cả phiên chưa mở SignalR.
- Cập nhật presence và thông báo cho các bên đang theo dõi trạng thái.
- Đóng phiên text và kết thúc phiên file liên quan theo quy tắc của từng service.
- Thông báo cho client bị khóa để thoát phiên, dọn peer và hiện lý do trạng thái tài khoản nếu chính sách hiển thị cho phép.
- Làm mới thông tin peer ở phía người còn lại; không chỉ đổi màu nút trong trang Admin.

Code đã có bộ quét text/file phát hiện tài khoản bị khóa. Tuy nhiên, vẫn cần cơ chế phối hợp cho thao tác quản trị, không chỉ trông chờ lần quét hoặc lần người dùng gửi request tiếp theo.

Đối với WebRTC, đóng kênh trực tiếp cần sự phối hợp của client. Server có thể thu hồi quyền dùng dịch vụ và ngừng điều phối; không bảo đảm cắt ngay mọi byte P2P giữa các client không tuân thủ.

#### 5.2.4. Xung đột và gửi lại

- Cùng Admin, cùng RequestId và cùng nội dung: trả lại kết quả thao tác đã ghi nhận, không thêm audit thứ hai.
- Dùng lại RequestId cho nội dung khác: từ chối.
- RequestId mới nhưng tài khoản đã ở trạng thái được yêu cầu: báo xung đột/trạng thái hiện tại, không tạo nhật ký thay đổi giả.
- RowVersion không khớp: yêu cầu tải lại dữ liệu; giữ phần lý do Admin đang nhập.
- Không tự động gửi lại một quyết định thay đổi trạng thái với phiên bản mới mà chưa đánh giá trạng thái vừa tải.
- Bản ghi kết quả của thao tác cũ và trạng thái hiện tại của tài khoản có thể khác nhau; sau retry cần tải lại trạng thái hiện tại.

LastSeenAt cũng có thể được cập nhật và làm đổi RowVersion. Không mặc định mọi xung đột phiên bản đều do một Admin khác vừa khóa/mở khóa.

### 5.3. Phiên đăng nhập và kết nối realtime

#### 5.3.1. Thông tin cần hiển thị

Trong chi tiết tài khoản:

- Số phiên đăng nhập còn hợp lệ theo registry.
- Số kết nối SignalR được theo dõi, tách với số kết nối có heartbeat còn hiệu lực.
- Trạng thái online của tài khoản.
- Thời hạn của từng phiên; thời điểm cấp nếu bổ sung việc lưu trường này.
- Mã phiên rút gọn phục vụ phân biệt trên giao diện, không hiển thị token.

Code hiện chưa lưu tên thiết bị, User-Agent, IP hay lịch sử đăng nhập trong model/registry. Không gán một ConnectionId thành một “thiết bị” và không dựng màn hình lịch sử thiết bị từ dữ liệu chưa có.

#### 5.3.2. Buộc đăng xuất

Đề xuất một thao tác riêng: **Buộc đăng xuất mọi phiên** của tài khoản User, có lý do và xác nhận.

| Thao tác | Phiên cũ | Đăng nhập mới |
| --- | --- | --- |
| Khóa tài khoản | Thu hồi | Bị từ chối cho tới khi mở khóa |
| Buộc đăng xuất | Thu hồi | Được phép nếu tài khoản vẫn được phép hoạt động |
| Mở khóa | Không khôi phục phiên đã thu hồi | Được phép |

Buộc đăng xuất là chức năng đề xuất bổ sung, chưa có endpoint hiện tại. Cần mở rộng audit trước khi đưa thao tác này vào sử dụng.

#### 5.3.3. Yêu cầu backend

- Bổ sung khả năng tra cứu phiên theo user và tạo snapshot để thống kê.
- Có cơ chế thu hồi theo user hoặc thế hệ phiên; xử lý cả trường hợp cấp token và thu hồi xảy ra đồng thời.
- Không chỉ duyệt các kết nối SignalR, vì có phiên đăng nhập chưa kết nối Hub.
- Không để phiên cũ chưa từng gọi API trong thời gian khóa sử dụng lại được sau khi mở khóa.
- Kiểm soát token đang được cấp dở trong lúc khóa/thu hồi; tránh để phiên thoát khỏi tác động thu hồi do chạy đua.
- Snapshot chỉ tính dữ liệu còn hợp lệ, không đếm entry đã hết hạn hoặc đã bị loại khỏi cache.

Registry hiện thuộc RAM của một instance. Server khởi động lại làm mất phiên trong registry; số liệu không phải lịch sử bền vững. Nếu chuyển sang nhiều instance thì cần thiết kế lại việc chia sẻ phiên/presence, không cộng các bộ đếm RAM một cách tùy ý.

### 5.4. Giám sát truyền file

#### 5.4.1. Danh sách quản trị

Bản đầu đề xuất là màn hình chỉ đọc, sử dụng API Admin riêng. Các API file của người dùng hiện vẫn giữ điều kiện thành viên cuộc trò chuyện.

| Trường | Mục đích |
| --- | --- |
| Mã phiên truyền | Tra cứu đúng một lần truyền |
| Tài khoản gửi và nhận | Xác định các tài khoản liên quan khi hỗ trợ |
| Kích thước khai báo | Biết quy mô dữ liệu của phiên |
| Trạng thái | Theo dõi vòng đời và kết quả |
| CreatedAt | Thời điểm tạo lời mời |
| AcceptedAt | Thời điểm nhận lời; chưa đồng nghĩa đã bắt đầu truyền byte |
| FinishedAt | Thời điểm ghi nhận kết quả cuối |
| Kết quả xác nhận hash | Biết server đã ghi nhận xác nhận hợp lệ hay chưa |
| Tình trạng runtime | Có còn entry trong bộ quản lý phiên của instance không, tại thời điểm snapshot |

Ưu tiên metadata kỹ thuật; không cung cấp nội dung file hoặc đường tải xuống cho Admin. Tên file không cần xuất hiện trong bảng giám sát tổng quát ở bản đầu.

#### 5.4.2. Ý nghĩa trạng thái

| Trạng thái code | Nhãn đề xuất | Diễn giải |
| --- | --- | --- |
| offered | Chờ người nhận | Lời mời đã tạo, chưa được chấp nhận |
| accepted | Đang thiết lập kết nối | Đã nhận lời, đang thương lượng kết nối |
| transferring | Đang truyền / chờ xác nhận | Server đã cho phép chuyển sang truyền; chưa phải xác nhận đã nhận đủ |
| completed | Đã hoàn tất | Server chấp nhận số byte/hash do client nhận xác nhận |
| rejected | Đã từ chối | Quyết định của người nhận |
| cancelled | Đã hủy | Một bên kết thúc phiên bằng thao tác hủy |
| expired | Lời mời hết hạn | Lời mời không được hoàn tất trong thời hạn phù hợp |
| failed | Thất bại | Lỗi hoặc phiên không còn đáp ứng điều kiện chạy |

Hash ở trạng thái completed được server đối chiếu với thông tin đã lưu. Server không giữ nội dung file để tự băm lại toàn bộ byte nhận được.

#### 5.4.3. Bộ lọc và thống kê

- Tìm theo mã phiên hoặc tài khoản liên quan.
- Lọc trạng thái và khoảng thời gian; phân trang.
- Cho xem riêng các phiên chưa có FinishedAt hoặc đang ở nhóm trạng thái chờ/chạy.
- Tách các kết quả người dùng chủ động từ chối/hủy khỏi lỗi kỹ thuật.
- Không tự gọi một phiên là “kẹt” chỉ vì tạo đã lâu; cần xét trạng thái và deadline tương ứng.
- Không tính FinishedAt trừ AcceptedAt thành thời gian truyền thuần túy: khoảng này còn có thể gồm thiết lập kết nối. Muốn đo chính xác hơn cần mốc bắt đầu truyền.

#### 5.4.4. Dữ liệu cần bổ sung nếu muốn chẩn đoán sâu

| Nhu cầu | Code hiện tại | Phần cần thêm |
| --- | --- | --- |
| Xem lý do failed | Client giữ lỗi cục bộ; SQL chủ yếu lưu Status | Mã nguyên nhân, nguồn kết thúc và quy tắc ghi nhận từ server/client |
| Xem tiến độ/tốc độ toàn hệ thống | Chỉ có trong tab đang truyền | Luồng gửi số liệu định kỳ có giới hạn, snapshot và thời điểm cập nhật |
| Thống kê đường trực tiếp/TURN | Chưa có telemetry tập trung; text phân loại tại browser | Thu thập route có thời gian và nguồn báo cáo; không suy diễn từ ready |
| Xem lịch sử chất lượng kết nối | Chưa có kho dữ liệu tương ứng | Thiết kế thời hạn lưu và tập chỉ số cần thu thập |

Số liệu client báo cáo là dữ liệu chẩn đoán, không thay quyền quyết định trạng thái của server. Chưa nên thêm nút Admin “đánh dấu hoàn tất”, tải lại file từ server hoặc tiếp tục truyền từ byte bị ngắt.

### 5.5. Giám sát hệ thống

#### 5.5.1. Nội dung bản đầu

- Backend có phản hồi hay không; SQL có kết nối được hay không.
- Số tài khoản online, số kết nối và số phiên đăng nhập theo các định nghĩa riêng.
- Số phiên text/file còn được bộ quản lý runtime theo dõi; trạng thái ready của text nếu có trong snapshot.
- Các giới hạn vận hành đang có hiệu lực và thời điểm lấy số liệu.
- Nút làm mới; cập nhật định kỳ khi tab được hiển thị.

Health live chỉ phản ánh tiến trình HTTP có phản hồi. Health ready hiện kiểm tra khả năng kết nối SQL; không chứng minh toàn bộ chức năng WebRTC hoặc mạng của người dùng đều hoạt động bình thường.

API vận hành nên lấy thông tin health từ service nội bộ. Không mặc định reverse proxy đã mở đường /health cho frontend và không công khai chuỗi kết nối hoặc lỗi SQL chi tiết.

Nếu SQL không khả dụng, việc xác thực HTTP hiện cũng có thể thất bại do cần đọc user từ SQL. UI phải biểu diễn “không lấy được dữ liệu” thay vì hứa luôn trả được đầy đủ một dashboard khi DB lỗi.

#### 5.5.2. Giới hạn đọc được từ code tại thời điểm rà soát

| Thành phần | Giá trị trong code | Ghi chú |
| --- | --- | --- |
| Kích thước file tối đa | 100 MiB | Có giới hạn ở cả backend và frontend |
| Phiên file đồng thời mỗi tài khoản | 2 | Bao gồm phiên đang chờ hoặc đang chạy |
| Ngưỡng phiên file trong bộ quản lý | 1.000 | Theo instance, không phải dung lượng lưu trữ file |
| Ngưỡng phiên text mỗi tài khoản | 8 | Theo bộ quản lý phiên text |
| Ngưỡng phiên text trong bộ quản lý | 1.000 | Theo instance |
| Heartbeat mặc định | Gửi 15 giây, timeout 60 giây, quét 2 giây | Có thể được cấu hình ghi đè; UI phải phản ánh giá trị runtime |
| Thời hạn JWT | 30 phút | Chưa có refresh token trong luồng hiện tại |

Các giá trị trên không phải kết quả đo sức chịu tải. Ngưỡng viết trong code không chứng minh máy chủ xử lý ổn định được số người tương ứng.

#### 5.5.3. Phần để sau

CPU/RAM máy chủ, độ trễ Hub, tỷ lệ reconnect, chất lượng TURN và bảng lỗi có cấu trúc đều cần đường lấy số liệu riêng. Không dùng trạng thái kết nối của riêng tab Admin làm kết luận cho mọi người dùng.

Bản đầu chỉ xem cấu hình. Muốn cho Admin chỉnh giới hạn file, heartbeat hoặc số phiên thì phải thống nhất nguồn cấu hình, kiểm tra giá trị và đồng bộ frontend/backend trước.

### 5.6. Nhật ký quản trị

#### 5.6.1. Nội dung và tra cứu

- Người thực hiện, tài khoản bị tác động, loại thao tác và lý do.
- Thời điểm thực hiện; trạng thái trước/sau nếu là thay đổi khóa.
- Mã yêu cầu để đối chiếu thao tác gửi lại.
- Tìm theo username, lọc người thực hiện/đối tượng/thao tác/khoảng ngày.
- Phân trang; sắp xếp thời gian giảm dần và mã bản ghi làm khóa phụ.
- Chỉ xem trên UI; không cung cấp chức năng sửa/xóa nhật ký.

Không lưu mật khẩu, token, nội dung chat hoặc thông tin xác thực hạ tầng trong lý do/nhật ký.

#### 5.6.2. Giới hạn của bảng hiện tại

AdminAuditLogs hiện mô tả hai thao tác DisableUser và EnableUser, với cặp OldIsDisabled/NewIsDisabled bắt buộc đổi đúng chiều. Bảng chưa phải nhật ký chung cho mọi loại quản trị.

Nếu thêm RevokeUserSessions, cần migration và DTO/model hỗ trợ một loại thao tác không thay đổi IsDisabled. Không dùng lý do giả hoặc dựng một lần khóa/mở khóa để ghi thay thao tác buộc đăng xuất.

Đề xuất mở rộng có chủ đích cho thao tác mới, giữ dữ liệu khóa/mở khóa cũ. Nếu cho phép giá trị trước/sau rỗng đối với thao tác mới thì ràng buộc phải vẫn bắt buộc đủ giá trị cho khóa/mở khóa; tránh SQL CHECK chấp nhận trường hợp NULL ngoài ý muốn.

Lỗi đăng nhập, lỗi mạng và yêu cầu bị từ chối là sự kiện kỹ thuật/an ninh riêng. Không giả lập chúng thành một thay đổi tài khoản đã thành công trong bảng audit hiện tại.

#### 5.6.3. Bảo vệ nhật ký

Script schema SQL có trigger chặn UPDATE/DELETE audit. Migration EF khởi tạo hiện chưa tạo trigger này. Tài liệu không khẳng định database thực tế đã được khởi tạo theo cách nào.

Cần thống nhất schema/migration và kiểm tra quyền SQL của tài khoản chạy ứng dụng. Script triển khai hiện chỉ cấp SELECT/INSERT trên audit cho tài khoản ứng dụng. Bảo vệ này không đồng nghĩa SQL sysadmin không thể thay đổi dữ liệu.

## 6. Quyền truy cập và ranh giới chức năng

| Chủ thể | Phạm vi đề xuất |
| --- | --- |
| Chưa đăng nhập | Không gọi được API Admin |
| User | Dùng chức năng cá nhân; không gọi được API Admin dù tự mở URL/request |
| Admin còn hiệu lực | Xem số liệu quản trị và thực hiện các thao tác được mô tả trong tài liệu |
| Tài khoản bị khóa/phiên bị thu hồi | Không tiếp tục dùng quyền quản trị hoặc các luồng cần phiên hợp lệ |

Mọi endpoint Admin cần áp dụng policy Admin. Người thực hiện lấy từ danh tính xác thực và vai trò hiện tại; không lấy AdminUserId do client tự khai báo làm căn cứ cấp quyền.

Các API chat/file hiện kiểm tra thành viên cuộc trò chuyện. Đề xuất giữ quy tắc đó. API thống kê/giám sát Admin mới trả số liệu hoặc metadata cần thiết qua quyền quản trị riêng, không bỏ điều kiện thành viên khỏi API cá nhân.

Trong phạm vi bản đầu, Admin không có chức năng mở toàn bộ nội dung chat, tải file riêng, sửa danh bạ hoặc đổi tên gợi nhớ của người dùng khác. Model có nội dung text lưu trong SQL; điều đó không đồng nghĩa nên đưa quyền đọc toàn bộ nội dung lên giao diện Admin.

## 7. Các thay đổi dữ liệu và backend cần chuẩn bị

| Hạng mục | Bản đầu | Khi mở rộng |
| --- | --- | --- |
| Users | Dùng IsDisabled, Role, RowVersion hiện có | Cân nhắc thế hệ phiên hoặc dữ liệu bổ sung nếu cơ chế thu hồi cần |
| AdminAuditLogs | Dùng cho khóa/mở khóa; thống nhất bảo vệ ở SQL/migration | Mở rộng loại thao tác cho buộc đăng xuất |
| Registry phiên | Tra theo user, snapshot và thu hồi toàn bộ | Lịch sử đăng nhập/thiết bị cần lưu riêng nếu có nhu cầu |
| Presence/text/file runtime | Bổ sung hàm lấy snapshot nhất quán và giới hạn dữ liệu trả | Chia sẻ trạng thái nếu vận hành nhiều instance |
| FileTransfers | Dùng metadata và trạng thái hiện có cho giám sát | Mã nguyên nhân kết thúc; mốc bắt đầu truyền nếu cần |
| Telemetry | Chưa cần lưu hàng loạt cho màn hình chỉ đọc cơ bản | Tiến độ, route, độ trễ cần thiết kế cách thu thập và thời hạn lưu |

Không cần tạo lại toàn bộ database để làm danh sách tài khoản, khóa/mở khóa, thống kê cơ bản và tra cứu audit. Tuy nhiên, bổ sung chức năng mới có thể cần migration cụ thể; không mặc định schema hiện tại đáp ứng mọi thao tác.

Cần đối chiếu thêm hành vi xóa giữa EF và script SQL: migration có cascade từ cuộc trò chuyện sang một số bảng con, trong khi script schema dùng các FK không khai báo cascade. Không mở chức năng xóa lịch sử/tài khoản vĩnh viễn trước khi chốt hành vi dữ liệu.

## 8. API đề xuất

**Đây là các API dự kiến tạo mới, chưa tồn tại trong code hiện tại.** Toàn bộ đặt dưới /api/v1/admin và yêu cầu policy Admin.

| Method | Endpoint | Chức năng | Đợt đề xuất |
| --- | --- | --- | --- |
| GET | /api/v1/admin/overview | Chỉ số và biểu đồ tổng hợp theo thời gian | Bản đầu |
| GET | /api/v1/admin/users | Tìm/lọc/phân trang tài khoản | Bản đầu |
| GET | /api/v1/admin/users/{userId} | Chi tiết tài khoản | Bản đầu |
| POST | /api/v1/admin/users/{userId}/disable | Khóa có lý do và mã chống trùng | Bản đầu |
| POST | /api/v1/admin/users/{userId}/enable | Mở khóa có lý do và mã chống trùng | Bản đầu |
| GET | /api/v1/admin/file-transfers | Giám sát metadata phiên truyền | Bản đầu |
| GET | /api/v1/admin/file-transfers/{transferId} | Chi tiết kỹ thuật được phép xem | Bản đầu |
| GET | /api/v1/admin/operations | Snapshot kết nối, phiên và sức khỏe dịch vụ | Bản đầu |
| GET | /api/v1/admin/audit-logs | Tra cứu nhật ký | Bản đầu |
| GET | /api/v1/admin/users/{userId}/sessions | Danh sách phiên hiện tại theo tài khoản | Sau khi có snapshot registry phù hợp |
| POST | /api/v1/admin/users/{userId}/revoke-sessions | Buộc đăng xuất mọi phiên, có lý do | Sau khi mở rộng audit |

### 8.1. Ví dụ request khóa/mở khóa

```json
{
  "requestId": "5c9e9a64-a8e9-4ba6-a92f-6d96f53da7e8",
  "expectedVersion": "AAAAAAAAB9E=",
  "reason": "Tạm khóa để xử lý vấn đề của tài khoản."
}
```

Giá trị trên là dữ liệu minh họa, không tham chiếu tài khoản hay phiên bản thực tế. userId lấy từ đường dẫn; người thực hiện lấy từ phiên xác thực.

RequestId gắn với một quyết định đã xác nhận. Nếu gửi lại do mất phản hồi thì giữ nguyên mã và nội dung; không tạo mã mới cho mỗi lần thử lại trên mạng.

### 8.2. Quy ước phản hồi đề xuất

- 400: dữ liệu đầu vào không hợp lệ hoặc mã yêu cầu bị dùng lại cho nội dung khác.
- 401: chưa đăng nhập hoặc phiên không còn hợp lệ.
- 403: không có quyền Admin hoặc thao tác nằm ngoài quyền cho phép.
- 404: đối tượng được phép tra cứu không tồn tại.
- 409: RowVersion/trạng thái đã thay đổi; trả đủ thông tin an toàn để UI tải lại.
- 503: dịch vụ không khả dụng; không đổi thành thành công trên client.

Các quy ước và mã lỗi chi tiết cần nhất quán với kiểu phản hồi ProblemDetails hiện có. ID BIGINT của phiên truyền và audit trả dưới dạng chuỗi để frontend không làm tròn.

## 9. Giao diện và trải nghiệm sử dụng

- Nối trang Admin thật trong App, thay phần đang mở EmptyWorkspacePage; bỏ phụ thuộc mockData của trang Admin.
- Có lớp gọi API quản trị riêng; tái sử dụng cơ chế token, timeout và hủy request hiện có.
- Mỗi bảng có trạng thái đang tải, không có dữ liệu, lỗi, thử lại và phân trang.
- Đổi bộ lọc phải hủy/bỏ kết quả cũ để request chậm không ghi đè kết quả mới.
- Chi tiết tài khoản có thể mở bằng panel bên cạnh; thao tác khóa/mở khóa dùng hộp xác nhận riêng.
- Giữ lý do đã nhập khi lỗi/xung đột; chặn bấm lặp trong lúc xử lý.
- Chỉ cập nhật thành công theo kết quả server; khi không rõ yêu cầu đã hoàn thành hay chưa, dùng RequestId để đối chiếu/gửi lại an toàn.
- Tách rõ trạng thái tài khoản và online; không dùng một nhãn “Hoạt động” cho cả hai.
- Hiển thị thời gian cập nhật cho các snapshot runtime; dừng hoặc giảm polling khi tab không hiển thị.
- Người bị mất quyền Admin nhận thông báo phù hợp và rời màn hình quản trị; backend vẫn phải tự chặn request.

## 10. Thứ tự triển khai đề xuất

### Đợt 1 — Tài khoản, phân quyền và thu hồi truy cập

1. Tạo DTO/API danh sách và chi tiết tài khoản, có phân trang và kiểm tra quyền.
2. Bổ sung cơ chế thu hồi toàn bộ phiên theo user, kể cả luồng cấp token đồng thời.
3. Làm khóa/mở khóa và audit trong cùng giao dịch, xử lý RequestId/RowVersion.
4. Phối hợp presence, text/file và thông báo client sau khi khóa.
5. Làm UI tài khoản và tra cứu audit thật.

Kết quả cần có: Admin xử lý được một tài khoản thật; tác động truy cập và nhật ký đúng; thao tác gửi lại không tạo kết quả trùng.

### Đợt 2 — Tổng quan và vận hành cơ bản

1. Chốt định nghĩa chỉ số và ranh giới thời gian.
2. Bổ sung snapshot runtime, API overview/operations.
3. Làm các thẻ số liệu, biểu đồ cơ bản, health và nhãn dữ liệu cũ.
4. Hiển thị các giới hạn vận hành từ nguồn thực tế.

Kết quả cần có: Admin phân biệt được tài khoản được phép hoạt động, người online, kết nối và phiên; không trình bày dữ liệu thiếu thành số 0.

### Đợt 3 — Giám sát truyền file

1. Tạo API Admin chỉ đọc cho danh sách/chi tiết kỹ thuật.
2. Làm lọc trạng thái, thời gian, tài khoản và phân trang.
3. Thể hiện riêng hủy/từ chối/hết hạn/thất bại.
4. Đối chiếu trạng thái SQL với snapshot runtime khi cần, không cho sửa kết quả truyền tùy ý.

Kết quả cần có: Admin tra được một phiên truyền cụ thể mà không tải hoặc xem nội dung file.

### Đợt 4 — Bổ sung công cụ hỗ trợ

1. Mở rộng audit và làm buộc đăng xuất độc lập với khóa.
2. Hoàn thiện danh sách phiên trong chi tiết tài khoản.
3. Bổ sung mã nguyên nhân file thất bại.
4. Chỉ thu thập tiến độ/route/độ trễ nếu còn đủ thời gian và có nhu cầu rõ.

Việc thu hồi toàn bộ phiên khi khóa là bắt buộc ở Đợt 1. Nút buộc đăng xuất độc lập có thể ra sau vì cần bổ sung loại audit tương ứng.

## 11. Tiêu chí nghiệm thu theo hành vi

Các tình huống dưới đây là yêu cầu cần kiểm tra khi triển khai; chưa được ghi nhận là đã đạt trong tài liệu này.

| Mã | Tình huống | Kết quả mong muốn |
| --- | --- | --- |
| ADM-01 | User tự gọi API Admin | Bị từ chối, không chỉ bị ẩn menu |
| ADM-02 | Phiên hết hạn/bị thu hồi tiếp tục gọi quản trị | Không được thực hiện thao tác |
| ADM-03 | Tìm một tài khoản bị khóa | Có thể tra cứu bằng danh sách Admin |
| ADM-04 | Một người mở nhiều tab | Số người online không tăng theo số tab |
| ADM-05 | Socket còn mở nhưng heartbeat quá hạn | Phân biệt được kết nối còn theo dõi và user đã offline |
| ADM-06 | Khóa khi user có nhiều phiên và một phiên chưa mở SignalR | Mọi phiên cũ mất quyền; đăng nhập mới bị chặn |
| ADM-07 | Một phiên không gọi API trong lúc bị khóa, sau đó mở khóa | Phiên cũ không tự có quyền trở lại |
| ADM-08 | Cấp token chạy đồng thời với khóa/thu hồi | Không có phiên lọt qua do chạy đua |
| ADM-09 | Khóa khi đang chat/truyền file | Chặn thao tác mới; phối hợp dọn runtime và client; dữ liệu lịch sử còn nguyên |
| ADM-10 | Mở khóa | Đăng nhập mới được; phiên đã thu hồi vẫn bị từ chối |
| ADM-11 | Hai Admin xử lý cùng phiên bản tài khoản | Không ghi đè âm thầm; yêu cầu còn lại nhận trạng thái/xung đột phù hợp |
| ADM-12 | LastSeenAt làm đổi RowVersion | UI xử lý được xung đột và không mất lý do đã nhập |
| ADM-13 | Mất phản hồi rồi gửi lại cùng RequestId/nội dung | Một thay đổi và một audit; trả lại kết quả đã ghi nhận |
| ADM-14 | Dùng lại RequestId cho quyết định khác | Bị từ chối |
| ADM-15 | Ghi audit lỗi trong lúc đổi trạng thái | Không để lại nửa giao dịch SQL |
| ADM-16 | Dọn runtime lỗi sau khi SQL đã commit | Không báo rollback giả; quyền bị khóa vẫn có hiệu lực, có đường phục hồi xử lý |
| ADM-17 | Admin thử sửa/xóa nhật ký qua API | Không có chức năng cho phép |
| ADM-18 | Khởi tạo DB bằng đường được hỗ trợ | Có cùng quy tắc bảo vệ audit cần thiết; đối chiếu migration/SQL |
| ADM-19 | File bị người nhận từ chối/hủy | Không gộp thành lỗi mạng |
| ADM-20 | Chưa có dữ liệu tiến độ hoặc route tập trung | Hiển thị chưa có dữ liệu, không dựng tốc độ/tỷ lệ giả |
| ADM-21 | API dashboard lỗi hoặc SQL không khả dụng | Có trạng thái lỗi/dữ liệu cũ; không thay các thẻ bằng số 0 |
| ADM-22 | Admin tra cứu hoạt động | Không đọc được nội dung chat/file ngoài phạm vi đã đề xuất |
| ADM-23 | Buộc đăng xuất độc lập | Có audit đúng loại; IsDisabled không bị đổi; đăng nhập mới vẫn được phép |
| ADM-24 | Phiên file đã kết thúc | Giao diện quản trị chỉ xem kết quả, không đổi thành completed hoặc hồi sinh phiên |

## 12. Những chức năng chưa đưa vào bản đầu

| Chức năng | Lý do và điều kiện bổ sung |
| --- | --- |
| Quản trị cuộc gọi | Hiện có model/bảng và trang mẫu, chưa có nghiệp vụ gọi thật để giám sát |
| Xem/sửa toàn bộ chat riêng | API hiện giới hạn thành viên; chưa có quy trình kiểm duyệt nội dung |
| Kho file và khôi phục tải xuống | Server không lưu nội dung file |
| Xóa tài khoản/lịch sử vĩnh viễn | Cần chốt quan hệ dữ liệu, hành vi cascade và tác động lịch sử |
| Cấp/thu hồi vai trò Admin trên UI | Cần chính sách phân quyền và audit phù hợp; không mở rộng chỉ bằng một dropdown |
| Đặt lại mật khẩu/khôi phục tài khoản | Chưa có luồng xác minh và hỗ trợ tương ứng |
| Khóa hẹn giờ | Chưa có dữ liệu thời hạn và cơ chế tự mở khóa |
| Lịch sử thiết bị/IP | Chưa có dữ liệu lưu tương ứng; ConnectionId không phải định danh thiết bị |
| Báo cáo vi phạm | Cần luồng gửi báo cáo, bằng chứng, xử lý và trạng thái riêng |
| Chỉnh cấu hình hạ tầng trên UI | Nguồn cấu hình/giới hạn hiện chưa được thiết kế cho thao tác quản trị động |
| Thống kê CPU/RAM/độ trễ/TURN lịch sử | Cần nguồn đo và lưu dữ liệu, không suy ra từ bảng nghiệp vụ |

## 13. Phạm vi nên hoàn thành trước

Bản đầu nên hoàn thành năm tab với chiều sâu vừa đủ: quản lý tài khoản thật, khóa/mở khóa đúng tác động, audit có thể tra cứu, tổng quan có số liệu đúng, giám sát file chỉ đọc và tình trạng vận hành cơ bản.

Ưu tiên tính đúng của quyền truy cập, thu hồi phiên và dữ liệu hiển thị trước khi bổ sung nhiều biểu đồ hoặc các nút can thiệp nâng cao. Các chức năng như buộc đăng xuất độc lập và chẩn đoán lỗi sâu được thêm theo các điều kiện dữ liệu/audit đã nêu.

## 14. Liên kết mã nguồn đã đối chiếu

Các đường dẫn sau trỏ đến workspace trên máy hiện tại. Không dùng liên kết tới tài liệu Markdown làm bằng chứng cho các nhận định trong tài liệu này.

| Mã | Mã nguồn | Nội dung liên quan |
| --- | --- | --- |
| C01 | [AuthSetup.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Auth/AuthSetup.cs:34) | Policy Admin và xác thực |
| C02 | [SessionValidationEvents.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Auth/SessionValidationEvents.cs:20) | Kiểm tra DB, tài khoản bị khóa, vai trò hiện tại |
| C03 | [User.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Models/User.cs:12) | Các trường tài khoản thực có |
| C04 | [UsersController.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Controllers/UsersController.cs:21) | Search cá nhân, đăng ký bắt buộc Role User |
| C05 | [SessionRegistry.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Auth/SessionRegistry.cs:6) | Registry trong RAM, thu hồi sid |
| C06 | [TokenService.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Auth/TokenService.cs:37) | Cấp JWT và thời hạn phiên |
| C07 | [SessionsController.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Controllers/SessionsController.cs:22) | Login, chặn khóa, đăng xuất phiên hiện tại |
| C08 | [PresenceTracker.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Realtime/PresenceTracker.cs:6) | Kết nối, heartbeat, online và session |
| C09 | [PresenceService.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Realtime/PresenceService.cs:38) | Thu hồi presence, cập nhật LastSeenAt |
| C10 | [HeartbeatOptions.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Realtime/HeartbeatOptions.cs:4) | Giá trị heartbeat mặc định |
| C11 | [MessageService.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Services/MessageService.cs:14) | Lưu và chống trùng tin nhắn |
| C12 | [PendingMessagesController.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Controllers/PendingMessagesController.cs:16) | Tin chưa xác nhận nhận và tải bù |
| C13 | [MessagesController.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Controllers/MessagesController.cs:16) | Kiểm tra thành viên khi đọc lịch sử |
| C14 | [TextPeerSessionService.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Services/TextPeerSessionService.cs:13) | Quản lý phiên text và giới hạn |
| C15 | [textChatTransport.js](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/frontend/src/services/textChatTransport.js:69) | Route đo ở trình duyệt, P2P và fallback |
| C16 | [FileTransferService.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Services/FileTransferService.cs:12) | Vòng đời file, giới hạn, dọn phiên |
| C17 | [fileTransfers.js](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/frontend/src/services/fileTransfers.js:71) | Lỗi cục bộ, tiến độ, tốc độ và tải xuống |
| C18 | [FilesController.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Controllers/FilesController.cs:14) | Metadata cá nhân và cấu hình file |
| C19 | [Program.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Program.cs:122) | Health live và ready |
| C20 | [DatabaseHealthCheck.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Health/DatabaseHealthCheck.cs:7) | Kiểm tra kết nối SQL |
| C21 | [AdminAuditLog.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Models/AdminAuditLog.cs:5) | Các trường audit hiện tại |
| C22 | [AppDBContext.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Data/AppDBContext.cs:157) | Ràng buộc audit và quan hệ EF |
| C23 | [01_schema.sql](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/database/01_schema.sql:191) | Bảng audit, ràng buộc và trigger |
| C24 | [AdminPage.jsx](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/frontend/src/pages/AdminPage.jsx:4) | Giao diện dùng mockData |
| C25 | [App.jsx](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/frontend/src/App.jsx:111) | Guard giao diện và trang chờ Admin |
| C26 | [20261013025217_KhoiTaoDB.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Migrations/20261013025217_KhoiTaoDB.cs:12) | Migration khởi tạo cần đối chiếu với SQL |
| C27 | [setup-database.sh](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/deploy/setup-database.sh:54) | Quyền SQL dành cho ứng dụng |

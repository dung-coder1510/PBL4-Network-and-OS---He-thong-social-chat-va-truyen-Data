# Mô tả chi tiết màn hình và luồng sử dụng Admin

Ngày lập: **02/11/2026**\
Bản code làm nền: **`e43c180` — Them Adtri**\
Trạng thái: **Đặc tả đề xuất; lượt này chỉ viết tài liệu, chưa triển khai hoặc sửa code ứng dụng.**

## 1. Mục tiêu và phạm vi

Phần Admin được phát triển từ màn hình giám sát và API monitoring đã có trong code của nhóm. Bổ sung chức năng xử lý tài khoản và nhật ký để Admin có thể thực hiện, theo dõi và đối chiếu một quyết định khóa/mở khóa.

Bản đầu gồm **3 tab: Tài khoản — Giám sát — Nhật ký**.

| Tab | Câu hỏi cần trả lời | Phạm vi bản đầu |
| --- | --- | --- |
| Tài khoản | Người này là ai, đang ở trạng thái nào, có cần khóa/mở khóa không? | Tìm/lọc, danh sách, chi tiết, khóa/mở khóa có lý do |
| Giám sát | Kết nối, API, SignalR và các phiên truyền file đang diễn ra thế nào? | Kế thừa phần giám sát đã có, sửa các vấn đề đã xác định |
| Nhật ký | Ai đã xử lý tài khoản nào, lúc nào và vì sao? | Tra cứu những lần khóa/mở khóa thành công |

Quy tắc nghiệp vụ đề xuất:

- Chỉ tài khoản Admin còn quyền và còn phiên hợp lệ được sử dụng phần quản trị.
- Bản đầu chỉ cho khóa/mở khóa tài khoản có vai trò User.
- Admin không tự khóa mình hoặc xử lý Admin khác bằng màn hình này.
- Khóa và mở khóa đều phải nhập lý do.
- Khóa giữ nguyên dữ liệu tài khoản và lịch sử liên quan.
- Khi khóa, mọi phiên cũ phải bị thu hồi; đăng nhập mới bị chặn.
- Khi mở khóa, người dùng đăng nhập lại; các phiên đã bị thu hồi không được phục hồi.
- Nhật ký ghi thay đổi trạng thái đã thành công; không tạo bản ghi thành công cho thao tác thất bại hoặc không làm thay đổi trạng thái.

Các quy tắc trên là thiết kế cần triển khai, không phải khẳng định code hiện tại đã đáp ứng.

### 1.1. Phần đã có và phần cần làm

| Hạng mục | Trạng thái ở bản code làm nền |
| --- | --- |
| Mục Quản trị mở màn hình MonitoringPage | Đã có |
| API /api/v1/admin/monitoring áp dụng policy Admin | Đã có |
| Xem tài khoản, kết nối, biểu đồ request, số liệu xử lý và phiên file | Đã có trong màn hình giám sát |
| Báo cáo tiến độ/giai đoạn và nguyên nhân file thất bại | Đã có đường thu thập và trình bày, có giới hạn mẫu |
| Tìm kiếm toàn bộ tài khoản để quản trị | Cần bổ sung; tìm kiếm hiện tại của monitoring chỉ lọc trang đã tải |
| Chi tiết tài khoản và nút khóa/mở khóa thật | Cần bổ sung |
| Thu hồi toàn bộ phiên theo tài khoản | Cần bổ sung |
| API ghi/đọc nhật ký khóa/mở khóa | Cần bổ sung; model và bảng audit đã có |
| Giao diện bao gồm 3 tab | Cần bổ sung |
| Lưu snapshot trên cấu hình service Linux hiện tại | Cần sửa đường lưu/quyền ghi |
| Đếm lời gọi Hub bị giới hạn tần suất | Cần sửa nhánh đang bỏ sót mẫu |

Tài liệu sử dụng mã nguồn làm cơ sở, không dùng các file Markdown có sẵn làm yêu cầu. Các liên kết mã nguồn ở mục 15.

## 2. Bố cục chung của khu vực Admin

### 2.1. Khi mở mục Quản trị

- Đi vào khu vực Admin trong ứng dụng hiện tại, giữ sidebar, topbar và cách trình bày chung.
- Lần đầu mở hiển thị tab **Tài khoản**.
- Ba tab hiển thị cùng một hàng bên dưới tiêu đề.
- Chuyển qua lại giữa các tab giữ bộ lọc và trang dữ liệu của từng tab trong lần sử dụng khu vực Admin đó.
- Sau đăng xuất, dữ liệu Admin đang giữ trong giao diện được xóa; không mang sang tài khoản đăng nhập tiếp theo.
- Chỉ tab đang hiển thị mới thực hiện polling định kỳ. Việc đổi tab Admin không ngắt kết nối chat/file chung của ứng dụng.

Phác thảo bố cục:

```text
Quản trị hệ thống
Quản lý tài khoản và theo dõi hoạt động ứng dụng.

[ Tài khoản ]    [ Giám sát ]    [ Nhật ký ]

------------------------------------------------------
Nội dung của tab đang chọn
------------------------------------------------------
```

### 2.2. Các trạng thái chung

| Trạng thái | Cách hiển thị |
| --- | --- |
| Tải lần đầu | Khung chờ và dòng “Đang tải…”; chưa hiện số 0 như kết quả thật |
| Có dữ liệu | Hiển thị bảng/số liệu và thời điểm cập nhật |
| Không có dữ liệu | Giải thích theo ngữ cảnh; phân biệt chưa có bản ghi với bộ lọc không khớp |
| Lỗi lần đầu | Thông báo lỗi và nút “Thử lại” |
| Lỗi sau khi đã tải được | Giữ dữ liệu cũ, ghi rõ chưa cập nhật được |
| Đang gửi thao tác thay đổi | Khóa nút gửi tương ứng, hiển thị đang xử lý |
| Không rõ kết quả thao tác | Hiển thị trạng thái cần kiểm tra lại, không tự báo thất bại hoặc gửi quyết định mới |
| Mất quyền/phiên | Dừng yêu cầu tiếp theo và xử lý theo mục 10 |

Thông báo thành công gắn với đúng tài khoản và thao tác, ví dụ “Đã khóa tài khoản @minhanh”. Thông báo lỗi quan trọng giữ trên màn hình cho tới khi được xử lý hoặc đóng, không chỉ hiện thoáng qua.

## 3. Tab Tài khoản — danh sách

### 3.1. Mục đích

Đây là nơi tìm tài khoản và thực hiện thao tác quản trị. Không dùng bảng này để thay cho danh sách kết nối kỹ thuật ở tab Giám sát.

Phác thảo:

```text
Tài khoản

[Tìm theo tên hoặc @username…] [Vai trò] [Trạng thái khóa]
[Làm mới] [Xóa bộ lọc]

Tài khoản        Vai trò   Quyền sử dụng       Hiện diện     Thao tác
Minh Anh         User     Được phép hoạt động Online        [Chi tiết] [Khóa]
@minhanh
Tài khoản thử    User     Bị khóa             Offline       [Chi tiết] [Mở khóa]
@demo
Quản trị viên    Admin    Được phép hoạt động Online        [Chi tiết]
@admin

[Trang trước]    Hiển thị tối đa 25 tài khoản    [Trang tiếp]
```

### 3.2. Cột dữ liệu

| Cột | Nội dung | Lưu ý |
| --- | --- | --- |
| Tài khoản | Tên hiển thị, @username, mã tài khoản khi cần đối chiếu | Ảnh/chữ viết tắt theo khả năng hiển thị hiện có |
| Vai trò | User hoặc Admin | Bản đầu chỉ xem, không sửa vai trò |
| Quyền sử dụng | Được phép hoạt động hoặc Bị khóa | Dựa trên IsDisabled |
| Hiện diện | Online, Offline hoặc Chưa xác định | Phải lấy từ nguồn presence phù hợp |
| Ngày tạo | Thời gian tạo tài khoản | Có thể chuyển vào phần chi tiết trên màn hình hẹp |
| Thao tác | Chi tiết và Khóa/Mở khóa theo điều kiện | Tài khoản Admin chỉ có Chi tiết |

“Được phép hoạt động” khác với “Online”. Một tài khoản không bị khóa vẫn có thể offline. Không dùng một nhãn “Hoạt động” để thay cả hai trạng thái.

API monitoring hiện có dữ liệu tài khoản có kết nối, chưa cung cấp kết luận online theo đầy đủ quy tắc heartbeat của PresenceTracker. Khi chưa bổ sung được nguồn presence cho tab Tài khoản, hiển thị “Chưa xác định”, không tự đổi tài khoản không có socket thành Offline.

### 3.3. Tìm kiếm và bộ lọc

- Tìm kiếm áp dụng trên toàn bộ tập tài khoản được phép quản trị, không chỉ trang hiện tại.
- Tìm theo tên hiển thị hoặc username; bỏ khoảng trắng đầu/cuối.
- Tài khoản bị khóa vẫn xuất hiện trong kết quả Admin.
- Vai trò: Tất cả, User, Admin.
- Trạng thái khóa: Tất cả, Được phép hoạt động, Bị khóa.
- Đề xuất chờ khoảng 300 ms sau khi ngừng gõ mới gửi tìm kiếm.
- Đổi từ khóa/bộ lọc đưa về trang đầu; kết quả request cũ không được ghi đè kết quả mới.
- “Xóa bộ lọc” xóa từ khóa và đưa các lựa chọn về Tất cả.
- Không có kết quả: “Không tìm thấy tài khoản phù hợp.” Kèm nút xóa bộ lọc.

Lọc online có thể bổ sung sau khi API đã có dữ liệu chính xác. Nếu bổ sung, phải lọc trước khi phân trang; không lọc riêng các dòng của một trang đã tải.

### 3.4. Phân trang và làm mới

- Mặc định 25 dòng/trang; có Trang trước và Trang tiếp theo khả năng của API.
- Không dựng nút nhảy tới một số trang khi backend chỉ hỗ trợ con trỏ.
- Tổng số tài khoản, nếu hiển thị, phải do backend trả theo bộ lọc; không lấy số dòng hiện tại làm tổng.
- “Làm mới” giữ bộ lọc, tải lại trang đang xem và trạng thái tài khoản.
- Nếu sau thao tác trang không còn dòng nào, điều hướng về trang còn dữ liệu gần nhất hoặc trang đầu với thông báo phù hợp.
- Chưa cần tự tải lại toàn bộ bảng mỗi vài giây; ưu tiên làm mới sau thao tác và bằng nút của Admin.

### 3.5. Điều kiện các nút

| Đối tượng/trạng thái | Nút hiển thị |
| --- | --- |
| User được phép hoạt động | Chi tiết, Khóa |
| User bị khóa | Chi tiết, Mở khóa |
| Admin, gồm chính người đang đăng nhập | Chi tiết |
| Tài khoản đang có yêu cầu xử lý chưa rõ kết quả | Chi tiết/trạng thái xử lý; tạm chặn thao tác thay đổi tiếp theo |
| Dữ liệu tài khoản chưa tải hoặc chưa có phiên bản hợp lệ | Chưa cho gửi thao tác khóa/mở khóa |

Việc ẩn nút chỉ phục vụ giao diện. Backend vẫn kiểm tra vai trò của người thực hiện, loại tài khoản đích và trạng thái hiện tại.

## 4. Chi tiết tài khoản

### 4.1. Cách mở và đóng

- Bấm Chi tiết hoặc tên tài khoản để mở panel bên cạnh trên màn hình rộng.
- Màn hình hẹp hiển thị panel toàn vùng nội dung với nút Quay lại/Đóng.
- Đóng panel giữ nguyên bộ lọc và vị trí trong bảng.
- Chọn tài khoản khác phải hủy/bỏ kết quả của request chi tiết cũ.

### 4.2. Nội dung

| Nhóm | Thông tin |
| --- | --- |
| Nhận diện | Mã tài khoản, username, tên hiển thị, vai trò |
| Trạng thái | Quyền sử dụng, hiện diện nếu có nguồn dữ liệu hợp lệ |
| Thời gian | Ngày tạo, thời điểm hệ thống ghi nhận offline gần nhất nếu có |
| Xử lý gần nhất | Lần khóa/mở khóa gần nhất, người thực hiện, lý do và thời gian |
| Nhật ký liên quan | Một số thao tác gần nhất và nút “Xem nhật ký của tài khoản” |
| Thao tác | Khóa hoặc Mở khóa nếu là User và trạng thái cho phép |

LastSeenAt hiện được cập nhật khi hệ thống công bố offline. Không gọi trường này là “Đăng nhập lần cuối”. Nếu chưa có giá trị thì ghi “Chưa có dữ liệu”.

Không đưa PasswordHash, token hoặc thông tin xác thực hạ tầng vào chi tiết. Không dựng lịch sử IP/thiết bị, email hoặc lịch sử đăng nhập từ những trường chưa có trong code.

### 4.3. Đi tới nhật ký

Bấm “Xem nhật ký của tài khoản” chuyển sang tab Nhật ký với bộ lọc tài khoản đích đã điền. Hiển thị rõ đang lọc @username nào; có thể xóa bộ lọc để xem lại toàn bộ.

Nếu nhấn từ một tài khoản mới hơn tài khoản đã lọc trước đó, thay bộ lọc đích bằng tài khoản vừa chọn và đưa về trang đầu.

## 5. Hộp thoại khóa tài khoản

### 5.1. Nội dung trước khi xác nhận

```text
Khóa tài khoản

Minh Anh — @minhanh — #123
Trạng thái hiện tại: Được phép hoạt động

Tài khoản sẽ bị chặn đăng nhập mới và các phiên cũ sẽ bị thu hồi.
Dữ liệu và lịch sử của tài khoản được giữ lại.

Lý do khóa *
[Nhập lý do…                                          ]
0/500 ký tự

[Hủy]                                    [Xác nhận khóa]
```

- Tiêu đề, username và trạng thái đích phải rõ để tránh xử lý nhầm người.
- Lý do bắt buộc, tối đa 500 ký tự, không chấp nhận nội dung toàn khoảng trắng.
- Nút xác nhận chưa bật khi lý do chưa hợp lệ.
- Không gợi sẵn lý do giả và không tự gửi yêu cầu khi vừa mở hộp thoại.
- Hủy trước khi gửi chỉ đóng hộp thoại, không thay đổi trạng thái.

### 5.2. Khi bấm Xác nhận khóa

1. Giữ lại tài khoản, lý do, phiên bản và mã của lần xác nhận này.
2. Chuyển nút thành “Đang khóa…”; chặn gửi lặp.
3. Trong thời gian gửi, không cho sửa đối tượng hoặc nội dung của yêu cầu đang chạy.
4. Chờ kết quả server; không khóa tài khoản bằng cách chỉ đổi state trên trình duyệt.
5. Khi xác nhận thành công, cập nhật bảng, chi tiết và dữ liệu nhật ký liên quan.

Trong lúc đang gửi, tạm chặn đóng hộp thoại để tránh hiểu rằng đóng là hủy được thao tác trên server. Nếu request hết thời gian chờ, chuyển sang trạng thái kiểm tra kết quả theo mục 7; không giữ hộp thoại ở trạng thái đang gửi vô thời hạn.

### 5.3. Khi khóa thành công

- Đóng hộp thoại và thông báo “Đã khóa tài khoản @minhanh”.
- Trạng thái đổi thành Bị khóa; nút Khóa đổi thành Mở khóa sau khi các điều kiện xử lý được xác nhận.
- Chi tiết hiển thị lần xử lý và lý do vừa được ghi nhận.
- Bảng Nhật ký phải tra được đúng một thao tác khóa thành công.
- Nếu bộ lọc hiện tại là Được phép hoạt động, tài khoản có thể rời khỏi danh sách. Thông báo phải vẫn cho biết tài khoản nào vừa được khóa.

### 5.4. Tác động tới người dùng bị khóa

- Đăng nhập mới bị từ chối.
- Các phiên cũ bị thu hồi, kể cả phiên chưa mở kết nối SignalR.
- Client nhận biết phiên không còn hiệu lực, rời vùng đã đăng nhập và dọn các kết nối/peer do ứng dụng quản lý.
- Thông báo cho người đó có thể dùng: “Tài khoản của bạn đã bị khóa. Vui lòng liên hệ quản trị viên.”
- Lý do nội bộ được giữ trong nhật ký Admin; không mặc định gửi toàn bộ lý do cho các người dùng khác.
- Người đang trò chuyện với tài khoản bị khóa nhận trạng thái không khả dụng; không tiếp tục tạo tin hoặc phiên file mới với tài khoản đó.
- Dữ liệu cũ vẫn được giữ; việc xem lịch sử của người còn lại tiếp tục theo quyền thành viên hiện có.

Đối với P2P, server thu hồi quyền sử dụng dịch vụ và ứng dụng phối hợp đóng kênh. Không mô tả thao tác khóa như bảo đảm cắt tức thời mọi byte trực tiếp giữa các client không tuân thủ.

## 6. Hộp thoại mở khóa

### 6.1. Nội dung

- Tiêu đề “Mở khóa tài khoản”.
- Hiển thị đúng tài khoản, trạng thái Bị khóa và lý do khóa gần nhất nếu có.
- Nêu rõ: “Tài khoản có thể đăng nhập lại. Các phiên đã bị thu hồi không được khôi phục.”
- Lý do mở khóa bắt buộc, tối đa 500 ký tự.
- Hai nút Hủy và Xác nhận mở khóa.

### 6.2. Xử lý kết quả

- Trong khi gửi: “Đang mở khóa…”, chặn gửi lặp.
- Thành công: “Đã mở khóa tài khoản @minhanh”, cập nhật trạng thái và nhật ký.
- Người dùng đăng nhập lại bằng luồng hiện có; không tự đăng nhập hộ và không tạo token cho Admin chuyển cho người dùng.
- Nếu bộ lọc là Bị khóa, dòng vừa xử lý có thể rời danh sách; giữ thông báo thành công có username.

Không cho mở khóa khi việc thu hồi các phiên cũ của lần khóa trước chưa được giải quyết đầy đủ. Cơ chế backend phải ngăn phiên cũ chưa từng gửi request trong thời gian khóa sử dụng lại được sau khi mở khóa.

## 7. Các tình huống đặc biệt của khóa/mở khóa

### 7.1. Mạng chậm hoặc mất phản hồi

Hết thời gian chờ không chứng minh thao tác thất bại: server có thể đã commit nhưng phản hồi chưa tới trình duyệt.

Thông báo đề xuất:

> Chưa xác định được kết quả thao tác với @minhanh. Hãy kiểm tra kết quả trước khi thực hiện lại.

- Có nút “Kiểm tra kết quả”.
- Việc kiểm tra/gửi lại dùng cùng mã và cùng nội dung của lần xác nhận trước.
- Không tạo mã yêu cầu mới hoặc tự gửi thao tác ngược lại để “sửa” trạng thái chưa rõ.
- Có thể đóng hộp thoại sau thông báo, nhưng tài khoản vẫn được đánh dấu cần kiểm tra và giữ thông tin thao tác trong phiên giao diện hiện tại.
- Tải lại trạng thái tài khoản chỉ cho biết trạng thái hiện tại; phải đối chiếu kết quả thao tác/audit theo mã yêu cầu để biết lần gửi trước có thành công hay không.
- Nếu tải lại trang làm mất trạng thái chờ trên client, lần xử lý sau vẫn phải được backend bảo vệ bằng trạng thái, phiên bản và nhật ký đã lưu.

### 7.2. Hai Admin cùng xử lý hoặc dữ liệu đổi

- Nếu phiên bản dữ liệu không còn khớp, không ghi đè âm thầm.
- Hiển thị: “Thông tin tài khoản đã thay đổi. Vui lòng tải lại trước khi xác nhận.”
- Giữ lý do đã nhập để Admin không phải gõ lại.
- “Tải lại thông tin” lấy trạng thái mới; nếu vẫn cần xử lý thì Admin xem lại và xác nhận quyết định mới.
- Nếu tài khoản đã ở trạng thái mong muốn, báo rõ trạng thái hiện tại; không tạo thêm audit thay đổi giả.
- Nếu tài khoản đổi sang Admin, dừng thao tác và hiển thị chỉ xem theo phạm vi bản đầu.

RowVersion có thể đổi do cập nhật LastSeenAt. Thông báo xung đột không nên khẳng định chắc chắn một Admin khác vừa chỉnh tài khoản.

### 7.3. Lỗi giao dịch hoặc hậu xử lý

| Tình huống | Hành vi cần có |
| --- | --- |
| Lỗi trước khi commit thay đổi và audit | Không để lại nửa giao dịch; UI báo chưa thực hiện thành công và giữ lý do |
| Đã commit nhưng mất phản hồi | Đi theo luồng kiểm tra kết quả, không thêm log trùng |
| Đã commit khóa nhưng xử lý runtime chưa hoàn tất | Hiển thị “Đã cập nhật trạng thái khóa; đang hoàn tất thu hồi phiên”; backend cần có cơ chế xử lý tiếp |
| Chưa xác nhận đã thu hồi đủ phiên cũ | Chưa cho phép mở khóa làm sống lại các phiên đó |
| Bản ghi cũ được trả lại khi gửi lại | Hiển thị đúng kết quả thao tác cũ, đồng thời tải lại trạng thái hiện tại |

Không tuyên bố đã rollback SQL chỉ vì bước thông báo hoặc dọn RAM thất bại sau commit. Khả năng phản ánh và khôi phục hậu xử lý là yêu cầu cần giải quyết khi triển khai, hiện chưa có sẵn trong code.

### 7.4. Quy tắc chống gửi lặp

- Một lần xác nhận có một RequestId.
- Cùng người thực hiện, mã và nội dung thì tối đa một thay đổi cùng một audit.
- Dùng lại mã cho nội dung khác phải bị từ chối.
- Backend kiểm tra trạng thái và phiên bản ngay cả khi UI đã tắt nút gửi lặp.
- Nếu yêu cầu cũ đã được xử lý, không phát lại vô điều kiện mọi tác động của nó sau một lần mở khóa/đăng nhập mới khác; tránh ảnh hưởng các phiên mới không thuộc lần xử lý cũ.

## 8. Tab Giám sát — kế thừa phần hiện có

### 8.1. Bố cục

Giữ bốn khu vực chính đang có trong MonitoringPage, đưa vào tab Giám sát:

1. Tài khoản và kết nối kỹ thuật.
2. Biểu đồ request HTTP/SignalR.
3. Lưu lượng và thời gian xử lý backend.
4. Phiên truyền file và dòng thời gian.

Phần đầu tab có thời điểm cập nhật, nhãn độ mới dữ liệu và phạm vi số liệu một backend instance. Không yêu cầu tạo một dashboard mới để thay toàn bộ phần đã làm.

### 8.2. Tài khoản và kết nối kỹ thuật

- Hiển thị số kết nối SignalR và số tài khoản có kết nối theo dữ liệu hiện có.
- Bảng thể hiện tài khoản, vai trò/quyền sử dụng và các kết nối được ghi nhận.
- Mỗi kết nối có mã rút gọn, thời điểm mở và heartbeat gần nhất nếu có.
- Tìm kiếm hiện tại vẫn ghi rõ “Tìm trong trang hiện tại”; không giới thiệu thành tìm kiếm toàn bộ tài khoản.
- Có phân trang người dùng như API hiện có; ghi rõ giới hạn số kết nối trả về.
- Có thể bấm tài khoản để chuyển sang chi tiết tương ứng ở tab Tài khoản.
- Không đặt thêm một bộ nút khóa/mở khóa tại đây; các quyết định quản trị đi qua tab Tài khoản để có cùng luồng xác nhận.

Tài khoản có kết nối, số kết nối và người online là các khái niệm riêng. Bản hiện tại không được đổi nhãn connectedUsers thành “Người online” nếu chưa dùng đúng nguồn presence.

Nếu kết nối bị giới hạn/truncated trong phản hồi, không kết luận tài khoản ngoài phần hiển thị chắc chắn không có kết nối. Nhãn phù hợp là “Không có kết nối trong dữ liệu được trả về”.

### 8.3. Biểu đồ request và bảng thời gian xử lý

Kế thừa số lời gọi, kết quả, thời gian trung bình, p95 và byte vào/ra. Phạm vi hiển thị cần rõ:

| Nội dung | Cách diễn giải trên giao diện |
| --- | --- |
| Biểu đồ HTTP/SignalR | Số request/lời gọi được bộ đo ghi nhận, theo các khoảng mẫu |
| Trung bình/p95 | Thời gian xử lý phía backend; không gọi là độ trễ mạng |
| Byte HTTP | Payload ứng dụng thực đọc/ghi; không gồm toàn bộ header/TLS hoặc file P2P |
| Byte SignalR | Ước tính JSON arguments/result; không phải toàn bộ lưu lượng trên đường truyền |
| Kết quả | Tách lỗi server, bị từ chối và bị hủy |
| Dữ liệu chưa đo | “Chưa đo”; chỉ hiện 0 khi đã có số đo hợp lệ bằng 0 |

Giữ giải thích ngắn gần số liệu. Thông tin kỹ thuật chi tiết có thể đặt trong vùng “Cách đọc số liệu” để người xem không phải đọc một đoạn dài trước mỗi bảng.

Mẫu request hiện giới hạn 15 phút và 20.000 mẫu; biểu đồ hiện xem 5 phút gần nhất. Khi có mẫu bị loại do giới hạn, phải giữ cảnh báo phạm vi bị thiếu; không coi là thống kê toàn bộ lưu lượng.

### 8.4. Phiên truyền file

Bảng nên trình bày:

- Mã phiên và hai tài khoản liên quan.
- Kích thước metadata.
- Trạng thái do backend ghi nhận.
- Giai đoạn và số byte client đã báo, có nguồn gửi/nhận và thời điểm.
- Nguyên nhân thất bại được báo cùng nguồn xác định.
- Nút mở dòng thời gian của đúng phiên.

Các nhãn trạng thái:

| Giá trị | Nhãn |
| --- | --- |
| offered | Chờ người nhận |
| accepted | Đang thiết lập kết nối |
| transferring | Đang truyền / chờ xác nhận |
| completed | Đã hoàn tất |
| rejected | Đã từ chối |
| cancelled | Đã hủy |
| expired | Lời mời hết hạn |
| failed | Thất bại |

Ở dòng thời gian, phân biệt backend, client gửi và client nhận. Khi xem chi tiết tiến độ, nên tách báo cáo gần nhất của từng phía; không gộp số byte phía gửi và phía nhận thành cùng một tiến độ liên tục.

Nếu chưa có báo cáo: “Chưa có báo cáo client”. Nếu chưa có bằng chứng về lỗi: “Chưa đủ dữ liệu xác định nguyên nhân”. Không suy ra lỗi chắc chắn chỉ từ một báo cáo đã cũ.

Phiên completed phản ánh server đã chấp nhận xác nhận số byte/hash từ client nhận. Không biến báo cáo telemetry thành quyền tự sửa trạng thái nghiệp vụ.

### 8.5. Dòng thời gian phiên file

- Mở khi chọn đúng mã phiên; có tiêu đề chứa mã đó và nút đóng.
- Hiển thị thời gian, nguồn, giai đoạn, byte nếu có và mã/nghĩa nguyên nhân.
- Có chú thích lịch sử bị giới hạn: tối đa 24 giờ/5.000 sự kiện được giữ, API hiện trả tối đa 500 sự kiện cho trang file.
- Không có sự kiện phù hợp thì ghi “Chưa có sự kiện trong dữ liệu hiện có”, không khẳng định phiên chưa từng phát sinh sự kiện.
- Đổi trang file đóng dòng thời gian đang xem, tránh giữ tiêu đề một phiên nhưng dữ liệu đã chuyển sang trang khác.
- Nếu tài khoản/phiên cần hỗ trợ không có trong trang đang xem, dùng luồng phân trang hiện có; tìm kiếm toàn bộ phiên là phần có thể bổ sung sau.

Bản đầu không có nút sửa kết quả phiên, đánh dấu hoàn tất, tải file riêng hoặc khôi phục nội dung file từ server.

### 8.6. Độ mới dữ liệu và polling

- Kế thừa polling khoảng 5 giây khi tab Giám sát đang hiển thị; không chồng request.
- Rời tab, đóng vùng Admin hoặc đăng xuất phải dừng timer/yêu cầu tương ứng.
- Khi trình duyệt bị ẩn, không tiếp tục tạo request mới đều đặn như khi đang xem.
- Lỗi tạm thời có backoff; 429 cần tôn trọng thời gian chờ server trả về.
- 401/403 dừng polling và xử lý theo mục 10.
- Có thể bổ sung nút Làm mới; nút không được tạo nhiều request song song.

| Tuổi dữ liệu hiển thị | Nhãn/màu đề xuất |
| --- | --- |
| Chưa nhận được dữ liệu | Xám — Đang chờ dữ liệu |
| Không quá 10 giây | Xanh — Dữ liệu mới |
| Trên 10 đến 20 giây | Vàng — Cập nhật chậm |
| Trên 20 giây | Đỏ — Dữ liệu đã cũ |

Tuổi phản hồi dashboard và tuổi báo cáo client là hai thông tin riêng. Lấy dashboard mới không được làm mới timestamp của một báo cáo client cũ. Màu đỏ không tự thay trạng thái file thành failed.

Giới hạn monitoring hiện theo IP; khi cho nhiều Admin/tab cùng dùng, cần kiểm tra tổng tần suất để tránh các phiên hợp lệ gây 429 cho nhau.

### 8.7. Hai việc cần sửa khi triển khai

**Đường lưu snapshot:** worker đang lưu vào ContentRoot/App_Data/monitoring, trong khi service Linux trong repo dùng ProtectSystem=strict và chưa khai báo vùng ghi tương ứng. Cần một đường lưu trạng thái được cấp quyền ghi và cấu hình triển khai phù hợp. Chưa sửa trong lượt lập tài liệu này.

**Đếm lời gọi bị giới hạn:** nhánh chặn ReportFileObservation vì quá tần suất hiện nằm ngoài phần ghi mẫu của filter. Đã tái hiện trường hợp 9 lần gọi, 1 lần bị từ chối nhưng thống kê chỉ có 8 mẫu và 0 lần từ chối. Cần đưa kết quả này vào bộ đo, không bỏ qua để bảng nhìn ít lỗi hơn thực tế.

Không coi hai việc trên đã được khắc phục chỉ vì các test hiện có đã qua ở lượt rà soát trước.

## 9. Tab Nhật ký

### 9.1. Mục đích và bố cục

Tab này dành cho quyết định quản trị tài khoản. Timeline file, mẫu request và archive giám sát vẫn thuộc tab Giám sát.

```text
Nhật ký quản trị

[Tài khoản bị xử lý] [Admin thực hiện] [Thao tác]
[Từ ngày] [Đến ngày] [Áp dụng] [Xóa bộ lọc] [Làm mới]

Thời gian       Người thực hiện   Tài khoản đích   Thao tác   Lý do
02/11 14:30     @admin_a          @minhanh         Khóa      …
02/11 15:15     @admin_b          @minhanh         Mở khóa   …

[Trang trước]                                      [Trang tiếp]
```

### 9.2. Nội dung một bản ghi

| Trường | Hiển thị |
| --- | --- |
| Thời gian | Thời gian server ghi nhận, hiển thị theo giờ Việt Nam |
| Người thực hiện | Tên/username và mã Admin để phân biệt |
| Tài khoản đích | Tên/username và mã tài khoản |
| Thao tác | Khóa hoặc Mở khóa |
| Trạng thái trước/sau | Được phép hoạt động → Bị khóa hoặc chiều ngược lại |
| Lý do | Nội dung đã nhập; mở rộng khi bị thu gọn |
| Mã bản ghi/mã yêu cầu | Trong phần chi tiết để đối chiếu khi cần |

Mặc định sắp xếp mới nhất trước; dùng mã bản ghi làm khóa phụ khi hai thời gian bằng nhau. ID BIGINT được giữ dạng chuỗi ở giao diện.

### 9.3. Tìm và lọc

- Lọc theo tài khoản đích, Admin thực hiện, loại thao tác và khoảng ngày.
- Tìm/lọc trên toàn bộ dữ liệu phù hợp, không lọc riêng một trang đã tải.
- Khoảng ngày bao gồm toàn bộ ngày cuối theo giờ Việt Nam; backend chuyển ranh giới về UTC.
- Ngày bắt đầu sau ngày kết thúc: báo lỗi tại bộ lọc, chưa gửi truy vấn.
- Đổi bộ lọc/Áp dụng đưa về trang đầu.
- “Xóa bộ lọc” trở về danh sách chung; “Làm mới” giữ bộ lọc.
- Nếu đi từ chi tiết tài khoản, hiển thị rõ bộ lọc tài khoản đã được điền sẵn.

### 9.4. Đọc chi tiết và các trạng thái

- Chọn một dòng mở đầy đủ lý do và thông tin trước/sau.
- Có thể đi tới chi tiết tài khoản đích từ bản ghi.
- Chưa có nhật ký: “Chưa có thao tác quản trị được ghi nhận.”
- Bộ lọc không khớp: “Không tìm thấy nhật ký phù hợp.”
- Lỗi tải: giữ bộ lọc, có Thử lại; nếu đang có dữ liệu cũ thì ghi chưa cập nhật được.
- Không có nút sửa/xóa bản ghi hoặc nhập tay một nhật ký thành công.

Bảng audit hiện phù hợp hai thao tác khóa/mở khóa. Buộc đăng xuất độc lập, sửa vai trò hoặc thao tác khác cần mở rộng nghiệp vụ audit trước khi đưa vào UI.

## 10. Thông báo lỗi và mất quyền

| Tình huống | Thông báo đề xuất | Hành động của UI |
| --- | --- | --- |
| Lý do rỗng/toàn khoảng trắng | Vui lòng nhập lý do xử lý. | Báo tại ô nhập, chưa gửi |
| Lý do quá dài | Lý do tối đa 500 ký tự. | Giữ nội dung, yêu cầu rút ngắn |
| Mất mạng khi tải danh sách | Chưa kết nối được máy chủ. Bạn thử lại nhé. | Giữ bộ lọc, có Thử lại |
| Hết thời gian chờ sau xác nhận | Chưa xác định được kết quả thao tác. | Đi luồng kiểm tra kết quả cũ |
| Tài khoản không còn tồn tại | Tài khoản không còn khả dụng để xử lý. | Dừng thao tác, làm mới bảng |
| Dữ liệu/phiên bản thay đổi | Thông tin tài khoản đã thay đổi. Vui lòng tải lại. | Giữ lý do; yêu cầu xem lại trạng thái |
| Tài khoản đã ở trạng thái yêu cầu | Tài khoản hiện đã bị khóa/đã được mở khóa. | Tải lại, không tạo audit giả |
| Tài khoản đích không thuộc phạm vi xử lý | Tài khoản này chỉ được xem trong phiên bản hiện tại. | Không gửi thay đổi tiếp theo |
| Phiên Admin hết hạn/đã thu hồi | Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại. | Dừng request, dọn dữ liệu Admin, về đăng nhập |
| Admin không còn quyền quản trị | Bạn không còn quyền truy cập khu vực quản trị. | Dừng thao tác, xác nhận lại quyền và rời Admin khi phù hợp |
| 429 | Đang có quá nhiều yêu cầu. Vui lòng chờ rồi thử lại. | Tôn trọng Retry-After, không retry dồn |
| Lỗi server/dịch vụ | Chưa xử lý được yêu cầu. Vui lòng thử lại. | Không báo thành công giả; giữ thông tin cần thử lại |
| Dữ liệu giám sát đã cũ | Chưa cập nhật được dữ liệu mới. | Giữ số liệu cũ và nhãn tuổi dữ liệu |

Không suy ra mọi 403 đều là tài khoản bị khóa hoặc hết phiên. Cần đọc mã lỗi/ngữ cảnh; nếu là mất quyền Admin thì xác nhận lại hồ sơ/quyền, không tự đăng xuất một phiên User vẫn hợp lệ chỉ vì không được dùng chức năng Admin.

Khi có thao tác đang chờ mà người thực hiện mất quyền, dừng gửi thêm. Kết quả trên server vẫn phải được bảo vệ bởi xác thực, giao dịch và mã yêu cầu; UI không tự kết luận thao tác đã bị hủy.

## 11. Hành vi trên màn hình hẹp và thao tác bàn phím

- Ba tab còn đọc được, có thể cuộn ngang nếu cần; tab đang chọn rõ ràng.
- Bảng dùng vùng cuộn ngang riêng, không đẩy toàn bộ trang ra ngoài màn hình.
- Nội dung ít quan trọng có thể chuyển vào Chi tiết, vẫn giữ username, trạng thái và nút xử lý rõ ràng.
- Panel chi tiết chuyển sang toàn vùng nội dung trên màn hình hẹp.
- Hộp thoại có nhãn ô nhập, giới hạn chiều cao và cuộn phần nội dung; nút Hủy/Xác nhận luôn tìm được.
- Có thể đi qua các nút/ô bằng bàn phím; khi đóng hộp thoại trả focus về nút đã mở.
- Không chỉ dùng màu để thể hiện khóa, lỗi hoặc dữ liệu cũ; luôn có chữ đi kèm.
- Không dùng Enter tại ô lý do nhiều dòng như một thao tác xác nhận khóa ngoài ý muốn.

## 12. Hợp đồng chức năng cần có ở backend

Phần này giúp nối giao diện với hành vi thật, chưa phải mã triển khai hoặc danh sách API đã tồn tại.

| Nhu cầu giao diện | Nền tảng hiện có | Phần cần bổ sung |
| --- | --- | --- |
| Dữ liệu tab Giám sát | GET /api/v1/admin/monitoring | Tái sử dụng; sửa bộ đo/lưu archive và điều chỉnh UI theo mô tả |
| Tìm/lọc/phân trang tài khoản | Model User và API search phục vụ người dùng | API Admin tìm trên toàn bộ tập tài khoản, có phiên bản dữ liệu |
| Chi tiết và nhật ký gần nhất của tài khoản | User và AdminAuditLogs | DTO/API riêng, không trả entity chứa mật khẩu băm |
| Khóa/mở khóa | IsDisabled, RowVersion, bảng audit | Kiểm tra quyền, giao dịch, RequestId, phản hồi xung đột và kết quả gửi lại |
| Thu hồi mọi phiên khi khóa | Registry hiện chỉ thu hồi từng sid | Cơ chế theo user/thế hệ phiên, xử lý cả cấp token đồng thời |
| Thông báo và dọn runtime | Presence, text/file service và client cleanup | Điều phối tác động sau commit, phản ánh/khoanh vùng hậu xử lý chưa xong |
| Tra cứu tab Nhật ký | Model/bảng audit | API đọc có lọc/phân trang và thông tin actor/target |

Các yêu cầu bắt buộc:

- Mọi API Admin kiểm tra quyền tại server; không tin AdminUserId do client tự khai báo.
- Tài khoản đích và vai trò hiện tại phải được kiểm tra, kể cả khi UI đang giữ dữ liệu cũ.
- Đổi trạng thái và ghi audit nằm trong cùng giao dịch SQL.
- Cùng RequestId/nội dung không tạo thêm thay đổi và audit.
- Phải phân biệt được kết quả thao tác đã ghi nhận với trạng thái hiện tại của tài khoản.
- Thu hồi bao gồm phiên không có SignalR, phiên chưa gọi API trong thời gian khóa và luồng cấp token chạy đồng thời.
- Dọn RAM/thông báo không nằm trong SQL transaction; không báo sai kết quả khi một phần hậu xử lý lỗi.
- Người còn lại trong cuộc trò chuyện vẫn đọc lịch sử theo quyền hiện có; việc khóa không xóa dữ liệu.
- Giữ thống nhất bảo vệ audit giữa schema SQL, migration và quyền của tài khoản SQL chạy ứng dụng.

Chưa cần thêm một API buộc đăng xuất độc lập để làm bản đầu. Tuy nhiên, thu hồi toàn bộ phiên do thao tác khóa vẫn là yêu cầu bắt buộc của bản đầu.

## 13. Tiêu chí nghiệm thu theo hành vi

Các tình huống này là yêu cầu cần kiểm tra sau khi triển khai, không phải danh sách đã được chạy và đạt trong lượt viết tài liệu.

| Mã | Tình huống | Kết quả mong muốn |
| --- | --- | --- |
| UI-01 | User mở đường dẫn/gửi request Admin | Không được truy cập dữ liệu hoặc thực hiện thao tác quản trị |
| UI-02 | Admin vào Quản trị | Có 3 tab, tải đúng dữ liệu; không dùng tài khoản/log mẫu |
| UI-03 | Tìm tài khoản nằm ngoài trang đang tải | Tab Tài khoản tìm được bằng API toàn tập; monitoring vẫn ghi đúng phạm vi lọc trang |
| UI-04 | Bảng có User/Admin, khóa/chưa khóa | Nút xử lý xuất hiện đúng điều kiện; backend vẫn tự kiểm tra |
| UI-05 | Nhập lý do rỗng/quá dài | Chặn gửi và hiển thị lỗi đúng ô nhập |
| UI-06 | Bấm Hủy trước xác nhận | Không đổi trạng thái, không thêm audit |
| UI-07 | Khóa một User có nhiều phiên, gồm phiên chưa mở Hub | Mọi phiên cũ bị thu hồi, đăng nhập mới bị chặn |
| UI-08 | Một phiên không gửi request trong lúc bị khóa | Sau mở khóa, phiên cũ vẫn không được sử dụng lại |
| UI-09 | Cấp token đồng thời với khóa/thu hồi | Không có phiên lọt qua cơ chế thu hồi do chạy đua |
| UI-10 | Khóa thành công khi đang lọc Được phép hoạt động | Dòng rời bộ lọc hợp lý; thông báo vẫn xác định đúng tài khoản vừa xử lý |
| UI-11 | Mở khóa thành công | Cho đăng nhập mới, giữ lịch sử; audit chỉ có một thao tác mở khóa |
| UI-12 | Mất phản hồi sau khi server đã commit | UI kiểm tra lại bằng yêu cầu cũ; không tạo thay đổi/log trùng |
| UI-13 | Hai Admin hoặc cập nhật LastSeenAt làm đổi phiên bản | Có thông báo tải lại, giữ lý do, không ghi đè âm thầm |
| UI-14 | Ghi audit lỗi | Không để lại một lần đổi IsDisabled mà thiếu audit thành công |
| UI-15 | Dọn runtime lỗi sau commit | Không báo rollback giả, thể hiện cần hoàn tất và chặn mở khóa thiếu điều kiện |
| UI-16 | Chuyển tab/rời Admin | Dừng polling màn hình không hiển thị; chat/file chung không bị ngắt chỉ vì đổi tab |
| UI-17 | Dashboard nhận phản hồi mới nhưng báo cáo file đã cũ | Tuổi báo cáo file vẫn cũ, không đổi xanh theo tuổi phản hồi |
| UI-18 | API lỗi, mẫu bị giới hạn hoặc chưa có số đo | Ghi đúng lỗi/phạm vi/Chưa đo; không tự dựng số 0 thành dữ liệu thật |
| UI-19 | File bị hủy/từ chối/hết hạn | Nhãn khác failed; không tự kết luận lỗi mạng |
| UI-20 | Chọn phiên rồi đổi trang file | Timeline đóng/chuyển đúng ngữ cảnh, không giữ tiêu đề sai với dữ liệu |
| UI-21 | Đi từ chi tiết tài khoản sang Nhật ký | Bộ lọc đúng tài khoản, trang đầu, có thể xóa lọc để xem toàn bộ |
| UI-22 | Admin mất quyền hoặc hết phiên khi đang mở màn hình | Dừng thao tác/polling, thông báo đúng và điều hướng phù hợp |
| UI-23 | Khởi động lại dịch vụ sau khi đã lưu monitoring | Đọc được archive theo phạm vi lưu; không phục hồi giả kết nối sống |
| UI-24 | Một lời gọi Hub bị chặn vì tần suất | Bộ đo vẫn ghi nhận kết quả từ chối, không bỏ sót khỏi thống kê |
| UI-25 | Dùng màn hình hẹp/bàn phím | Tìm được nút xử lý, đọc trạng thái, mở/đóng hộp thoại và thao tác an toàn |

## 14. Thứ tự làm và phần để sau

### 14.1. Thứ tự đề xuất

1. Chốt mô tả 3 tab và các trạng thái thao tác trong tài liệu này.
2. Bổ sung nền tảng API tài khoản, thu hồi phiên và audit đúng giao dịch.
3. Làm luồng Tài khoản, chi tiết, khóa/mở khóa cùng các trường hợp lỗi.
4. Làm Nhật ký và điều hướng từ tài khoản sang bộ lọc nhật ký.
5. Đưa monitoring hiện có vào tab Giám sát; sửa hai vấn đề đã xác định và vòng đời polling.
6. Kiểm tra các tình huống nghiệm thu, đặc biệt mất phản hồi, nhiều phiên và cập nhật đồng thời.

Đây là thứ tự triển khai khi bắt đầu viết code; không có bước triển khai ứng dụng nào được thực hiện trong lượt lập tài liệu này.

### 14.2. Chức năng để sau

- Buộc đăng xuất độc lập với khóa: cần loại audit phù hợp.
- Cấp/thu hồi vai trò Admin, chỉnh hồ sơ, đặt lại mật khẩu.
- Khóa có hẹn giờ hoặc xử lý hàng loạt.
- Xóa tài khoản/lịch sử vĩnh viễn.
- Lịch sử thiết bị/IP và lịch sử đăng nhập bền vững.
- Tiếp nhận báo cáo vi phạm và xử lý bằng chứng.
- CPU/RAM, độ trễ mạng, lịch sử route/TURN hoặc chỉnh cấu hình hạ tầng trên UI.
- Can thiệp tùy ý vào trạng thái truyền file hoặc xem nội dung chat/file riêng.
- Một tab Tổng quan riêng với nhiều biểu đồ mới.

Bản đầu hoàn thành khi Admin tìm được tài khoản thật, khóa/mở khóa đúng tác động, tra được nhật ký và tiếp tục dùng được phần giám sát nhóm đã xây dựng.

## 15. Mã nguồn đối chiếu

Các liên kết trỏ đến workspace hiện tại, làm căn cứ cho phần “hiện có” và “cần bổ sung”. Không dùng tài liệu Markdown cũ làm nguồn cho đặc tả này.

| Mã nguồn | Nội dung liên quan |
| --- | --- |
| [App.jsx](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/frontend/src/App.jsx:111) | Guard giao diện và mục Admin mở MonitoringPage |
| [MonitoringPage.jsx](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/frontend/src/pages/MonitoringPage.jsx:29) | Bốn khu vực giám sát, polling, phân trang, độ mới và timeline |
| [MonitoringController.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Controllers/MonitoringController.cs:10) | Policy Admin, dữ liệu tài khoản/file và giới hạn phân trang |
| [MonitoringService.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Services/MonitoringService.cs:95) | Bộ đo Hub và nhánh giới hạn tần suất cần sửa |
| [MonitoringArchiveWorker.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Services/MonitoringArchiveWorker.cs:10) | Đường lưu snapshot và ghi định kỳ |
| [pbl4.service](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/deploy/pbl4.service:10) | Thư mục chạy ứng dụng và ProtectSystem=strict |
| [User.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Models/User.cs:12) | Trường tài khoản, IsDisabled và RowVersion |
| [AdminAuditLog.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Models/AdminAuditLog.cs:5) | Lý do, người thực hiện, đối tượng và trạng thái trước/sau |
| [SessionRegistry.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Auth/SessionRegistry.cs:6) | Registry hiện chỉ thu hồi từng sid |
| [SessionValidationEvents.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Auth/SessionValidationEvents.cs:20) | Vai trò hiện tại và chặn tài khoản bị khóa khi xác thực HTTP |
| [PresenceTracker.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Realtime/PresenceTracker.cs:72) | Phân biệt online với các kết nối được theo dõi |
| [PresenceService.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Realtime/PresenceService.cs:59) | Cập nhật LastSeenAt và thông báo trạng thái |
| [FileTransferService.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Services/FileTransferService.cs:12) | Trạng thái file, telemetry, dọn phiên và thông báo |
| [AppDBContext.cs](D:/PBL4_Code/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data/PBL4/Data/AppDBContext.cs:157) | Ràng buộc của audit khóa/mở khóa |

# Đặc tả truyền file WebRTC v2

Giai đoạn một kênh đã được triển khai ngày 13/11/2026. Cách chạy và phạm
vi kiểm thử nằm trong [hướng dẫn truyền file](file-transfers.md).

Cập nhật 14/11: tăng tối đa **10 GiB**, cảnh báo trước khi gửi file **lớn hơn
1 GiB**. Để vượt mốc 4 GiB, bản triển khai bổ sung `file-v3-0`, dùng offset
uint64 (8 byte big-endian). `file-v2` và `file-v1` giữ giới hạn 100 MiB và
định dạng cũ để tương thích. File trên 100 MiB chỉ thương lượng `file-v3`,
bắt buộc máy nhận ghi đĩa theo luồng; không chuyển về nhận Blob.
Các đề xuất nhiều kênh bên dưới vẫn là lộ trình, hiện chỉ chạy **một kênh**.

## 1. Phạm vi và thứ tự triển khai

Hoàn thiện truyền file bằng **1 DataChannel** trước. Khi bản một kênh đã truyền,
kiểm tra và lưu file đúng, thử lần lượt **2, 3 và 4 DataChannel**. Số kênh mặc
định sau thử nghiệm được chọn theo thời gian lưu file thực tế.

| Giai đoạn | Kết quả cần đạt |
| --- | --- |
| 1 kênh | Hai tab gửi và nhận được file, ghi theo từng khối, kiểm tra SHA-256 và lưu vào thư mục đã chọn. |
| 2 kênh | Hai nửa file truyền qua hai kênh và ghi vào cùng file tạm, kể cả khi nửa sau đến trước. |
| 3 và 4 kênh | Chia file bằng cùng quy tắc, xác minh đủ mọi phần và chạy cùng bài đo với 1 và 2 kênh. |
| Chọn cấu hình | So kết quả đường trực tiếp và qua TURN. Thử 6 hoặc 8 kênh nếu kết quả ở 4 kênh còn cho thấy lợi ích rõ ràng. |

Trong tài liệu này, một **luồng truyền** tương ứng với một WebRTC DataChannel.
Mỗi file có một `TransferId`, một lời mời, một lần chấp nhận và một
`RTCPeerConnection`. Các kênh trong kết nối dùng chung cơ chế điều tiết tắc
nghẽn của SCTP. Mức tăng tốc cần được đo trên từng loại đường truyền.
[RFC 8831 về WebRTC DataChannel](https://www.rfc-editor.org/rfc/rfc8831.html#section-5)

Phạm vi thử đầu tiên là **Web ↔ Web**, ban đầu 100 MiB, hiện tối đa **10 GiB mỗi file**. Dùng Chrome
hoặc Edge desktop và kiểm tra quyền ghi ở máy nhận. Khi thử trên hai máy LAN,
trang web cần chạy trong ngữ cảnh bảo mật, chẳng hạn HTTPS với chứng chỉ trình
duyệt tin cậy. Với file tối đa 100 MiB, nếu máy nhận thiếu khả năng dùng
`file-v2`, chọn `file-v1` trước khi truyền và dùng nút **Tải xuống** hiện tại.
File lớn hơn cần `file-v3`, quota OPFS và dung lượng đĩa cho file tạm/bản lưu.
[Tài liệu File System Access của Chrome](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)

## 2. Mở phiên và chia file

1. Máy gửi tính SHA-256 theo từng khối rồi gọi `OfferFile` với tên file, kích
   thước, hash, phiên bản hỗ trợ và số kênh muốn thử. Giai đoạn đầu yêu cầu
   **1 kênh**. Các lượt đo sau dùng cùng luồng xử lý với số kênh cấu hình được.
2. Người nhận bấm **Nhận file** trong Chat hoặc Tệp. Trình duyệt mở hộp
   **Lưu thành** ngay từ thao tác bấm để chọn tên và vị trí file đích. Khi đã
   có quyền ghi, app giữ file handle theo phiên rồi gọi `AcceptFile` cùng khả
   năng của tab nhận. Nếu hủy hộp lưu, lời mời vẫn chờ cho đến khi hết hạn. Họ có thể chủ
   động chọn cách nhận cũ nếu hai bên hỗ trợ.
   Chỉ xin quyền cho file đích để dùng được ở nhiều vị trí hơn việc cấp quyền
   cả thư mục. Các giới hạn của trình duyệt và hệ điều hành vẫn áp dụng.
   Tên lưu phải giữ đuôi file gốc (không phân biệt hoa/thường); nếu picker
   trả về đuôi khác, báo lỗi và để người nhận chọn lại trước `AcceptFile`.
   [Quy định về hộp Lưu thành](https://wicg.github.io/file-system-access/#api-showsavefilepicker)
3. Backend kiểm tra người nhận và hạn lời mời, chốt phiên bản và số kênh thực
   tế rồi gửi qua `FileChanged`. Giữ cấu hình đó đến hết phiên. Dùng Hub
   hiện tại để chuyển tiếp SDP/ICE và cập nhật trạng thái phiên. Nội dung
   file đi qua WebRTC.
   [Hub hiện tại](../PBL4/Realtime/ChatHub.cs) · [Luồng file hiện tại](./file-transfers.md)
4. Máy gửi tạo các DataChannel tin cậy, có thứ tự, nhãn từ `file-v2-0` đến
   `file-v2-(N-1)` trên cùng kết nối trước khi tạo SDP Offer. Máy nhận mở
   file tạm và gửi `READY` trên từng kênh. Khi đủ `READY`, máy gửi gọi
   `BeginFileTransfer` cho cả phiên và bắt đầu gửi khi máy chủ xác nhận.

Mỗi khối chứa tối đa **16 KiB nội dung**. Số khối bằng kích thước file chia cho
16 KiB, làm tròn lên. Chia các khối thành `N` phần liền nhau, lấy phần nguyên
khi chia đều rồi cấp thêm một khối cho từng kênh đầu đến khi hết phần dư.
Chọn `N` là giá trị nhỏ nhất giữa số kênh yêu cầu, số khối và số kênh tối
đa mỗi bên hỗ trợ. Với file rỗng, dùng một kênh trao đổi `READY` và `END`.

Ví dụ file **100 MiB** có **6.400 khối**. Với 2 kênh, mỗi kênh có 3.200 khối.
Với 3 kênh, số khối lần lượt là 2.134, 2.133 và 2.133. Mỗi kênh sở hữu một
khoảng byte `[đầu, cuối)`. Máy nhận chấp nhận các khối của nhiều kênh xen kẽ
và kiểm tra offset tăng đúng trong từng khoảng.

## 3. Khung truyền, hạn mức và tiến độ

| Khung | Chiều gửi | Nội dung và cách xử lý |
| --- | --- | --- |
| `READY` | Nhận → gửi | Báo đúng phiên và đúng kênh đã sẵn sàng ghi vào file tạm. |
| `DATA` | Gửi → nhận | Offset tuyệt đối big-endian: 4 byte không dấu ở v2, 8 byte không dấu ở v3; tiếp theo tối đa 16 KiB nội dung. |
| `ACK` | Nhận → gửi | Tổng số byte liên tiếp đã ghi thành công của kênh. Giá trị tăng dần và tối đa bằng số byte máy gửi đã gửi trên kênh đó. |
| `END` | Gửi → nhận | Báo mọi khối thuộc khoảng của kênh đã được đưa vào hàng đợi gửi. Máy nhận tiếp tục chờ các thao tác ghi đang chạy. |

Dùng JSON dạng văn bản cho `READY`, `ACK` và `END`. Kiểm tra nhãn kênh,
offset và kích thước dự kiến trước khi đưa khối `DATA` vào hàng đợi ghi.
Khối trùng, thiếu khối, lệch khoảng hoặc khung sai làm phiên thất bại. Kiểm
tra kích thước khung gồm cả phần đầu với giới hạn bản tin SCTP đã thương
lượng trước khi gửi. [Giới hạn bản tin WebRTC](https://w3c.github.io/webrtc-pc/#dom-rtcsctptransport-maxmessagesize)

Các lượt đo giữ cùng **512 KiB dữ liệu chưa ACK trên mỗi file**. Chia hạn mức
theo đơn vị 16 KiB để mỗi kênh có chỗ gửi các khối đầy đủ.

| Số kênh | Hạn mức chưa ACK từng kênh | Tổng |
| --- | --- | --- |
| 1 | 512 KiB | 512 KiB |
| 2 | 256 + 256 KiB | 512 KiB |
| 3 | 176 + 176 + 160 KiB | 512 KiB |
| 4 | 128 + 128 + 128 + 128 KiB | 512 KiB |

- Máy gửi chỉ đọc và xếp khối tiếp theo khi **byte đã gửi trừ byte đã ACK
  cộng kích thước khối** còn trong hạn mức kênh. Tính cả khối đã giữ chỗ để
  đọc bất đồng bộ. Giữ cùng ngưỡng cho tổng `bufferedAmount` ở mọi cấu hình
  và chờ buffer giảm khi đầy. Ngưỡng bắt đầu thử là 256 KiB cho cả kết nối.
- Máy nhận xử lý từng khối qua **một hàng đợi ghi chung**. Sau mỗi 64 KiB
  ghi thêm trên một kênh, hoặc sau khối cuối của kênh, gửi ACK cộng dồn.
  Hàng đợi nhận từ chối dữ liệu vượt hạn mức. Các ngưỡng này kiểm soát dữ
  liệu đang chờ xử lý. RAM thực tế còn có bộ đệm trình duyệt và hệ điều hành.
- Tiến độ bằng tổng byte đã ghi của các kênh chia cho kích thước file. Bên
  gửi dùng số byte từ ACK. Khi máy nhận ghi đủ byte và nhận đủ `END`, giao
  diện chuyển sang **Đang xác minh**, rồi **Đang lưu**. File rỗng chuyển
  theo trạng thái phiên.

## 4. Ghi, xác minh và xác nhận lưu

1. Ghi vào một file tạm trong OPFS, vùng lưu trữ riêng của website trên máy
   nhận. Dùng một writer và ghi theo offset tuyệt đối. Nếu kênh cuối đến
   trước, ghi luôn khối đó vào đúng phần cuối file.
   [Vùng lưu trữ OPFS](https://fs.spec.whatwg.org/#sandboxed-filesystem) · [Ghi theo vị trí byte](https://fs.spec.whatwg.org/#dom-filesystemwritablefilestream-write)
2. Khi mọi kênh đã có `END`, số byte của từng khoảng đã đủ và hàng đợi ghi
   đã rỗng, đóng writer file tạm. ACK xác nhận thao tác ghi từng khối.
   Việc đóng writer thành công xác nhận các thay đổi của file tạm.
   [Quy tắc ghi và đóng writer](https://fs.spec.whatwg.org/#api-filesystemwritablefilestream)
3. Đọc lại file tạm theo thứ tự từ đầu đến cuối và tính **SHA-256 của cả
   file** bằng bộ băm cập nhật theo từng khối. Máy gửi dùng cùng cách khi
   đọc file gốc. Với cách này, hai bên chỉ cần đọc một phần file tại mỗi
   thời điểm. [API `digest()` của Web Crypto](https://w3c.github.io/webcrypto/#SubtleCrypto-method-digest)
4. Khi hash và kích thước khớp, chép file đã xác minh theo từng khối vào file
   người dùng chọn. Người dùng có thể đổi tên nhưng giữ đuôi, hoặc xác nhận thay thế file
   cũ ngay trong hộp Lưu thành; app không tự đổi tên. Đóng file
   đích thành công rồi ghi nhận kết quả lưu trên máy nhận. Gọi
   `CompleteFile` với kích thước và SHA-256 để xác nhận cho cả phiên, sau
   đó dọn file tạm.

Nếu một kênh bị rớt trong lúc truyền, ổ đĩa báo lỗi hoặc SHA-256 lệch, dừng
cả phiên, đóng các kênh, hủy writer đích và dọn file tạm OPFS. Không xóa file
đích vì đó có thể là file đã tồn tại của người dùng; hủy writer giữ nguyên
nội dung cũ. File đích mới có thể còn rỗng nếu picker đã tạo nó.
Bản đầu cho gửi lại từ
đầu. Nếu file đã lưu nhưng chưa nhận phản hồi `CompleteFile`, giữ file và
hiện **Đã lưu trên máy, chưa xác nhận với máy chủ**. Khi kết nối trở lại,
dùng lịch sử file để kiểm tra máy chủ đã ghi nhận phiên hoàn tất hay chưa.
[API lịch sử file](../PBL4/Controllers/FilesController.cs)

Tận dụng hạn phiên hiện tại gồm 60 giây cho lời mời, 45 giây từ lúc chấp
nhận đến khi bắt đầu và 30 phút cho truyền, xác minh, lưu. Trong lúc truyền
dữ liệu, phát hiện đình trệ dựa trên số byte đã ghi hoặc đã ACK. Khi chuyển
sang xác minh và lưu, theo dõi các thao tác đọc và ghi của giai đoạn đó.

Trạng thái **Đang chờ đồng bộ** cần cơ chế gửi lại xác nhận sau khi đổi kết
nối. Để bổ sung, lưu biên nhận ở máy nhận và lưu trạng thái chờ xác nhận
ở máy chủ. Cho phép gửi lại cùng biên nhận theo `TransferId` từ đúng người
nhận, trong hạn xác nhận. Mỗi phiên chỉ được ghi nhận hoàn tất một lần.
Bản một kênh dùng quy tắc xác nhận hiện tại.
[Điều kiện xử lý trạng thái ở backend](../PBL4/Services/FileTransferService.cs)

## 5. Đo và chọn số kênh

- Dùng cùng hai máy, trình duyệt, file, cách ghi, SHA-256 và tổng hạn mức
  512 KiB. Đo với file 100 MiB và thêm file 10 MiB để xem ảnh hưởng thời gian
  mở kênh. Chạy từng phiên riêng, đổi thứ tự cấu hình giữa các lượt, chạy
  một lượt làm nóng và tối thiểu năm lượt lấy số cho mỗi cấu hình.
- Tách kết quả **LAN trực tiếp** và **qua TURN**. Dùng `getStats()` để
  kiểm tra loại candidate của cặp ICE đã chọn. Lượt trực tiếp dùng cặp
  không qua relay. Lượt TURN đặt chính sách ICE thành `relay` và kiểm tra
  có candidate loại `relay`. Ghi riêng lượt đổi đường truyền khi đang đo.
  [Cấu hình ICE relay](https://w3c.github.io/webrtc-pc/#rtcicetransportpolicy-enum) · [Thống kê WebRTC](https://www.w3.org/TR/webrtc-stats/)
- Dùng đồng hồ của máy nhận. Chỉ số chính là **từ ngay trước `AcceptFile`
  đến khi đóng file đích thành công**, tính cả kết nối, xác minh và lưu.
  Đo thêm thời gian từ khối đầu đến khi ghi xong khối cuối để tính MiB/s,
  thời gian xác minh và chép file, RAM đỉnh ở hai máy và số lượt lỗi. Đo
  riêng thời gian máy gửi tính hash trước lời mời. Có thể so `file-v1`
  với `file-v2` một kênh để biết mức RAM thay đổi.

| Đường truyền | File | Số kênh | Thời gian đến khi lưu, trung vị và khoảng đo | Tốc độ truyền, MiB/s | RAM đỉnh gửi/nhận | Lượt thành công |
| --- | --- | --- | --- | --- | --- | --- |
| LAN hoặc TURN | 10 hoặc 100 MiB | 1, 2, 3 hoặc 4 | Điền sau khi đo | Điền sau khi đo | Điền sau khi đo | Điền sau khi đo |

Chọn số kênh có thời gian lưu thấp nhất trong các cấu hình truyền đúng và ổn
định. Nếu chênh lệch nằm trong mức dao động giữa các lượt, đo lại các cấu
hình sát nhau và ưu tiên ít kênh hơn khi kết quả tương đương. Có thể thử
một tổng hạn mức khác nếu đường có độ trễ cao thường xuyên làm máy gửi chờ
ACK. Trong mỗi loạt đo mới, mọi số kênh vẫn dùng cùng tổng hạn mức.

## 6. Tiêu chí nghiệm thu

- Gửi từ Chat và nhận từ cả Chat lẫn Tệp. Thử file rỗng, đúng 16 KiB, 16 KiB
  + 1 byte, đúng 100 MiB và file lớn dùng v3. Đối chiếu dung lượng/SHA-256.
  Kiểm tra cảnh báo ở 1 GiB + 1 byte, không cảnh báo đúng 1 GiB; Hủy không
  tạo lời mời. Kiểm tra offset qua 4 GiB, nhận đúng giới hạn 10 GiB và từ
  chối 10 GiB + 1 byte. Ghi rõ ca nào dùng dữ liệu ảo, ca nào truyền đĩa thật.
- Với 3 kênh, kiểm tra trường hợp chia số khối có dư. Cho kênh cuối ghi xong
  trước kênh đầu. Phiên chỉ sang xác minh khi mọi khoảng đã ghi đủ.
- Làm chậm writer. Khi đầy hạn mức, máy gửi chờ ACK rồi tiếp tục. Lượng
  dữ liệu trong hàng đợi ghi giữ trong hạn mức của phiên.
- Thử rớt kênh, gửi sai offset, sai hash, hết chỗ ghi, hết hạn lời mời và
  trùng tên file đích. Kiểm tra trạng thái ở hai máy và file thực tế trong
  thư mục đích. Chọn tên mới phải giữ nguyên file cũ. Khi chọn thay thế,
  file cũ chỉ đổi sau khi xác minh và lưu thành công; lỗi hoặc hủy trong
  lúc truyền/lưu phải giữ nguyên nội dung cũ.
- Thử mất kết nối sau khi file đã lưu, trước khi có phản hồi xác nhận. File
  đã xác minh vẫn mở được và giao diện hiển thị đúng tình trạng xác nhận.
- Thử cặp tab có một bên chỉ hỗ trợ `file-v1`: file <=100 MiB dùng luồng
  **Tải xuống**, mỗi file vẫn có một phiên. File lớn không được chuyển
  sang Blob; từ chối trước khi nhận nếu thiếu API ghi đĩa hoặc quota tạm.

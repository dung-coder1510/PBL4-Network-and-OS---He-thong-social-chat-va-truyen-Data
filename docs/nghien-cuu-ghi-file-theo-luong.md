# Ghi file theo luồng trong WebRTC

Đây là nghiên cứu trước khi triển khai ghi đĩa. Từ 14–15/11/2026, bản một
kênh đã nâng giới hạn lên 10 GiB với `file-v3`, cảnh báo khi trên 1 GiB;
v1/v2 giữ mức 100 MiB. Xem [hiện trạng và kiểm thử](file-transfers.md).

Đề xuất cho PBL4 là ghi các khối WebRTC xuống đĩa ngay khi nhận, cập nhật SHA-256 theo từng khối và giới hạn lượng dữ liệu bên gửi có thể gửi trước khi bên nhận ghi xong. Thử trên Chrome và Edge desktop với giới hạn **100 MiB/file** hiện tại. Sau đó đo RAM và kiểm tra lại kết nối trực tiếp lẫn TURN trước khi cân nhắc tăng dung lượng. [API ghi file](https://fs.spec.whatwg.org/#api-filesystemwritablefilestream) · [Giới hạn file của backend](../PBL4/Services/FileTransferService.cs)

## Luồng hiện tại

- **Bên gửi** đọc toàn bộ file bằng `file.arrayBuffer()` để tính SHA-256 trước khi gửi lời mời. Khi DataChannel mở, bên gửi đọc và gửi từng khối tối đa 16 KiB, kèm 4 byte chỉ số thứ tự. [Code gửi file](../frontend/src/services/fileTransfers.js) · [Định dạng khối](../frontend/src/services/fileProtocol.js)
- **Bên nhận** giữ từng khối trong mảng, tạo `Blob` khi đủ byte, rồi gọi `blob.arrayBuffer()` để tính SHA-256. Nút tải hiện sau khi `CompleteFile` thành công. Bộ nhớ chứa dữ liệu vì thế tăng theo kích thước file, kể cả khi kích thước từng khối truyền vẫn nhỏ. [Code nhận file](../frontend/src/services/fileTransfers.js) · [Đặc tả `Blob.arrayBuffer()`](https://w3c.github.io/FileAPI/#dom-blob-arraybuffer)
- **Backend** ghi thông tin phiên, quản lý quyền và làm báo hiệu qua SignalR. Nội dung file đi qua kênh WebRTC. Hiện tại người nhận bấm Tải xuống để lưu file ra đĩa. ICE chọn đường trực tiếp hay qua TURN trong lúc truyền. Bước lưu file chạy tại trình duyệt người nhận. [Luồng gửi file hiện tại](file-transfers.md) · [WebRTC DataChannel và DTLS](https://www.rfc-editor.org/rfc/rfc8831.html#section-5)

## Luồng đề xuất

1. **Chọn thư mục từ nút Nhận file.** Cả nút trong Chat và nút Chấp nhận ở trang Tệp gọi chung một thao tác. Gọi `showDirectoryPicker({ mode: 'readwrite' })` từ sự kiện bấm nút, trước khi chờ request hoặc gọi `AcceptFile`, để trình duyệt nhận được thao tác người dùng. Kiểm tra API trong ngữ cảnh HTTPS, rồi xử lý trường hợp người dùng đóng hộp thoại hoặc quyền ghi bị từ chối. [Đặc tả chọn thư mục](https://wicg.github.io/file-system-access/#api-showdirectorypicker) · [Tài liệu Chrome về thao tác người dùng](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
2. **Chấp nhận phiên sau khi có quyền ghi.** Lưu handle thư mục theo mã phiên ở tab nhận trước khi gọi Hub, vì thông báo `FileChanged` có thể tới trước khi lời gọi Hub trả kết quả. Đọc lại trạng thái và version của lời mời. Nếu hết hạn trong lúc chọn thư mục, báo người gửi tạo lời mời mới. Backend hiện cho lời mời 60 giây. Sau khi phiên được chấp nhận, tạo file tên mới trong thư mục và mở `createWritable()`. Chỉ gửi tín hiệu sẵn sàng qua DataChannel sau khi mở writer thành công. [UI Chat](../frontend/src/components/chat/FileMessageCard.jsx) · [UI Tệp](../frontend/src/pages/FilesPage.jsx) · [Quản lý phiên và thời hạn](../PBL4/Services/FileTransferService.cs)
3. **Ghi tuần tự và tính SHA-256.** Kiểm tra số thứ tự và độ dài như luồng hiện tại. Lấy phần nội dung sau 4 byte chỉ số, chờ `write()` hoàn tất, cập nhật SHA-256 và tiến độ rồi giải phóng khối. Xử lý khung kết thúc sau khi mọi lần ghi trước đó đã hoàn tất. Ở bên gửi, đọc theo luồng hoặc theo lát để tính SHA-256 trước lời mời. Dùng một trạng thái SHA-256 cập nhật nhiều lần và lấy kết quả một lần, ví dụ `sha256.create().update(...).digest()` của `@noble/hashes`. `crypto.subtle.digest()` nhận một buffer đầy đủ mỗi lần gọi. Giữ kết quả SHA-256 của toàn bộ byte nội dung để backend vẫn đối chiếu được. [File API](https://w3c.github.io/FileAPI/#dom-blob-stream) · [Web Crypto `digest()`](https://w3c.github.io/webcrypto/#SubtleCrypto-method-digest) · [API cập nhật SHA-256 của noble-hashes](https://github.com/paulmillr/noble-hashes)
4. **Xác minh rồi hoàn tất file.** Sau khi nhận khung kết thúc, kiểm tra tổng byte, hash và trạng thái `transferring`. Chờ `close()` thành công để hoàn tất file trên máy, rồi gọi `CompleteFile` với số byte và hash đã xác minh. Khi hủy, ngắt mạng, hết chỗ ghi hoặc hash lệch trước khi hoàn tất, đóng phiên và `abort()` writer. Dọn mục rỗng do phiên tạo nếu app xác định được đó là file mới của chính phiên. Nếu `close()` thành công nhưng mất kết nối lúc gọi Hub, file đã lưu và trạng thái server có thể cần đồng bộ lại. UI Chat và Tệp cần hiển thị rõ hai kết quả này, đồng thời phân biệt file đã lưu trên máy với file còn nút tải từ Blob. [Ngữ nghĩa đóng writer](https://fs.spec.whatwg.org/#dom-filesystemfilehandle-createwritable) · [Xác nhận phiên hiện tại](../frontend/src/services/fileTransfers.js)

**Lý do chọn thư mục.** `showSaveFilePicker()` của Chromium có thể tạo file rỗng hoặc làm rỗng file cũ ngay khi người dùng xác nhận tên. Vì thao tác đó xảy ra trước khi tạo writer, việc hủy writer sau đó không khôi phục dữ liệu cũ. Với cách chọn thư mục, app có thể tạo file tên mới sau khi chấp nhận phiên. Dùng tên file hợp lệ và hậu tố ngẫu nhiên khi cần, tránh chọn trùng tên đã có. `getFileHandle(name, { create: true })` có thể trả về file đã tồn tại, nên kiểm tra va chạm tên và chỉ dọn file do phiên tạo. [Đặc tả Save As](https://wicg.github.io/file-system-access/#api-showsavefilepicker) · [Mã Chromium tạo và làm rỗng file](https://chromium.googlesource.com/chromium/src/+/main/content/browser/file_system_access/file_system_access_manager_impl.cc) · [Đặc tả `getFileHandle()`](https://fs.spec.whatwg.org/#dom-filesystemdirectoryhandle-getfilehandle)

## Giữ bộ nhớ ổn định khi ổ đĩa ghi chậm

`bufferedAmount` hiện tại giúp bên gửi giới hạn hàng đợi WebRTC cục bộ. Giá trị này giảm khi transport lấy dữ liệu khỏi hàng đợi gửi. Để theo tốc độ ghi đĩa, thêm cửa sổ byte chưa được bên nhận xác nhận. [Đặc tả `bufferedAmount`](https://w3c.github.io/webrtc-pc/#dom-datachannel-bufferedamount) · [Giới hạn buffer bên gửi hiện tại](../frontend/src/services/fileProtocol.js)

- Bên nhận báo sẵn sàng và cấp cửa sổ ban đầu, ví dụ **256 KiB** để thử. Bên gửi chỉ gửi khối tiếp theo nếu `bytesSent - bytesAcked + chunkLength <= windowBytes` và buffer WebRTC bên gửi còn chỗ.
- Bên nhận gửi **ACK cộng dồn** sau khi `write()` hoàn tất, ví dụ sau mỗi 64 KiB và sau khối cuối. Số byte ACK là số byte nội dung writer đã tiếp nhận thành công. Bên gửi kiểm tra ACK là số nguyên an toàn, tăng dần và nằm trong số byte đã gửi. Bên nhận chặn dữ liệu vượt cửa sổ và hủy phiên nếu peer vi phạm.
- Một hàng đợi ghi xử lý từng khối theo thứ tự. Dùng số byte ACK để hiển thị tiến độ phía gửi và kiểm tra timeout khi ổ đĩa hoặc đường truyền bị chậm. 256 KiB là điểm bắt đầu thử nghiệm cho dữ liệu chưa ACK, còn RAM thực tế gồm cả bộ đệm trình duyệt, hệ điều hành và phần triển khai. Cửa sổ phù hợp cần đo trên đường truyền có độ trễ khác nhau, đặc biệt qua TURN.

### Tương thích với bản đang dùng

Tab gửi của `file-v1` coi mọi thông điệp từ tab nhận là lỗi. Có thể thêm `file-v2` cho luồng có thông điệp sẵn sàng và ACK. Bên gửi và bên nhận khai báo hỗ trợ qua thông tin lời mời và chấp nhận. Backend chọn phiên bản trong registry endpoint đang hoạt động và gửi cùng `FileChanged`. Khi một đầu thiếu khả năng mới, giao diện dùng luồng Blob hiện tại trong giới hạn 100 MiB và hiển thị đúng cách lưu trước khi nhận. Việc ghi streaming cần cập nhật cả hai tab vì ACK thay đổi giao thức truyền. [Kiểm tra nhãn và khung ở `attachChannel()`](../frontend/src/services/fileTransfers.js) · [Registry endpoint và DTO phiên](../PBL4/Services/FileTransferService.cs)

## Các cách lưu trên trình duyệt

| Cách | Phù hợp với |
| --- | --- |
| Ghi vào thư mục người dùng chọn | Lựa chọn thử nghiệm đầu tiên trên Chrome và Edge desktop. Kiểm tra `isSecureContext` và API ở máy nhận. Mỗi phiên có file đầu ra ngay trong thư mục đã chọn sau khi writer đóng thành công. [Tài liệu Chrome](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access#browser_support) · [API chọn thư mục trên Edge](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/fileordirectorypickerwithoutgestureallowedfororigins) |
| Ghi tạm vào OPFS | Trường hợp muốn xác minh xong rồi mới cho người dùng xuất file. OPFS là vùng lưu trữ riêng của website trên máy, có hạn mức và cần dọn file tạm. Bước xuất sang thư mục cá nhân cần được kiểm thử riêng về tương thích và RAM. [File System Standard về vùng lưu trữ riêng](https://fs.spec.whatwg.org/#sandboxed-filesystem) |
| Blob và nút Tải xuống hiện tại | Phương án cho trình duyệt thiếu API chọn thư mục hoặc máy còn dùng giao thức cũ. Bộ nhớ dữ liệu vẫn tăng theo dung lượng file. [Code nhận Blob](../frontend/src/services/fileProtocol.js) |

## Kiểm chứng trước khi nâng dung lượng

- Gửi file rỗng, file vừa qua ranh giới 16 KiB và file 100 MiB. Đối chiếu kích thước và SHA-256 của file thực tế trên đĩa, ví dụ với PowerShell `Get-FileHash -Algorithm SHA256`. Thử nhận từ cả Chat và Tệp. [Kiểm thử giao thức hiện có](../tests/file-protocol.mjs) · [Kiểm thử gửi file trong Chat](../tests/chat-files.e2e.mjs)
- Mô phỏng writer chậm. Kiểm tra hàng đợi nhận giữ trong giới hạn cửa sổ, tiến độ phía gửi dừng khi hết cửa sổ rồi tiếp tục khi ACK đến. Đo bộ nhớ tiến trình trình duyệt và dung lượng hàng đợi ở nhiều cỡ file, kể cả lúc hash và khi nhận hai phiên đồng thời.
- Thử hủy chọn thư mục, lời mời hết hạn, tên trùng, hết dung lượng, mất mạng khi đang ghi, sai SHA-256 và mất kết nối ngay sau `close()`. Kiểm tra file cũ vẫn còn nguyên, file lỗi không được báo đã lưu và UI phân biệt lỗi lưu với lỗi đồng bộ trạng thái.
- Thử kết nối trực tiếp và cấu hình thử chỉ cho ICE qua TURN. Dùng thống kê WebRTC xác nhận cặp đang dùng có candidate loại `relay` trong lượt TURN. Kiểm tra các mốc timeout hiện tại, gồm tối đa 30 phút từ lúc backend chuyển sang `transferring`, trước khi thử file vượt 100 MiB. [Cặp ICE đang dùng](https://www.w3.org/TR/webrtc-stats/) · [Deadline và giới hạn backend](../PBL4/Services/FileTransferService.cs)

Đây là thiết kế nghiên cứu dựa trên code và đặc tả. Cần chạy thử trên trình duyệt và đo RAM để xác nhận mức sử dụng thực tế.

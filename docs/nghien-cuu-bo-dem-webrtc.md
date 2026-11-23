# Thử tăng đệm gửi và cửa sổ ACK WebRTC

Ngày đo: 21/11/2026. Mỗi MB trong báo cáo là 1.000.000 byte.

## Kết quả và quyết định

Trong đợt đo này, cấu hình đang dùng nhanh hơn các cấu hình đệm lớn đã thử.
Giữ đệm gửi 1.048.576 byte, cửa sổ ACK ban đầu 2.097.152 byte và khả năng
tăng cửa sổ đến 8 MB theo thương lượng. Tham số đệm của bản chính không đổi;
lựa chọn số kết nối được cập nhật ở mục bên dưới.

Đệm gửi 32 MB với cửa sổ ACK 64 MB làm Chrome từ chối gửi vì hàng đợi đầy.
Đệm 16 MB với ACK 32 MB truyền xong nhưng chậm hơn cấu hình hiện tại.
Kết quả không xác định cấu hình nhanh nhất trên hai thiết bị, LAN hoặc TURN.

## Cách đo

Hai context Chrome riêng trên cùng máy, một RTCPeerConnection và một
DataChannel reliable, ordered. Lấy 110.000.000 byte đầu của cùng file
`C:\Users\nguye\Downloads\wiremess-speed-test-2gb.bin`. Dùng nguồn đọc/băm
Worker, bộ gửi/nhận thực và writer OPFS của ứng dụng. Tính thời gian từ lúc
kênh nhận mở đến khi ghi, xác minh SHA-256 và close writer xong.

Các thay đổi chỉ áp dụng bằng interception trong trình duyệt thử. Ba tệp
`fileStreamProtocol.js`, `fileFlowControl.js`, `fileProtocol.js` vẫn có
SHA-256 giống bản chụp trước đợt đo. Không dùng SQL hoặc tài khoản thật.

Cửa sổ trên 8 MB và khối trên 16.384 byte là nguyên mẫu hai đầu cùng sửa,
chưa phải khả năng tương thích của bản chính. Trước khi triển khai cần
thương lượng với tab cũ, vốn từ chối các kích thước ngoài giới hạn hiện tại.

## Số đo

Cửa sổ “tự điều chỉnh” bắt đầu ở 2,10 MB và được phép tăng đến 8 MB.
Các dòng “cố định” giữ sàn bằng trần của cửa sổ trong phép thử.
Ngưỡng thấp là mức bufferedAmount để đánh thức sender nạp tiếp.

| Cấu hình | Đệm gửi MB | Ngưỡng thấp MB | Cửa sổ ACK MB | Tốc độ MB/s |
| --- | ---: | ---: | --- | ---: |
| Hiện tại, lượt đầu | 1,048576 | 0,065536 | Tự điều chỉnh | 2,93 |
| Hiện tại, lượt đối chiếu | 1,048576 | 0,065536 | Tự điều chỉnh | 2,81 |
| Commit a539676, đối chứng cùng đợt | 1,048576 | 0,065536 | 2,10 cố định | 2,73 |
| Nạp tiếp sớm hơn | 1,048576 | 0,524288 | Tự điều chỉnh | 2,78 |
| Gửi 2 MB | 2 | 1 | Tự điều chỉnh | 2,55 |
| Gửi 4 MB | 4 | 2 | Tự điều chỉnh | 2,69 |
| Gửi 2 MB, ACK 8 MB | 2 | 1 | 8 cố định | 2,53 |
| Gửi 4 MB, ACK 8 MB | 4 | 2 | 8 cố định | 2,60 |
| Gửi 8 MB, ACK 8 MB | 8 | 4 | 8 cố định | 2,58 |
| Gửi 16 MB, ACK 32 MB | 16 | 8 | 32 cố định | 2,48 |
| Gửi 32 MB, ACK 64 MB | 32 | 16 | 64 cố định | Lỗi đầy hàng đợi |
| Gửi 4 MB, giữ ngưỡng thấp cũ | 4 | 0,065536 | Tự điều chỉnh | 2,52 |
| Gửi 8 MB, giữ ngưỡng thấp cũ | 8 | 0,065536 | 8 cố định | 2,55 |
| Khối 32.768 byte | 4 | 2 | 8 cố định | 2,66 |
| Khối 65.536 byte | 4 | 2 | 8 cố định | 2,54 |

Mọi lượt truyền hoàn tất trong bảng đều xác minh SHA-256 thành công.
Phần lớn cấu hình mới chỉ có một lượt đo; hai lượt nền dùng để đối chiếu
dao động trong cùng đợt. Chưa có bằng chứng để đưa một mức đệm lớn hơn vào
bản chính vì mục tiêu tăng tốc.

Đợt này có mức nền thấp hơn 4,90–5,78 MB/s ở lượt sửa hồi quy trước đó,
dù ba tệp nguồn trên giữ nguyên. Chưa xác định nguyên nhân mức nền thay
đổi. Đo thêm đúng mã commit a539676 trong cùng điều kiện hiện tại cũng chỉ
đạt 2,73 MB/s, SHA-256 khớp; lượt này không cho thấy bản hiện tại chậm hơn
commit cũ. Chỉ đối chiếu các cấu hình trong cùng đợt, không gộp hai đợt để
tính phần trăm tăng hoặc giảm của mã nguồn.

## Tách thời gian ghi và băm phía nhận

Một lượt chẩn đoán bỏ writer và SHA-256 phía nhận đạt 2,96 MB/s. Lượt này
không lưu hoặc xác minh file và không được coi là ứng viên thay thế luồng
truyền thật. Nó cho thấy bỏ ghi/băm phía nhận chưa làm thông lượng tăng
nhiều trong điều kiện đo này.

Ở cấu hình hiện tại, sender ghi nhận 32,47–34,35 giây chờ đệm trong các
lượt kéo dài 37,51–39,15 giây; thời gian chờ ACK là 0. Khi đệm gửi và ACK
cùng ở 8 MB, thời gian chờ chuyển chủ yếu sang ACK, còn tổng thời gian
không giảm. Tăng hạn mức đã chuyển vị trí chờ, chưa tăng thông lượng.
Chưa xác định nguyên nhân sâu hơn trong SCTP, lịch chạy hoặc đường UDP.

## Ý nghĩa của giới hạn

`bufferedAmount` đo byte ứng dụng đã xếp vào DataChannel, không bao gồm
toàn bộ bộ đệm hệ điều hành và phần cứng. Thay ngưỡng trong JavaScript
không trực tiếp thay toàn bộ bộ đệm hoặc điều tiết tắc nghẽn bên dưới.
Chuẩn cho phép `send()` ném `OperationError` khi thiếu chỗ trong hàng đợi.
[WebRTC của W3C](https://www.w3.org/TR/webrtc/#dom-rtcdatachannel-bufferedamount)

Các DataChannel trên cùng SCTP association chia sẻ cơ chế điều tiết tắc
nghẽn. Không suy ra số kênh hoặc số byte chờ lớn hơn sẽ tăng tốc tương ứng.
[RFC 8831, mục 5](https://www.rfc-editor.org/rfc/rfc8831.html#section-5)

## Bằng chứng cục bộ

Thư mục thử riêng, không đưa vào Git:

`D:/PBL4_Code/.tmp/rtc-buffer-20261121-1795264654388`

`matrix-results.json` chứa vòng đầu; `matrix-results-2.json` chứa lượt đối
chiếu và các thử bổ sung. Hai lần thử 32/64 MB ban đầu bị công cụ đo từ chối
do chưa thay được hằng số cap sau Vite transform; đã sửa công cụ và chạy
lại. Chỉ lượt 32 MB ACK thành công và lỗi hàng đợi 64 MB ACK sau khi sửa
công cụ được dùng trong bảng trên.

Mỗi cấu hình có log và trace riêng. Browser thử đã đóng sau mỗi lượt.
Ở đợt thử đệm phía trên, tham số đệm và cấu hình server được giữ nguyên.

## Cập nhật lựa chọn mặc định tự động

Đã đổi frontend để chế độ thường ưu tiên hai kết nối riêng cho file lớn
khi backend hỗ trợ, đồng thời giữ một kết nối cho file nhỏ hoặc máy chủ cũ.
Chế độ nhà phát triển vẫn ghi đè bằng lựa chọn thủ công. Không tăng đệm
gửi hoặc cửa sổ ACK. Cấu hình Windows của người dùng không được thay đổi.

Đã đo thêm qua đăng nhập, tạo lời mời, nhận file, ghi và kiểm tra SHA-256
của giao diện thật. Hai kết nối với tham số gốc có ba lượt 110 MB đạt
6,77; 6,92; 6,77 MB/s. Một lượt một kết nối xen giữa đạt 6,28 MB/s.
Các lượt một kết nối ở giai đoạn khác cũng có mức 2,68–3,94 MB/s.

Ở bản mặc định cuối, thao tác chọn file được thực hiện qua nút Gửi file
và file chooser. File 80 MB giữ v2/một kết nối, đạt 2,71 MB/s; file 110 MB
tự dùng v6/hai kết nối, đạt 3,00 MB/s; file 330 MB tự dùng v6/hai kết nối,
đạt 2,89 MB/s. Mọi file đều khớp SHA-256. Vì vậy, các lượt nhanh trước đó
không đủ để khẳng định mức 6,8 MB/s ổn định. Chưa xử lý dứt điểm nguyên nhân
dao động theo thời điểm và môi trường chạy.

Các thử nghiệm bổ sung không được đưa vào bản chính: kiểm tra đệm định kỳ
20/50 ms; đệm gửi nhỏ hơn; lô ghi/ACK 64/128 KB; giảm tần suất cập nhật giao
diện; tắt thống kê; bỏ ICE server; đổi File sang Blob trước khi gửi vào
Worker. Blob có một lượt đạt 4,84 MB/s nhưng hai lượt lặp lại chỉ đạt
2,70 và 2,66 MB/s. Chưa có bằng chứng cải thiện ổn định cho thay đổi này.

Một lượt chỉ định nhóm CPU hiệu năng cao cho browser thử đạt 6,11 MB/s.
Can thiệp chỉ tác động browser thử, đã mất khi browser đóng; chưa xác định
được lịch chạy từng thread để quy toàn bộ dao động cho CPU. Không có thay
đổi affinity, power plan hoặc ưu tiên của browser người dùng.

Bằng chứng mới nằm trong thư mục riêng:

`D:/PBL4_Code/.tmp/rtc-stability-20261121-1795268936324/app`

`repeat-parallel.log`, `paired-source.log` và
`real-app-normal-final-automatic-0-results.json` lưu các lượt đối chiếu.
`tests/file-offer-policy.mjs` kiểm tra DTO thực của lời mời, khả năng tương
thích và ưu tiên thủ công; `tests/file-flow.e2e.mjs` kiểm tra mặc định mới
qua Chrome thật với cơ sở dữ liệu thử riêng.

# Giảm thời gian chờ tải xuống trên máy chủ hiện tại

Đối chiếu nguồn ngày 20/11/2026, bổ sung kết quả thử ngày 21/11/2026. Giữ máy chủ Wiremess tại AWS Sydney. Dung lượng dùng MB thập phân, 1 MB bằng 1.000.000 byte. Các kết quả dưới đây thuộc máy Windows và thời điểm thử, chưa đại diện mọi nhà mạng.

## Bằng chứng đã đo

Phép thử độc lập 110 MB trong trình duyệt cho upload **19,74 MB/s**, download kèm ghi file và SHA-256 **3,72 MB/s**. Trong tổng **29,59 giây** tải xuống, `read()` chờ stream khoảng **25,07 giây**, ghi file **2,08 giây**, phần xử lý giữa các lần đọc khoảng **1,72 giây**, chờ header khoảng **0,70 giây**. Số đo `read()` bao gồm việc chờ byte qua trình duyệt, proxy, máy chủ và mạng, chưa tự xác định chính xác đoạn nào chậm.

Download bỏ qua ghi đĩa và hash vẫn chỉ đạt khoảng **2,79–3,32 MB/s** qua endpoint .NET. File tĩnh 110 MB do Nginx phục vụ trực tiếp đạt **5,20 MB/s** trong một lượt. Endpoint kiểm tra tốc độ Cloudflare 32 MB đạt **33,68 MB/s**, không có `Content-Encoding`. Endpoint khác nhau có tuyến khác nhau, nên kết quả Cloudflare chỉ cho thấy máy này từng nhận nhanh hơn đáng kể ở tuyến khác.

Trong lúc Wiremess tải xuống, máy chủ đã có khoảng **2–4 MB** trong hàng đợi gửi, CPU khoảng **1%**, còn khoảng **2,5 GB** RAM. RTT khoảng **305–372 ms**. Một số mẫu cho thấy cửa sổ chống nghẽn TCP giảm từ khoảng **2,8 MB xuống 0,24 MB**, đồng thời lượng truyền lại tăng khoảng **1,4–2,8 MB mỗi 4 giây**. Bộ đếm vượt giới hạn băng thông, số gói của ENA và bộ đếm drop của qdisc không tăng trong các mẫu đó. Cửa sổ nhận mà máy Windows quảng bá khoảng **8,4 MB**.

**Suy luận từ các số đo** là TCP và tuyến truyền xuống đang đáng ưu tiên hơn tối ưu SHA-256 hoặc mua thêm RAM. Bộ đếm ENA bằng 0 chỉ loại trừ việc chạm các giới hạn đó trong khoảng lấy mẫu. Chưa xác định được router hay nhà mạng gây mất gói. [Ý nghĩa chỉ số ENA](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-network-performance-ena.html)

## 1. Thử BBR trên cùng máy chủ

Máy chủ đang dùng CUBIC trên kernel `7.0.0-1017-aws`. Đã tìm thấy module `tcp_bbr.ko.zst` có sẵn trong gói kernel. Tên module chưa đủ để kết luận BBR v2 hoặc v3. Khi báo kết quả cần ghi tên thuật toán thực tế `bbr`, kernel và gói đang chạy.

BBR ước lượng tốc độ giao hàng và RTT để điều tiết dữ liệu gửi. Đây là ứng viên đáng đo trên tuyến có RTT cao và truyền lại nhiều, nhưng mức tăng phụ thuộc điều kiện thực tế. Kernel hỗ trợ pacing nội bộ bằng timer khi không có qdisc `fq`, nên phép thử đầu có thể giữ nguyên `mq` và `fq_codel` để chỉ đổi thuật toán TCP. [Mã BBR của Linux 7.0](https://github.com/torvalds/linux/blob/v7.0/net/ipv4/tcp_bbr.c#L1-L56)

Đổi `net.ipv4.tcp_congestion_control` cần dùng kết nối TCP mới để đánh giá. Mã Linux 7.0 ưu tiên thuật toán do route chỉ định, sau đó lựa chọn được đặt rõ trên listener bằng `TCP_CONGESTION`, rồi mới dùng mặc định hệ thống. Vì vậy phải kiểm tra `ss -tin` trên kết nối Nginx 443 đang truyền thật. Chỉ nhìn giá trị sysctl chưa chứng minh lượt tải đang dùng BBR. [Cách kernel chọn thuật toán cho socket được accept](https://github.com/torvalds/linux/blob/v7.0/net/ipv4/tcp_minisocks.c#L467-L489)

Phép thử nên giữ nguyên qdisc, kích thước bộ đệm và code, chạy xen kẽ CUBIC → BBR → CUBIC với cùng endpoint và file. Mỗi lượt tạo kết nối mới, xác nhận thuật toán bằng `ss`, lấy MB/s, thời gian chờ đọc, RTT, retransmission và lỗi. Gắn bộ hẹn giờ khôi phục độc lập rồi khôi phục CUBIC sau thử nghiệm. Chỉ cân nhắc áp dụng lâu dài khi nhiều lượt lặp lại cùng cho lợi ích.

### Kết quả A/B đã thực hiện

Đã giữ nguyên IP Sydney, kernel `7.0.0-1017-aws`, `mq` với `fq_codel`, `tcp_wmem`, `tcp_rmem` và code. Nginx hoạt động xuyên suốt, không restart. Mỗi pha dùng một kết nối Chrome HTTPS mới. `ss` xác nhận thuật toán thực tế của socket 443 được accept, gồm cả hai pha BBR. Thứ tự đo tải 110 MB bỏ qua ghi đĩa và hash là CUBIC → BBR → BBR → CUBIC.

| Lượt | Thuật toán | Tổng thời gian | Tốc độ | Chờ đọc stream | Dữ liệu truyền lại | RTT mẫu |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | CUBIC | 63,45 giây | 1,734 MB/s | 63,13 giây | 17,137 MB | 313,1 ms |
| 2 | BBR | 13,64 giây | 8,065 MB/s | 13,29 giây | 0,001 MB | 302,7 ms |
| 3 | BBR | 13,99 giây | 7,862 MB/s | 13,64 giây | 0 MB | 304,0 ms |
| 4 | CUBIC | 37,45 giây | 2,938 MB/s | 37,13 giây | 7,338 MB | 316,3 ms |

Tổng dữ liệu truyền lại lấy từ bộ đếm TCP của kết nối được theo dõi. RTT là mẫu socket khi đo. Hai lượt mỗi thuật toán cho thấy lợi ích lớn, đồng thời hai lượt CUBIC vẫn chênh lệch nhiều. Kết quả này chưa đủ dự đoán mức tăng cố định theo mọi giờ và mọi nhà mạng.

Đã thử thêm qua chức năng chẩn đoán trong ứng dụng, gồm tải 110 MB, ghi file và SHA-256, với **một lượt mỗi thuật toán**.

| Thuật toán | Tổng thời gian tải và lưu | Tốc độ | Chờ đọc stream | Upload độc lập |
| --- | --- | --- | --- | --- |
| CUBIC | 46,12 giây | 2,38 MB/s | 40,96 giây | 17,31 MB/s |
| BBR | 14,90 giây | 7,38 MB/s | 9,55 giây | 18,20 MB/s |

Ứng dụng báo SHA-256 khớp. Trong cặp mẫu này, tốc độ tải và lưu tăng khoảng **3,10 lần**, thời gian chờ đọc giảm khoảng **76,7%**. Lợi ích xuất hiện trên cùng máy chủ, cùng một kết nối tải xuống, giữ nguyên nơi đặt máy chủ.

**Suy luận sau thử nghiệm** là cơ chế điều tiết TCP có ảnh hưởng đáng kể đến phần chờ dữ liệu trên tuyến đang kiểm tra. BBR đáng ưu tiên trước việc tăng số kết nối hay thay đổi cách ghi file. Vẫn nên đo thêm phiên dài và nhà mạng khác trước khi áp dụng rộng.

Sau phép thử, bộ điều khiển đã khôi phục mặc định TCP về **CUBIC** và xóa file thử trên máy chủ. Bộ hẹn giờ khôi phục độc lập 8 phút đã được đặt rồi dừng khi khôi phục chủ động hoàn tất. Không sửa file cấu hình lâu dài. Module BBR vẫn được nạp vì socket đã mở có thể còn dùng nó. Đổi mặc định về CUBIC không chuyển thuật toán của mọi socket đang tồn tại. Tài khoản thử đã được dọn hết. Các thay đổi thuật toán chỉ phục vụ phép đo, chưa triển khai BBR lâu dài.

## 2. Đo hai kết nối tải xuống

Phép thử file tĩnh Nginx 110 MB, cùng tổng dung lượng, cho kết quả sau.

| Số kết nối tải xuống | Tốc độ | Thời gian |
| --- | --- | --- |
| 1, lượt đầu | 1,80 MB/s | 61,03 giây |
| 2 | 4,84 MB/s | 22,73 giây |
| 4 | 4,27 MB/s | 25,76 giây |
| 1, lượt đối chứng cuối | 3,98 MB/s | 27,63 giây |

Có tín hiệu lợi ích khi tải song song, đồng thời kết quả một kết nối biến động mạnh. Chưa đủ số mẫu để kết luận hai kết nối luôn nhanh nhất. Các lượt này chưa gồm ghi đĩa và SHA-256.

**Ứng dụng hiện tại mới chia kết nối ở chặng A tải lên máy chủ. B vẫn tải xuống bằng một `GET`.** Thêm hai kết nối ở chặng xuống cần sửa giao thức, giữ tổng vùng đệm 4 MB, ghép đúng thứ tự, kiểm tra thiếu và trùng byte, hủy đồng bộ và SHA-256. Đây là đề xuất, chưa triển khai trong nghiên cứu này. Khi thử cần đếm số TCP thực tế vì nhiều request HTTP/2 có thể dùng chung một kết nối. [Mô hình kết nối HTTP/2](https://www.rfc-editor.org/rfc/rfc9113.html#section-2)

## 3. Chỉnh bộ đệm khi có bằng chứng thiếu cửa sổ

`tcp_wmem` đang có trần **4.194.304 byte** cho bộ đệm gửi được tự điều chỉnh. Có thể đo một mức cao hơn nếu `ss` cho thấy giới hạn bộ đệm gửi đang chặn tốc độ. Giữ nguyên các giá trị tối thiểu và mặc định, theo dõi RAM theo số phiên. [Ý nghĩa tcp_wmem](https://www.kernel.org/doc/html/latest/networking/ip-sysctl.html#tcp-variables)

Ví dụ mục tiêu **20 MB/s** với RTT **0,33 giây** cần khoảng **6,6 MB dữ liệu đang bay**, chưa tính chi phí bộ nhớ kernel. Cửa sổ chống nghẽn chỉ **0,24 MB** có thể giới hạn xấp xỉ **0,73 MB/s** ở cùng RTT, kể cả khi đã tăng bộ đệm. Đây là phép tính minh họa từ cửa sổ chia RTT, chưa phải dự báo tốc độ sau chỉnh. [Cửa sổ và BDP khi đo TCP](https://www.rfc-editor.org/rfc/rfc6349.html#section-3)

`tcp_mtu_probing=1` chỉ đáng thử khi có dấu hiệu lỗi Path MTU hay ICMP black hole. Chưa có bằng chứng xác nhận lỗi này trong các mẫu hiện tại. [Chế độ MTU probing](https://www.kernel.org/doc/html/latest/networking/ip-sysctl.html#tcp-variables)

## 4. Giảm thao tác ghi thừa ở máy chủ và trình duyệt

Relay đang gọi `WriteAsync` rồi `FlushAsync` sau từng khối tối đa 64 KB. Đối chiếu .NET 10.0.15 cho thấy đường ghi HTTP/1.1 với `Content-Length` đã flush trong `Http1OutputProducer.WriteAsyncInternal`. Bỏ lần flush thêm là một ứng viên tối ưu nhỏ. Nếu muốn gom nhiều khối trước flush cần thiết kế lại đường ghi có giới hạn và đo cả thời gian byte đầu. [Luồng ghi hiện tại](../PBL4/Services/FileRelayPipe.cs#L62) · [Kestrel chuyển Stream sang PipeWriter](https://github.com/dotnet/aspnetcore/blob/v10.0.15/src/Servers/Kestrel/Core/src/Internal/Http/HttpResponseStream.cs#L84-L90) · [Kestrel ghi và flush](https://github.com/dotnet/aspnetcore/blob/v10.0.15/src/Servers/Kestrel/Core/src/Internal/Http/Http1OutputProducer.cs#L521-L554)

Nginx đã tắt buffering ở route nội dung. Khi tắt, Nginx chuyển dữ liệu tới client ngay khi nhận được từ backend. Vì vậy cần đo trước khi đổi `proxy_buffer_size` hay gom ghi. Tăng buffering còn có thể phát sinh file tạm nếu cấu hình cho phép. [Quy tắc buffering của Nginx](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)

Phía nhận có thể thử hàng đợi nhỏ, có trần, để chồng việc đọc tiếp với ghi đĩa và băm theo thứ tự. Phép đo hiện tại gợi ý phần ghi và xử lý giữa các lần đọc khoảng **3,8 giây trên 29,6 giây**, nên đây là tối ưu bổ sung. Không thể coi toàn bộ thời gian chờ `read()` sẽ biến mất sau thay đổi này. Phải giữ kiểm tra SHA-256 trước trạng thái đã lưu, hủy được và giới hạn RAM.

## 5. HTTP/3 và tuyến qua điểm biên

**HTTP/3 trên cùng Nginx** là lựa chọn thử khi UDP 443 đi được. Cần bản Nginx có module HTTP/3, mở đúng UDP và xác nhận giao thức thực tế trong trình duyệt. QUIC vẫn có điều tiết nghẽn, nên với một stream file lớn mức tăng phải đo. Mạng chặn UDP vẫn cần HTTP chạy trên TCP. [Nginx HTTP/3](https://nginx.org/en/docs/http/ngx_http_v3_module.html) · [HTTP/3 khi UDP bị chặn](https://www.rfc-editor.org/rfc/rfc9114.html#section-3.1) · [Điều tiết nghẽn QUIC](https://www.rfc-editor.org/rfc/rfc9002.html#section-7)

**AWS Global Accelerator** giữ nguyên EC2 tại Sydney, nhận TCP tại điểm biên gần người dùng rồi tạo TCP mới tới EC2 qua mạng AWS. Cơ chế này có thể cải thiện tuyến và hiệu quả TCP dù backend giữ chỗ cũ. Cần đo với đúng nhà mạng đang chậm trước khi quyết định. [Cơ chế TCP split của AWS](https://docs.aws.amazon.com/global-accelerator/latest/dg/introduction-how-it-works.html#introduction-how-it-works-overview)

Giá niêm yết khi tra cứu gồm **0,025 USD/giờ cho mỗi accelerator**, phụ phí lưu lượng theo vùng và điểm biên, phí public IPv4 và chi phí truyền dữ liệu EC2 thông thường. Phần cố định khoảng **18 USD cho 30 ngày** trước các khoản khác, tính cả accelerator bị disable nhưng chưa xóa. Nghiên cứu này chưa tạo tài nguyên hay phát sinh dịch vụ đó. [Bảng giá Global Accelerator](https://aws.amazon.com/global-accelerator/pricing/)

## Thứ tự kiểm chứng

Phép thử A/B trên cùng máy chủ đã cho kết quả nghiêng rõ về BBR trong các mẫu hiện có. Bước tiếp theo là kiểm tra độ ổn định của BBR với phiên dài, rồi so một và hai kết nối tải xuống. Chỉ chỉnh bộ đệm khi thấy socket bị giới hạn bộ đệm, rồi kiểm tra phần ghi và flush. HTTP/3 dành cho mạng cho phép UDP. Global Accelerator là phương án có phí khi tối ưu TCP trên tuyến hiện tại chưa đủ.

Để đánh giá trước khi áp dụng rộng, nên mở rộng lên ít nhất ba lượt xen kẽ đối chứng mỗi phương án, cùng 110 MB rồi thêm file lớn, lấy trung vị và số lượt lỗi. Đây là khuyến nghị tăng độ tin cậy cho kết luận, không thay đổi số mẫu đã thực hiện phía trên. Chỉ tính thành công khi đủ byte, SHA-256 khớp và hoàn tất được ở cả hai phía. Báo riêng thời gian tới byte đầu, thời gian chờ đọc, thời gian ghi và thời gian xác nhận, để tránh nhầm khâu nào được cải thiện.

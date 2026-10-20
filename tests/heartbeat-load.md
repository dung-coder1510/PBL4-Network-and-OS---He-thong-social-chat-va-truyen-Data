# Kiểm tra tải heartbeat

Chạy ở thư mục gốc repository trên Windows, với SQL Server local và Node.js.
Script tự mở một backend Release tại `http://127.0.0.1:5255`; cổng này phải trống.
Không dùng backend đang mở của người dùng.

```powershell
dotnet build PBL4/PBL4.csproj -c Release
$env:AUTH_TEST_SQL_SERVER = 'localhost'
$env:AUTH_TEST_DATABASE = 'PBL4'
node tests/heartbeat.load.mjs
```

Backend dùng cấu hình kết nối database hiện tại trong `PBL4/appsettings.json`.
Các biến `AUTH_TEST_SQL_*` phải trỏ đến cùng database để chuẩn bị và dọn dữ liệu.
Chỉ hỗ trợ SQL Server mặc định trên máy local. Script không tạo database hoặc
chạy migration. Không chạy đồng thời nhiều lượt kiểm tra.

## Kịch bản

1. Tạo 1.000 tài khoản và chuỗi danh bạ riêng với prefix ngẫu nhiên. Một tài
   khoản seed được đăng ký qua API; các tài khoản còn lại sao chép password
   hash của seed bằng SQL, không đưa mật khẩu hoặc token vào kết quả đo.
2. Đăng nhập bằng API thật với các địa chỉ nguồn loopback khác nhau, mô phỏng
   nhiều máy mà không sửa hoặc tắt giới hạn đăng nhập theo IP. Giai đoạn này
   không dùng để kết luận khả năng chịu tải của đăng nhập.
3. Mở lần lượt 100, 500 và 1.000 WebSocket SignalR với tối đa 20 thao tác mở
   đồng thời. Mỗi kết nối thuộc một tài khoản khác nhau.
4. Giữ heartbeat 15 giây: đo 75 giây ở 100/500 kết nối và 90 giây ở 1.000.
   Mỗi tài khoản có tối đa hai người theo dõi trong chuỗi danh bạ.
5. Ở mức 1.000, dừng heartbeat của 10 tài khoản nhưng giữ socket mở. Kiểm tra
   cả 10 báo offline sau ít nhất khoảng một phút; các tài khoản vẫn gửi nhịp
   không được báo offline nhầm.
6. Gửi 1.000 heartbeat cùng lúc để đo tải dồn, đóng kết nối rồi theo dõi thêm
   65 giây cho tác vụ dọn presence. Phiên đăng nhập chưa hết hạn vẫn ở RAM.
7. Dừng backend thử và xóa đúng các liên hệ/tài khoản do lượt chạy tạo ra.

Script dừng tăng tải khi có 10 lỗi trong một giai đoạn, backend dừng, bộ nhớ
private backend vượt 1.536 MiB hoặc RAM vật lý trống dưới 1 GiB. Ngắt bằng
Ctrl+C sẽ đi qua bước dọn dẹp; buộc kết thúc tiến trình có thể để lại dữ liệu
thử và tiến trình backend, cần kiểm tra bằng prefix trong script/lượt chạy.

## Kết quả và cách đọc

Kết quả nằm trong `artifacts/heartbeat-load/<run-id>/`:

- `summary.md`: bảng tổng hợp.
- `results.json`: thống kê ACK, thời gian mở kết nối, tài nguyên và lỗi.
- `resources.jsonl`: mẫu tài nguyên của backend, SQL Server và máy tạo tải.
- `backend.log`: log của backend thử, giữ mức Warning.

CPU được chuẩn hóa trên toàn bộ logical processor của máy. Ví dụ máy 12
logical processor, một core chạy đầy tương đương khoảng 8,3% CPU toàn máy.
RAM có cả working set và private memory; đây không phải phép đo live heap.
CPU có giá trị null nếu tài khoản chạy thử không đọc được thời gian CPU của
tiến trình, ví dụ SQL Server chạy bằng tài khoản dịch vụ; không hiểu là 0%.
RAM không trở về mức đầu ngay sau khi đóng socket chưa chứng minh rò rỉ:
phiên đăng nhập, GC, pool và bộ cấp phát có thể còn giữ bộ nhớ.

Đây là phép đo heartbeat/presence trên localhost, với backend, SQL Server và
máy tạo tải cùng máy. Không suy rộng thành số người dùng tối đa, tải chat,
truyền file, độ trễ Internet hoặc hành vi nhiều instance server. Khả năng
đăng nhập hàng loạt và nhiều người theo dõi mỗi tài khoản cần kịch bản riêng.

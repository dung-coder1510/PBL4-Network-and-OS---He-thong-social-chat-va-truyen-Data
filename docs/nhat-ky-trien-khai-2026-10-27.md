# Nhật ký triển khai Wiremess — ngày 27/10/2026

Tài liệu ghi lại công việc trong ngày 27/10/2026 theo giờ Việt Nam,
dựa trên kết quả terminal, ảnh chụp và thông tin trao đổi trong phiên làm việc.
Trạng thái bên dưới là kết quả tại thời điểm kiểm tra, không phải giám sát liên tục.
Không lưu mật khẩu, khóa SSH hoặc JWT trong tài liệu này.

## 1. Tóm gọn những gì đã làm hôm nay

| Công việc | Kết quả |
| --- | --- |
| Kết nối lại AWS EC2 | SSH thành công sau khi xử lý giới hạn IP truy cập cổng 22. IP công khai đang dùng là `54.206.72.135`. |
| Kiểm tra backend và database đã triển khai trước đó | `mssql-server` và `pbl4` đều `active`; `/health/ready` trả `Healthy`. |
| Chuẩn bị công cụ build frontend | Cài Node.js `24.22.1`, npm `11.19.1` qua NVM. |
| Cài thư viện và build frontend | `npm ci`, lint và build thành công. |
| Xử lý cảnh báo thư viện frontend | Chạy `npm audit fix`; audit còn 0 lỗ hổng, lint 0 lỗi/0 cảnh báo, build lại thành công với Vite `8.3.5`. |
| Cài và chạy Nginx | Nginx hoạt động, được bật tự khởi động; kiểm tra HTTP nội bộ trả `200 OK`. |
| Đưa frontend lên thư mục phục vụ web | Sao chép `dist` sang `/var/www/pbl4/frontend`; user `www-data` đọc được `index.html`. |
| Cấu hình tên miền | Mua `wiremess.io.vn`, đặt bản ghi A về IP AWS, giữ bật bảo vệ OneShield. |
| Kiểm tra DNS và proxy | Đối chiếu nameserver, chờ bản ghi hoạt động; lưu lượng công khai đi qua proxy iNET. |
| Cấu hình Nginx cho ứng dụng | Phục vụ frontend, chuyển `/api/` và `/hubs/` tới backend `127.0.0.1:5000`, hỗ trợ WebSocket Upgrade. |
| Cấp HTTPS cho origin AWS | Cấp chứng chỉ Let's Encrypt bằng Certbot; bật HTTPS 443 trên Nginx và kiểm tra thành công. |
| Hoàn thiện HTTPS qua OneShield | Dùng Full (Strict); HTTPS công khai trả `200`, HTTP chuyển hướng sang HTTPS. |
| Thiết lập gia hạn chứng chỉ | Bật `certbot.timer`, tạo hook reload Nginx; mô phỏng gia hạn thành công. |
| Bật WebSocket trên OneShield | Công tắc WebSocket bật, giao diện báo đang hoạt động. |
| Chẩn đoán lỗi SignalR | Có phản hồi `101`, nhưng kết nối lỗi `Unrecognized frame opcode: 3` và đóng `1006`; chưa xác nhận nguyên nhân gốc. |
| Chuyển vấn đề cho iNET | Theo xác nhận đã nhận, ticket `#1793098398064` đã tạo, trạng thái `open`, ưu tiên `high`, đã gán kỹ thuật viên. |

**Kết quả cuối ngày:** frontend đã truy cập được bằng HTTPS tại
`https://wiremess.io.vn`; backend và SQL Server đã phản hồi tốt trong các lần
kiểm tra. Kết nối SignalR qua đường công khai vẫn gặp lỗi, đang chờ iNET xử lý.
Chưa thể kết luận toàn bộ chức năng chat/P2P trên Internet đã hoạt động ổn định.

## 2. Chi tiết những gì đã làm hôm nay

### 2.1. Kết nối lại server và kiểm tra nền tảng sẵn có

Server sử dụng AWS EC2 tại Sydney, vùng `ap-southeast-2`, chạy Ubuntu
`24.04.4 LTS`, kiến trúc `x86_64`, RAM khoảng `3.7 GiB`.

- IP công khai dùng trong phiên: `54.206.72.135`.
- IP riêng: `172.31.22.181`.
- Tài khoản SSH: `ubuntu`.
- Thư mục mã nguồn trên AWS: `/home/ubuntu/pbl4`.
- Nhánh trên AWS được kiểm tra là `Server`, theo dõi `origin/Server`.

Lúc đầu SSH báo timeout. Đã kiểm tra Security Group `launch-wizard-1`,
cập nhật nguồn truy cập SSH theo IP mạng hiện tại rồi kết nối lại thành công.
Sau khi IP công khai của EC2 thay đổi, SSH hỏi xác nhận host key ở địa chỉ mới;
đã đối chiếu thông tin khóa từng được lưu và hoàn tất kết nối.

Các kiểm tra sau khi đăng nhập:

```bash
systemctl is-active mssql-server
systemctl is-active pbl4
curl -f http://127.0.0.1:5000/health/ready
cd /home/ubuntu/pbl4
git status --short --branch
```

Kết quả: hai service đều `active`, readiness trả `Healthy`.
SQL Server, database `PBL4`, tài khoản riêng `pbl4_backend` và service backend
là nền tảng đã thiết lập từ trước; hôm nay kiểm tra lại, không tạo lại database.

### 2.2. Cài Node.js và build frontend

Kiểm tra ban đầu cho thấy server chưa có `node`, `npm` và `nginx`.
Đã cài NVM, sau đó cài Node.js 24 và đặt làm phiên bản mặc định:

```bash
nvm install 24
nvm alias default 24
node --version
npm --version
```

Kết quả ghi nhận: Node.js `v24.22.1`, npm `11.19.1`.

Trong `/home/ubuntu/pbl4/frontend`, đã chạy:

```bash
npm ci
npm run lint
npm run build
ls -lh dist
```

Lần đầu lint thành công, build thành công với Vite `8.2.2`.
Thư mục `dist` chứa `index.html`, `assets`, `favicon.svg` và `icons.svg`.

### 2.3. Xử lý cảnh báo bảo mật của thư viện frontend

`npm ci` ban đầu báo 2 lỗ hổng mức `high`, liên quan tới `source-map-js`
và Vite. Đã đọc báo cáo `npm audit`; kiểm tra riêng dependency production
bằng `npm audit --omit=dev` trả 0 lỗ hổng.

Sau đó đã chạy bản sửa thông thường và kiểm tra lại:

```bash
npm audit fix
npm audit
npm run lint
npm run build
git status --short
```

Kết quả:

- Thay đổi 7 package, loại bỏ 1 package theo thông báo npm.
- `npm audit`: 0 lỗ hổng tại thời điểm kiểm tra.
- Lint: 0 cảnh báo, 0 lỗi trên 38 file.
- Build production thành công với Vite `8.3.5`, 112 module được chuyển đổi.
- Git trên AWS báo thay đổi `frontend/package-lock.json`.

Thay đổi lockfile này chưa được xác nhận đã commit/push về Git.
Kết quả audit frontend không thay thế việc kiểm tra dependency backend.

### 2.4. Cài Nginx và đưa bản build ra thư mục web

Đã cài Nginx, bật service ngay và cho phép tự khởi động:

```bash
sudo systemctl enable --now nginx
systemctl is-active nginx
curl -I http://127.0.0.1
```

Kết quả: `active`, phản hồi `HTTP/1.1 200 OK`, phiên bản hiển thị
`nginx/1.24.0 (Ubuntu)`. Lúc này phản hồi ban đầu là trang mặc định của Nginx.

Đã sao chép bản build và cấp quyền đọc:

```bash
sudo mkdir -p /var/www/pbl4/frontend
sudo cp -a /home/ubuntu/pbl4/frontend/dist/. /var/www/pbl4/frontend/
sudo chown -R root:root /var/www/pbl4/frontend
sudo chmod -R u=rwX,go=rX /var/www/pbl4/frontend
sudo -u www-data test -r /var/www/pbl4/frontend/index.html
```

Kiểm tra quyền đọc thành công. File frontend được root sở hữu;
Nginx có quyền đọc để phục vụ nội dung.

### 2.5. Mua tên miền và kiểm tra DNS OneShield

Đã mua tên miền `wiremess.io.vn` tại iNET. Giao diện quản lý ghi nhận:

- Trạng thái tên miền: đang hoạt động.
- Ngày đăng ký: `27/10/2026`.
- Ngày hết hạn tên miền: `27/10/2027`.
- Bản ghi A tên `@`: `54.206.72.135`, TTL 5 phút.
- Bảo vệ OneShield: bật theo lựa chọn của chủ dự án.
- Nameserver: `sapa.vclouddns.com` và `laocai.vclouddns.com`.

Đã tra bản ghi A qua `1.1.1.1`, `8.8.8.8` và hai nameserver có thẩm quyền.
Ban đầu có kết quả chưa có địa chỉ A hoặc `Non-existent domain`.
Đã đối chiếu nameserver trong phần quản lý tên miền với danh sách OneShield;
hai nơi trùng nhau. Sau thời gian cập nhật, DNS và đường truy cập đã hoạt động.

Khi bật bảo vệ, địa chỉ A công khai ghi nhận là các IP proxy:
`103.166.183.10`, `103.216.118.10`, `103.56.163.10`.
Bản ghi cấu hình trong portal vẫn trỏ về origin AWS `54.206.72.135`.
Không thay đổi các bản ghi email MX, SPF, DKIM và DMARC.

### 2.6. Cấu hình Nginx phục vụ ứng dụng

Đã tạo `/etc/nginx/sites-available/pbl4`, kích hoạt qua liên kết
`/etc/nginx/sites-enabled/pbl4`, kiểm tra cấu hình rồi reload Nginx.

Cấu hình phục vụ ứng dụng gồm:

- `server_name wiremess.io.vn`.
- Web root `/var/www/pbl4/frontend`.
- Đường dẫn giao diện dùng `try_files` để trả `index.html` khi cần.
- `/assets/` phục vụ file tĩnh và trả 404 nếu file không tồn tại.
- `/api/` chuyển tới `http://127.0.0.1:5000`, giữ nguyên đường dẫn.
- `/hubs/` chuyển tới cùng backend, dùng HTTP/1.1 và header Upgrade/Connection.
- Gửi `Host`, `X-Forwarded-For` và `X-Forwarded-Proto` tới backend.
- Tắt buffering và cache cho `/hubs/`; đặt `proxy_read_timeout 100s`.
- Tắt access log cho `/hubs/` để hạn chế ghi thông tin nhạy cảm trong URL.

`sudo nginx -t` báo syntax hợp lệ và kiểm tra thành công.
Kiểm tra nội bộ với header `Host: wiremess.io.vn` trả `200 OK`,
`index.html` dài 464 byte và tiêu đề ứng dụng `Nối — PBL4 Realtime P2P`.

### 2.7. Cấp chứng chỉ HTTPS cho origin AWS

Đã tạo file thử xác thực tại:
`/var/www/pbl4/frontend/.well-known/acme-challenge/pbl4-check`,
nội dung `wiremess-acme-ok`.

Truy cập nội bộ trả đúng nội dung. Truy cập công khai ban đầu trả 404,
sau đó trả đúng nội dung khi đường proxy hoạt động. Đã xác nhận lại trước
khi tiếp tục cấp chứng chỉ.

Đã dùng Certbot với phương thức webroot:

```bash
sudo certbot certonly --webroot -w /var/www/pbl4/frontend -d wiremess.io.vn
sudo certbot certificates
```

Certbot báo cấp chứng chỉ thành công:

- Tên chứng chỉ: `wiremess.io.vn`.
- Loại khóa: ECDSA.
- Chứng chỉ: `/etc/letsencrypt/live/wiremess.io.vn/fullchain.pem`.
- Đường dẫn khóa riêng: `/etc/letsencrypt/live/wiremess.io.vn/privkey.pem`.
- Hạn chứng chỉ ghi nhận: `25/01/2027`.

Đã sao lưu cấu hình Nginx thành
`/etc/nginx/sites-available/pbl4.before-https`, thêm listener HTTPS 443,
khai báo chứng chỉ và TLS 1.2/1.3, kiểm tra cấu hình rồi reload.

Kiểm tra trực tiếp origin bằng SNI đúng tên miền:

```bash
curl -I --resolve wiremess.io.vn:443:127.0.0.1 https://wiremess.io.vn/
```

Kết quả: `HTTP/1.1 200 OK`, kiểm tra chứng chỉ thành công.

### 2.8. Kiểm tra HTTPS qua OneShield

OneShield đã có chứng chỉ miễn phí và tự động gia hạn ở lớp proxy.
Sau khi origin có chứng chỉ hợp lệ, đã chuyển chế độ SSL sang Full (Strict).
Tùy chọn chuyển hướng HTTP sang HTTPS tại OneShield được bật.

Hai lớp chứng chỉ được quản lý riêng: chứng chỉ phía OneShield và chứng chỉ
Let's Encrypt trên Nginx AWS. Việc OneShield tự gia hạn không thay thế
cơ chế gia hạn ở origin.

Kết quả kiểm tra công khai:

- `https://wiremess.io.vn/`: `HTTP/2 200`.
- HTTP chuyển hướng sang HTTPS.
- Đường dẫn ACME công khai trả `wiremess-acme-ok` sau khi theo chuyển hướng.
- Giao diện frontend mở được bằng tên miền.

### 2.9. Thiết lập gia hạn chứng chỉ tự động

Đã tạo hook `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh`
để kiểm tra cấu hình Nginx rồi reload sau khi gia hạn thành công.
Script dùng `set -e`, chạy `/usr/sbin/nginx -t` trước
`/usr/bin/systemctl reload nginx`, được đặt quyền `750`.

Đã bật lịch và chạy thử:

```bash
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run --run-deploy-hooks
systemctl list-timers --all certbot.timer
```

Kết quả mô phỏng gia hạn thành công, timer có lịch chạy tiếp theo.
Thông báo đỏ `Hook 'deploy-hook' ran with error output` đi kèm nội dung
Nginx báo syntax hợp lệ và test thành công: đây là nội dung ghi ra stderr,
không đủ để kết luận hook thất bại. Không ghi nhận mã thoát lỗi trong
kết quả được cung cấp; Certbot vẫn báo simulated renewals succeeded.

### 2.10. Bật WebSocket và kiểm tra SignalR

Trong OneShield, đã bật **Bật kết nối WebSocket**, lưu cấu hình;
giao diện báo **Đang hoạt động**. Tùy chọn Keepalive của nhà cung cấp đang tắt.

Khi mở ứng dụng và đăng nhập, giao diện báo SignalR đã ngắt.
Đã kiểm tra Network/Console, thử nút kết nối lại và đối chiếu phía server.

Các kết quả ghi nhận:

- Backend vẫn hoạt động; kiểm tra log gần thời điểm lỗi không thấy dòng
  cảnh báo/lỗi backend phù hợp với hiện tượng đang xét.
- Gọi API và negotiate không có token trả `401` đúng yêu cầu xác thực.
- Negotiate có xác thực trả `200`.
- WebSocket `/hubs/chat` nhận `101 Switching Protocols`.
- Response 101 quan sát được kèm `Content-Encoding: br` và
  `Transfer-Encoding: chunked`.
- Client gửi handshake SignalR giao thức JSON phiên bản 1.
- Chrome báo `Unrecognized frame opcode: 3`, sau đó kết nối đóng `1006`.

**Kết luận đã xác nhận:** kết nối qua đường công khai bị lỗi ở giai đoạn
trao đổi frame WebSocket; riêng mã HTTP 101 chưa chứng minh SignalR hoạt động.

**Nghi vấn cần xác nhận:** lớp proxy có thể đang áp nén hoặc xử lý HTTP
không phù hợp lên luồng sau Upgrade. Chưa có phép so sánh WebSocket có xác
thực trực tiếp origin để xác nhận hoàn toàn vị trí gây lỗi. Header `br` và
`chunked` là dấu hiệu cần điều tra, không phải bằng chứng đầy đủ về nguyên nhân.

Trong bước chẩn đoán này không tự sửa code, đổi transport, tắt bảo vệ hoặc
thay đổi cấu hình server. Chưa có kết quả kiểm thử LongPolling để kết luận.

### 2.11. Tạo ticket và chuyển kỹ thuật iNET

Theo thông tin xác nhận được gửi lại trong cuộc trao đổi:

- Mã ticket: `#1793098398064`.
- Trạng thái: `open`, đã gán cho kỹ thuật viên phụ trách.
- Phân loại: `technical`; ưu tiên: `high`.
- Dịch vụ: `wiremess.io.vn`.
- Tag: OneShield, WebSocket, Tên miền, Kỹ thuật.

Nội dung gửi gồm thông tin AWS origin, cấu hình Nginx/backend, các IP proxy,
OneShield đã bật WebSocket và Full (Strict), các header bất thường và lỗi
opcode 3/1006. Đề nghị kỹ thuật kiểm tra chuyển tiếp WebSocket, loại trừ
nén/cache cho `/hubs/chat` và xác nhận nguyên nhân.

Phần nguyên nhân đã được ghi là **nghi vấn**, không khẳng định chắc chắn
proxy làm hỏng frame. Theo dõi tại [mục hỗ trợ iNET](https://portal.inet.vn/support#ticket).
Tại thời điểm chốt nhật ký chưa có phản hồi xử lý xong từ kỹ thuật.

### 2.12. Những việc còn lại sau hôm nay

Các mục này chưa được ghi nhận hoàn tất trong phiên:

1. Nhận phản hồi iNET và kiểm tra lại SignalR qua tên miền: handshake,
   duy trì kết nối, gửi/nhận giữa hai tài khoản và kết nối lại.
2. Đồng bộ thay đổi `frontend/package-lock.json` từ AWS về Git để lần triển
   khai sau giữ được các bản vá đã áp dụng.
3. Xử lý cảnh báo dependency backend `System.Security.Cryptography.Pkcs`
   `9.0.11` đã ghi nhận trước đó; hôm nay mới xử lý audit frontend.
4. Kiểm tra IP người dùng thật khi đi qua proxy và ảnh hưởng tới rate limit;
   chỉ tin header từ các proxy được xác định hợp lệ.
5. Hoàn thiện TURN/ICE và kiểm thử P2P giữa hai mạng khác nhau, kể cả trường
   hợp bắt buộc đi qua TURN. Chưa xác nhận phần này hoàn tất.
6. Hoàn thiện quy trình cập nhật/rollback ứng dụng và sao lưu database.

Nếu Stop/Start EC2, IP công khai có thể thay đổi; cần đối chiếu lại IP AWS
với bản ghi A origin. Trong thời gian kỹ thuật iNET kiểm tra, nếu tắt EC2
thì cần thông báo để họ biết origin không sẵn sàng.

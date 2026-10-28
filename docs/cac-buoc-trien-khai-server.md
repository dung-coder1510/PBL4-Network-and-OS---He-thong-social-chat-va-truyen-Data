# Các bước triển khai server Wiremess

Tài liệu dành cho dự án PBL4, đối chiếu với quá trình triển khai đến ngày
27/10/2026. Đây là hướng dẫn để chủ dự án tự thực hiện, không phải script
tự động. Các bước đã hoàn thành trên server hiện tại không cần chạy lại.

Thông tin đang dùng: Ubuntu 24.04 x86_64, AWS Sydney `ap-southeast-2`,
IP công khai `54.206.72.135`, tên miền `wiremess.io.vn`.
IP có thể đổi sau khi Stop/Start EC2; luôn đối chiếu trên AWS trước khi dùng.

## 1. Hiểu các thành phần

```text
Trinh duyet --HTTPS--> OneShield --HTTPS--> Nginx tren AWS
                                           |-- frontend tinh
                                           |-- /api/  --> ASP.NET Core :5000
                                           |-- /hubs/ --> ASP.NET Core :5000
                                                               |
                                                          SQL Server
```

SQL Server lưu dữ liệu; backend xử lý API, xác thực và SignalR.
Nginx phục vụ bản build frontend và chuyển tiếp API/WebSocket.
OneShield đứng trước Nginx để bảo vệ tên miền.
Kết nối P2P giữa trình duyệt còn phụ thuộc ICE/STUN/TURN; không được thể hiện
bằng đường truyền API trong sơ đồ trên.

## 2. Tạo EC2 và cấu hình truy cập

Trên AWS EC2, chọn Ubuntu 24.04 LTS x86_64, cấu hình RAM/disk phù hợp
để chạy cả SQL Server và backend. Máy hiện tại có khoảng 4 GB RAM.
Tạo hoặc chọn key pair, giữ file `.pem` trên máy cá nhân.

Security Group cho giai đoạn hiện tại:

| Loại | Cổng | Nguồn |
| --- | --- | --- |
| SSH | TCP 22 | My IP của người quản trị |
| HTTP | TCP 80 | Internet, phục vụ HTTP và xác thực chứng chỉ |
| HTTPS | TCP 443 | Internet, phục vụ HTTPS |

Không cần mở SQL 1433 hoặc backend 5000 ra Internet trong mô hình cùng máy.
Nếu có firewall trong Ubuntu, cần đối chiếu thêm quy tắc ở đó.

## 3. SSH và kiểm tra máy

Chạy trong PowerShell trên Windows, dùng IP hiện tại của EC2:

```powershell
ssh -i "D:\PBL4\Hihi\PBL4_key.pem" ubuntu@54.206.72.135
```

Nếu timeout, kiểm tra instance Running, IP công khai và nguồn My IP của
quy tắc SSH. Nếu SSH hỏi host key, đối chiếu khóa của đúng instance trước
khi chấp nhận; không bỏ qua cảnh báo khóa thay đổi một cách tự động.

Sau khi vào Ubuntu:

```bash
cat /etc/os-release
uname -m
free -h
df -h /
```

## 4. Chuẩn bị SQL Server và database

**Server hiện tại đã hoàn thành bước này. Không restore lại DB đang dùng.**

Khi dựng máy mới:

1. Cài SQL Server phiên bản hỗ trợ Ubuntu 24.04 theo
   [hướng dẫn Microsoft](https://learn.microsoft.com/en-us/sql/linux/install-upgrade/quickstart-install-ubuntu?view=sql-server-ver17).
2. Cấu hình edition phù hợp mục đích sử dụng và đặt mật khẩu quản trị.
3. Cài `mssql-tools18` để có `/opt/mssql-tools18/bin/sqlcmd`.
4. Chuyển bản sao lưu của DB lên máy và restore thành database `PBL4`.
5. Đối chiếu logical file names và đường dẫn Linux trước khi restore.
   Nhật ký hiện không có đầy đủ tên file backup/logical files, vì vậy không
   đưa lệnh RESTORE giả định vào tài liệu.
6. Kiểm tra bảng và dữ liệu trước khi tiếp tục. Không chạy migration hoặc
   script kiểm thử có thao tác dữ liệu lên DB thật một cách tự động.

Kiểm tra service:

```bash
systemctl is-active mssql-server
```

Mong đợi `active`; database `PBL4` phải ở trạng thái `ONLINE`.

## 5. Lấy mã nguồn từ Git

Chỉ clone khi `/home/ubuntu/pbl4` chưa tồn tại:

```bash
git clone --branch Server https://github.com/dung-coder1510/PBL4-Network-and-OS---He-thong-social-chat-va-truyen-Data.git /home/ubuntu/pbl4
cd /home/ubuntu/pbl4
git status --short --branch
```

Nếu repo đã có, kiểm tra nhánh và thay đổi trước khi cập nhật.
Đến cuối ngày 27/10, AWS có thay đổi `frontend/package-lock.json` do vá
dependency; cần đồng bộ thay đổi này về Git trước quy trình cập nhật thường lệ.
Không dùng reset/clean để xóa thay đổi đó.

## 6. Cài .NET và tạo tài khoản riêng cho backend

Project yêu cầu .NET 10. Trên máy mới, cài SDK qua nguồn phù hợp Ubuntu
theo [tài liệu .NET](https://learn.microsoft.com/en-us/dotnet/core/install/linux-ubuntu-install?pivots=os-linux-ubuntu-2404&tabs=dotnet10).
Không trộn nhiều nguồn package nếu chưa đối chiếu hướng dẫn.

Kiểm tra:

```bash
dotnet --list-sdks
dotnet --list-runtimes
```

Sau khi DB đã có đủ schema, chạy script của repo:

```bash
cd /home/ubuntu/pbl4
sudo bash deploy/setup-database.sh
```

Nhập mật khẩu `sa` trực tiếp ở terminal khi được hỏi; không đưa vào chat.
Script tạo login `pbl4_backend`, cấp quyền trên các bảng cần thiết và tạo
secret tại `/etc/pbl4/pbl4.env`, quyền root `600`.
Backend dùng `pbl4_backend`, không dùng `sa` khi chạy ứng dụng.
Không commit file secret và không thay nó bằng file env mẫu.

## 7. Publish backend và chạy bằng systemd

Chi tiết quyền, secret và kiểm tra có trong
[hướng dẫn backend](deployment-aws.md).

Build bằng user `ubuntu`:

```bash
cd /home/ubuntu/pbl4
revision=$(git rev-parse HEAD)
dotnet publish PBL4/PBL4.csproj -c Release -o "/home/ubuntu/pbl4-build/$revision/backend"
```

Nếu build thất bại thì dừng tại đây. Trên máy mới, tạo user hệ thống
`pbl4`, cài bản publish vào `/opt/pbl4/releases/<revision>/backend`,
đặt root sở hữu file chương trình và trỏ `/opt/pbl4/current` tới release.
Giữ các release cũ để có thể quay lại khi cần.

Sau khi các đường dẫn đã sẵn sàng, cài service:

```bash
sudo install -m 644 deploy/pbl4.service /etc/systemd/system/pbl4.service
sudo systemd-analyze verify /etc/systemd/system/pbl4.service
sudo systemctl daemon-reload
sudo systemctl enable --now pbl4
systemctl is-active pbl4
curl -f http://127.0.0.1:5000/health/live
curl -f http://127.0.0.1:5000/health/ready
```

Chỉ chuyển bước khi backend active và health trả `Healthy`.
Service trong repo yêu cầu .NET tại `/usr/bin/dotnet`, backend ở
`/opt/pbl4/current/backend/PBL4.dll` và user/group `pbl4` tồn tại.

## 8. Cài Node.js và build frontend

Cài NVM theo [hướng dẫn chính thức NVM](https://github.com/nvm-sh/nvm#installing-and-updating),
mở lại shell hoặc nạp NVM theo hướng dẫn, rồi chạy:

```bash
nvm install 24
nvm alias default 24
node --version
npm --version
cd /home/ubuntu/pbl4/frontend
npm ci
npm audit
npm run lint
npm run build
```

Nếu có cảnh báo audit, đọc báo cáo và đánh giá bản sửa trước khi đổi lockfile;
không dùng `npm audit fix --force` một cách tự động.
Ngày 27/10 đã dùng `npm audit fix`, audit về 0, lint và build đều thành công.

Frontend dùng đường dẫn tương đối `/api/v1` và `/hubs/chat`, nên khi phục vụ
cùng tên miền không cần hard-code IP AWS vào bundle.

## 9. Cài Nginx và đưa frontend ra web root

```bash
sudo apt update
sudo apt install nginx certbot
sudo systemctl enable --now nginx
sudo mkdir -p /var/www/pbl4/frontend
sudo cp -a /home/ubuntu/pbl4/frontend/dist/. /var/www/pbl4/frontend/
sudo chown -R root:root /var/www/pbl4/frontend
sudo chmod -R u=rwX,go=rX /var/www/pbl4/frontend
sudo -u www-data test -r /var/www/pbl4/frontend/index.html
```

## 10. Tạo cấu hình Nginx HTTP ban đầu

Chỉ dùng mẫu dưới đây khi dựng mới. Không ghi đè cấu hình HTTPS đã chạy.
Mở `/etc/nginx/sites-available/pbl4` và điền:

```nginx
# Chuyen header Connection theo yeu cau nang cap WebSocket.
map $http_upgrade $pbl4_connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
    server_name wiremess.io.vn;
    root /var/www/pbl4/frontend;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /assets/ {
        try_files $uri =404;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /hubs/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $pbl4_connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 100s;
        # URL ket noi co the chua token, khong ghi vao access log nay.
        access_log off;
    }
}
```

Mẫu này giữ nguyên cách chuyển tiếp đã dùng trong phiên. Việc lấy IP khách
thật qua OneShield còn cần cấu hình riêng với danh sách proxy tin cậy.
Tham khảo [WebSocket proxying của Nginx](https://nginx.org/en/docs/http/websocket.html).

Tạo symlink một lần nếu chưa có, sau đó kiểm tra rồi mới reload:

```bash
sudo ln -s /etc/nginx/sites-available/pbl4 /etc/nginx/sites-enabled/pbl4
sudo nginx -t
sudo systemctl reload nginx
curl -I -H "Host: wiremess.io.vn" http://127.0.0.1
```

Nếu `nginx -t` lỗi, sửa lỗi trước khi chạy reload. Mong đợi HTTP 200.

## 11. Trỏ tên miền và kiểm tra DNS

Trong iNET, chọn tên miền `wiremess.io.vn`, cấu hình A `@` trỏ về IP AWS
hiện tại, TTL 5 phút. Giữ bảo vệ OneShield theo lựa chọn của chủ dự án.
Đối chiếu nameserver với danh sách OneShield cung cấp.

Trong phiên đã dùng `sapa.vclouddns.com` và `laocai.vclouddns.com`.
Khi bảo vệ bật, DNS công khai có thể trả IP proxy thay vì IP AWS.

Kiểm tra từ PowerShell:

```powershell
nslookup -type=A wiremess.io.vn 1.1.1.1
nslookup -type=A wiremess.io.vn 8.8.8.8
nslookup -type=NS wiremess.io.vn 8.8.8.8
```

Nếu chưa có A, kiểm tra bản ghi ở nameserver có thẩm quyền và thời gian
cập nhật. Không đổi nameserver hoặc tắt bảo vệ chỉ vì DNS chưa cập nhật ngay.

## 12. Kiểm tra đường xác thực và cấp chứng chỉ origin

Trên Ubuntu:

```bash
sudo mkdir -p /var/www/pbl4/frontend/.well-known/acme-challenge
printf 'wiremess-acme-ok\n' | sudo tee /var/www/pbl4/frontend/.well-known/acme-challenge/pbl4-check
curl -fSL --max-time 20 http://wiremess.io.vn/.well-known/acme-challenge/pbl4-check
```

Chỉ tiếp tục khi đường công khai trả đúng `wiremess-acme-ok`.
Sau đó cấp chứng chỉ bằng webroot theo [tài liệu Certbot](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot):

```bash
sudo certbot certonly --webroot -w /var/www/pbl4/frontend -d wiremess.io.vn
sudo certbot certificates
```

Certbot sẽ hỏi email và điều khoản. Sau khi thành công, ghi nhận đường dẫn
`fullchain.pem`, `privkey.pem` và hạn chứng chỉ; không mở nội dung khóa riêng
để gửi cho người khác.

## 13. Bật HTTPS trên Nginx và Full (Strict) trên OneShield

Sao lưu cấu hình trước khi sửa:

```bash
sudo cp -a /etc/nginx/sites-available/pbl4 /etc/nginx/sites-available/pbl4.before-https
sudo nano /etc/nginx/sites-available/pbl4
```

Trong block `server` ở bước 10, giữ listener 80 và thêm:

```nginx
listen 443 ssl;
ssl_certificate /etc/letsencrypt/live/wiremess.io.vn/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/wiremess.io.vn/privkey.pem;
ssl_protocols TLSv1.2 TLSv1.3;
```

Kiểm tra và reload nếu hợp lệ:

```bash
sudo nginx -t
sudo systemctl reload nginx
curl -I --resolve wiremess.io.vn:443:127.0.0.1 https://wiremess.io.vn/
```

Khi origin HTTPS trả 200 và chứng chỉ hợp lệ, vào OneShield → Cài đặt
SSL/TLS, chọn Full (Strict), bật chuyển hướng HTTPS ở edge và lưu.
Không thêm quy tắc chuyển hướng chồng chéo trong giai đoạn này.
Xem [ý nghĩa chế độ SSL của OneShield](https://developers.inet.vn/docs/oneportal/oneshield-ssl-tls).

```bash
curl -I --max-time 20 https://wiremess.io.vn/
curl -I --max-time 20 http://wiremess.io.vn/
```

Mong đợi HTTPS 200, HTTP chuyển hướng HTTPS.

## 14. Bật gia hạn chứng chỉ tự động

```bash
sudo mkdir -p /etc/letsencrypt/renewal-hooks/deploy
sudo nano /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
```

Nội dung hook:

```sh
#!/bin/sh
set -e
# Chi nap lai Nginx sau khi gia han va kiem tra cau hinh thanh cong.
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
```

Bật quyền và thử gia hạn:

```bash
sudo chown root:root /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo chmod 750 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run --run-deploy-hooks
systemctl list-timers --all certbot.timer
```

Mong đợi simulated renewal thành công và timer có lịch.
Chứng chỉ ở OneShield và ở origin là hai chứng chỉ được quản lý riêng.

## 15. Bật WebSocket và kiểm tra ứng dụng

Trong OneShield → Cài đặt tên miền → WebSocket, bật kết nối WebSocket
và lưu. Sau đó mở ứng dụng bằng HTTPS, mở DevTools trước khi đăng nhập:

1. Chọn Network, xóa chữ lọc đang có nếu cần, bật bộ lọc Socket.
2. Đăng nhập bằng tài khoản kiểm thử; tìm kết nối `/hubs/chat`.
3. Kiểm tra negotiate thành công, WebSocket Upgrade và handshake SignalR.
4. Theo dõi Console và Messages; xác nhận kết nối duy trì được.
5. Dùng hai tài khoản thử gửi/nhận, trạng thái tin và kết nối lại.

Riêng HTTP 101 không đủ để kết luận chat đã hoạt động.
Ngày 27/10 gặp opcode 3/đóng 1006 dù có 101; phản hồi upgrade có header
`Content-Encoding: br` và `Transfer-Encoding: chunked`. Nguyên nhân proxy
nén/xử lý luồng chưa phù hợp đang là nghi vấn cần kỹ thuật xác nhận.

Ticket iNET `#1793098398064` đang xử lý. Không ghi bước này là hoàn tất
khi chưa kiểm tra được kết nối thực tế sau khắc phục.

## 16. Cập nhật code ở những lần tiếp theo

Chỉ thực hiện khi đã thống nhất bản code cần triển khai, working tree sạch
và các thay đổi lockfile trên AWS đã được đưa về Git:

```bash
cd /home/ubuntu/pbl4
git status --short --branch
git pull --ff-only origin Server
```

Nếu đang có file thay đổi hoặc pull báo lỗi thì dừng kiểm tra, không dùng
reset để ép cập nhật. Sau pull:

1. Nếu frontend thay đổi: `npm ci`, lint, build rồi cập nhật web root.
2. Nếu backend thay đổi: publish sang release mới, chuyển symlink có kế hoạch,
   restart service và kiểm tra health. Không ghi đè release đang chạy.
3. Giữ nguyên secret; không chạy lại restore DB hoặc tự áp dụng migration.
4. Kiểm tra website, đăng nhập, API và SignalR sau triển khai.

`git pull` chỉ cập nhật mã nguồn, không tự build hoặc triển khai bản mới.
Backend hiện lưu phiên trong bộ nhớ nên restart yêu cầu người dùng đăng nhập lại.

## 17. Những phần cần hoàn thiện tiếp

- Xác nhận iNET đã sửa lỗi WebSocket bằng kiểm thử thực tế.
- Đồng bộ bản vá frontend về Git, xử lý cảnh báo dependency backend.
- Cấu hình IP khách thật qua proxy tin cậy và kiểm tra rate limit.
- Thiết lập TURN/ICE, kiểm thử hai mạng khác nhau và bắt buộc relay.
- Bổ sung backup/restore dữ liệu và quy trình rollback đầy đủ.

Khi nghỉ, có thể Stop EC2 từ AWS; không chọn Terminate nếu muốn giữ máy.
EBS và một số tài nguyên vẫn có thể phát sinh phí khi instance dừng.
Sau khi Start, kiểm tra lại IP, DNS, service và chứng chỉ. Nếu iNET đang
kiểm tra origin thì báo họ trước khi dừng máy.

Xem thêm [nhật ký ngày 27/10/2026](nhat-ky-trien-khai-2026-10-27.md)
để phân biệt việc đã làm với các bước hướng dẫn cho lần dựng mới.

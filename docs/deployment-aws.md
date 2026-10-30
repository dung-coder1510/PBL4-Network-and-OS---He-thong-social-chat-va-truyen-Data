# Triển khai backend trên AWS

Backend dùng .NET 10, SQL Server và một tiến trình ứng dụng. Repo trên AWS
ở `/home/ubuntu/pbl4`, theo dõi nhánh `Server`. Frontend, Nginx, HTTPS và TURN
được triển khai ở các bước tiếp theo.

## Cấu hình Production

`PBL4/appsettings.Production.json` chỉ chứa cấu hình công khai. File
`/etc/pbl4/pbl4.env` chứa kết nối SQL và khóa JWT thực tế, thuộc root với
quyền `600`. Tham khảo tên biến trong `deploy/pbl4.env.example`; không dùng
giá trị mẫu để chạy ứng dụng.

- `ASPNETCORE_ENVIRONMENT=Production`.
- `ASPNETCORE_URLS=http://127.0.0.1:5000`: backend chỉ nghe IPv4 loopback.
- `ConnectionStrings__DefaultConnection`: dùng login SQL `pbl4_backend`.
- `Jwt__SigningKey`: khóa ngẫu nhiên, giữ nguyên qua các lần cập nhật.
- `Cors__AllowedOrigins__0`: chỉ thêm khi có frontend khác origin.

Production mặc định không cấp CORS cho origin khác. Frontend và API cùng
tên miền không cần CORS. Development vẫn cho phép hai địa chỉ localhost
cũ. Middleware chỉ tin forwarded headers từ `127.0.0.1` và `::1`, tối đa
một proxy. Nginx phải chuyển đúng `X-Forwarded-For`, `X-Forwarded-Proto`
và hỗ trợ WebSocket trên `/hubs/chat`.

Kết nối SQL mã hóa và chấp nhận chứng chỉ tự ký vì SQL nằm trên loopback
cùng máy. Khi chuyển SQL sang máy khác, cấu hình chứng chỉ được tin cậy
và tắt `TrustServerCertificate`.

## Tạo tài khoản SQL và secret

Trong terminal Ubuntu đang SSH vào AWS, chạy:

```bash
sudo bash /home/ubuntu/pbl4/deploy/setup-database.sh
```

Nhập mật khẩu SQL `sa` trực tiếp khi được hỏi. Terminal không hiện ký tự.
Script không lưu mật khẩu `sa`, không đưa nó vào tham số tiến trình và
không in mật khẩu ứng dụng hoặc khóa JWT.

Script kiểm tra bảy bảng nghiệp vụ và cột `Users.AvatarPath` trước khi tạo
login. Script cấp quyền thao tác trên các bảng cần thiết, riêng audit log
chỉ cấp `SELECT` và `INSERT`. Không cấp `sysadmin`, `db_owner`, quyền tạo
bảng hoặc chạy migration. Không import, xóa hoặc thay đổi dữ liệu nghiệp vụ.

Secret được lưu trước khi chạy SQL để có thể thử lại sau lỗi kết nối. Chạy
lại script giữ nguyên secret. Nếu đã có login cùng tên với mật khẩu khác,
bước xác thực cuối sẽ thất bại; script không tự đặt lại mật khẩu login đó.
Sau khi thành công, kết quả phải có `IsSysadmin=0` và `IsDbOwner=0`.

Nếu schema chưa khớp, dừng lại để kiểm tra migration. Không chạy
`database/tests/verify.sql` trên DB thật: file đó dành cho DB kiểm thử riêng.

## Publish và chạy service

Publish backend bằng tài khoản quản trị thông thường, không build bằng root:

```bash
cd /home/ubuntu/pbl4
revision=$(git rev-parse HEAD)
dotnet publish PBL4/PBL4.csproj -c Release \
  -o "/home/ubuntu/pbl4-build/$revision/backend"
```

Sau khi kiểm tra SQL thành công, quản trị viên tạo user hệ thống `pbl4`,
đặt bản publish tại `/opt/pbl4/releases/<revision>/backend`, và trỏ
`/opt/pbl4/current` đến thư mục release. Các file chương trình do root sở
hữu, user `pbl4` chỉ cần quyền đọc và thực thi.

Cài `deploy/pbl4.service` vào `/etc/systemd/system/pbl4.service`, kiểm tra
bằng `systemd-analyze verify`, rồi chạy `systemctl daemon-reload` và
`systemctl enable --now pbl4`. Service đọc secret bằng systemd và chạy
ứng dụng bằng user `pbl4`; user này không cần quyền đọc trực tiếp file
secret của root. Service không có quyền ghi vào cây chương trình.

## Kiểm tra trạng thái

Chạy các lệnh sau trên AWS:

```bash
systemctl status pbl4 --no-pager
curl --fail http://127.0.0.1:5000/health/live
curl --fail http://127.0.0.1:5000/health/ready
sudo journalctl -u pbl4 -n 50 --no-pager
```

`/health/live` trả `200 Healthy` khi HTTP còn phản hồi.
`/health/ready` trả `200 Healthy` khi kết nối SQL thành công, hoặc
`503 Unhealthy` khi không kết nối được. Probe không ghi DB và không trả
chuỗi kết nối hay lỗi SQL cho người gọi. Probe không cần JWT, không cache
và không chuyển hướng HTTPS. Chúng không thay thế kiểm thử schema,
đăng nhập và các chức năng nghiệp vụ.

Backend chưa phục vụ frontend. Không mở cổng `5000` hay SQL `1433` ra
Internet để thử. Bước Nginx/HTTPS sẽ cung cấp đường truy cập công khai.

## Kiểm thử cấu hình

Trong repo trên máy phát triển:

```bash
dotnet build PBL4/PBL4.csproj -c Release
node tests/production.mjs
```

Bài kiểm thử chạy tiến trình backend riêng và dùng địa chỉ SQL không có
dịch vụ. Nó kiểm tra probe, xử lý lỗi SQL, HTTPS qua proxy tin cậy, từ chối
header proxy không tin cậy, CORS Production/Development và yêu cầu JWT.
Nó không truy cập DB thật. Đặt `PRODUCTION_TEST_DLL` nếu muốn kiểm tra
một bản publish ở vị trí khác.

Ứng dụng giữ phiên đăng nhập trong bộ nhớ. Restart làm mất các phiên;
người dùng cần đăng nhập lại. Chỉ chạy một tiến trình backend ở giai đoạn
hiện tại. Các lần cập nhật sau phải giữ nguyên secret, không tự áp dụng
migration, và kiểm tra readiness sau khi khởi động.

## Tài liệu tham khảo

- [ASP.NET Core sau reverse proxy](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/proxy-load-balancer?view=aspnetcore-10.0).
- [Health checks trong ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/health-checks?view=aspnetcore-10.0).
- [Chạy ASP.NET Core trên Linux](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/linux-nginx?view=aspnetcore-10.0).

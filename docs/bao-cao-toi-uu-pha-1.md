# Báo cáo triển khai & kiểm thử Tối ưu Truyền file — Pha 1

**Ngày thực hiện:** 23/11/2026  
**Commit nền tảng:** `ff63633` (`add adaptive WebRTC flow control, parallel HTTPS uploads, and transfer diagnostics`)  
**Máy chủ Production (AWS EC2):** `13.211.243.90` (`ubuntu`, kernel `7.0.0-1017-aws`, `.NET 10.0.115`)  
**Tên miền công khai:** `https://wiremess.io.vn` (API + web qua proxy) và `https://rt.wiremess.io.vn` (Nginx trực tiếp cho truyền nội dung HTTPS + SignalR)

---

## 1. Mục tiêu Pha 1 & Hiện trạng trước tối ưu

Pha 1 tập trung vào các tối ưu **nhanh, rủi ro thấp, không thay đổi schema SQL hay kiến trúc giao thức truyền file**, xử lý đồng thời các điểm nghẽn ở 3 lớp: **Hạ tầng TCP AWS**, **Backend .NET 10**, và **Frontend (WebRTC + HTTPS Relay)**.

### Hiện trạng khảo sát được trước khi sửa
- **Hạ tầng AWS (`13.211.243.90`):**
  - `/etc/sysctl.d/99-pbl4-bbr.conf` mới bật `net.ipv4.tcp_congestion_control = bbr`, chưa cấu hình `default_qdisc`, `wmem_max`, `rmem_max`, `tcp_wmem`.
  - Giá trị kernel thực tế lúc kiểm tra: `net.core.default_qdisc = fq_codel`, `net.core.wmem_max = 4194304`, `net.core.rmem_max = 4194304`, `net.ipv4.tcp_wmem = 4096 16384 4194304`.
  - Khi đo tải file 110 MB từ `https://rt.wiremess.io.vn` (RTT ~224 ms), `ss -tin` ghi nhận **`sndbuf_limited:1859ms(35.9%)`** — socket bị trần 4 MB của `tcp_wmem` kìm hãm tới **35,9% thời gian bận**.
- **Backend (.NET 10):**
  - `FileRelayPipe.WriteAsync()` và `FileRelayDiagnosticsController.Download()` gọi thêm `FlushAsync()` sau mỗi khối <= 64 KB dù Kestrel HTTP/1.1 đã tự flush khi đặt `Content-Length` và tắt buffering.
  - Middleware giám sát HTTP trong `Program.cs` bọc `MeasuredStream` và giữ `EnterHttp()` cho cả luồng nhị phân tải lên/xuống hàng trăm MB – 10 GiB.
  - `FileTransferService.SignalAsync()` giữ khóa toàn cục `SemaphoreSlim(1, 1)` trong khi chạy query SQL `Users.AnyAsync(...)` cho **từng ICE candidate** (tối đa 256 lần/phiên) và trong lúc chờ gửi `FileSignal` qua SignalR.
- **Frontend:**
  - Ở chế độ mặc định, mọi file `<= 100 MiB` rơi vào `file-v2` (đọc lát 16 KiB, ghi đĩa mỗi 16 KiB, đệm gửi 256 KiB, cửa sổ ACK cố định 512 KiB).
  - Trong `fileStreamProtocol.js`, `bufferedAmountLowThreshold` cố định ở `64 KiB` cho cả bộ đệm 1 MiB (chỉ đánh thức sender sau khi ống đã xả cạn >93%).
  - Đầu nhận HTTPS (`receiveRelay()` và `measureRelayPath()`) gọi `await disk.write()` tuần tự ngay sau từng chunk nhỏ từ `reader.read()`, không gom lô và không đọc mạng song song với ghi đĩa.

---

## 2. Chi tiết các thay đổi đã thực hiện

### 2.1. Backend (.NET 10)
| Thành phần | Thay đổi | Mục đích |
|---|---|---|
| [FileRelayPipe.cs](../PBL4/Services/FileRelayPipe.cs#L77-L80) | Bỏ `await destination.FlushAsync(ct);` sau `WriteAsync` trong `WriteAsync()` | Giảm syscall / thao tác flush thừa trên từng khối <= 64 KB |
| [FileRelayDiagnosticsController.cs](../PBL4/Controllers/FileRelayDiagnosticsController.cs#L54-L57) | Bỏ `await Response.Body.FlushAsync(ct);` trong `Download()` | Đồng bộ đường ghi streaming trên endpoint đo tốc độ HTTPS |
| [Program.cs](../PBL4/Program.cs#L125-L135) | Bỏ qua `MeasuredStream` và `EnterHttp()` cho route `/api/v1/files/*/relay/content` và `/api/v1/files/relay/diagnostics` | Tránh `Interlocked.Add` hàng trăm nghìn lần trên luồng binary lớn và tránh làm sai số đếm HTTP active |
| [FileTransferService.cs](../PBL4/Services/FileTransferService.cs#L282-L333) | Chỉ kiểm tra `db.Users.AnyAsync(...)` với `offer`/`answer` (bỏ qua với `ice`, vẫn được `RealtimeSessionFilter` bảo vệ); đưa `FileSignal` và `monitoring.File` ra ngoài khóa `gate` | Xóa N+1 truy vấn SQL khi trao đổi ICE và giảm thời gian giữ khóa toàn cục |

### 2.2. Frontend (React / Vite)
| Thành phần | Thay đổi | Mục đích |
|---|---|---|
| [fileRelayStream.js](../frontend/src/services/fileRelayStream.js) *(mới)* | Thêm `streamResponseToDisk(response, disk, signal, onProgress)` gom lô **1 MiB** (`RELAY_WRITE_BATCH_BYTES`) với hàng đợi ghi có trần **2 lô** (`MAX_QUEUED_RELAY_WRITES`), xử lý hủy/lỗi sạch không rò rejection | Tăng tốc ghi đĩa và chồng lắp đọc mạng với ghi đĩa ở đầu nhận HTTPS mà vẫn giới hạn RAM ~2 MiB |
| [fileTransfers.js](../frontend/src/services/fileTransfers.js#L178-L180) | Thay vòng lặp đọc/ghi từng chunk trong `receiveRelay()` bằng `streamResponseToDisk()` | Áp dụng gom lô 1 MiB + pipeline cho tải xuống HTTPS Relay |
| [fileRelayDiagnostics.js](../frontend/src/services/fileRelayDiagnostics.js#L27-L29) | Dùng `streamResponseToDisk()` trong `measureRelayPath()` | Đồng bộ cách ghi đĩa tối ưu cho phép đo trong Cài đặt → Nhà phát triển |
| [fileTransfers.js](../frontend/src/services/fileTransfers.js#L804-L810) | Khi `!large` (`<= 100 MiB`), chế độ mặc định (`preferredChannelCount === null && !parallelConnections`) và server hỗ trợ `maximumFileChannels >= 1`: chèn `'file-v5'` lên đầu `supportedProtocols` (`['file-v5', 'file-v1', 'file-v2']`, `requestedChannelCount = 1`); giữ `sha256Hex` và fallback `file-v1` / `file-v2` | Đưa file `<= 100 MiB` sang nhánh `batched` (đọc lô 512 KiB, đệm 1 MiB, cửa sổ ACK động 2–8 MB, ghi gom 256 KiB) mà vẫn giữ tương thích client cũ |
| [fileStreamProtocol.js](../frontend/src/services/fileStreamProtocol.js#L133-L136) | Đặt `bufferedAmountLowThreshold = Math.max(BUFFER_LOW, Math.floor(sendBuffer / 2))` | Giữ ống gửi DataChannel đầy đều (512 KiB với 1 kênh, 256 KiB với 2 kênh, 64 KiB với 8 kênh) |

### 2.3. Hạ tầng TCP trên AWS (`13.211.243.90`)
- Sao lưu cấu hình cũ tại `/etc/sysctl.d/99-pbl4-bbr.conf.bak-20261123`.
- Cập nhật `/etc/sysctl.d/99-pbl4-bbr.conf` và nạp bằng `sudo modprobe sch_fq && sudo sysctl --system`:
  ```conf
  # Wiremess TCP optimization (Phase 1)
  net.core.default_qdisc = fq
  net.ipv4.tcp_congestion_control = bbr
  net.core.wmem_max = 16777216
  net.core.rmem_max = 16777216
  net.ipv4.tcp_wmem = 4096 65536 16777216
  net.ipv4.tcp_rmem = 4096 131072 30230144
  ```
- **Ghi chú về `tc qdisc`:** Khi chạy thử `sudo tc qdisc replace dev enp39s0 parent :1 fq` trên kernel `7.0.0-1017-aws`, kernel trả về `Error: Failed to find specified qdisc`, nên giữ nguyên `fq_codel` đang chạy trên nhánh con `:1` của `mq` (không chạy `tc qdisc del`; BBR trên Linux 7.0 vẫn tự thực hiện internal pacing, đồng thời `net.core.default_qdisc = fq` đã được cấu hình sẵn cho các lần khởi động lại sau).

---

## 3. Kết quả kiểm thử

### 3.1. Build, Lint, Unit & Check Suites cục bộ
| Hạng mục | Lệnh chạy | Kết quả |
|---|---|---|
| Build Backend | `dotnet build PBL4/PBL4.csproj` | **PASS** (0 lỗi; còn 4 cảnh báo NuGet `NU1902/NU1903` có sẵn của `System.Security.Cryptography.Pkcs 9.0.11`) |
| Lint Frontend | `npm --prefix frontend run lint` | **PASS** (0 cảnh báo, 0 lỗi trên 65 file) |
| Build Frontend | `npm --prefix frontend run build` | **PASS** (`index-D9XCDw9R.js` dev local; bản production riêng bên dưới) |
| Node Unit Tests | `node --test tests/file-protocol.mjs tests/file-stream-protocol.mjs tests/file-large-protocol.mjs tests/file-storage.mjs tests/file-transfer-state.mjs tests/file-flow-control.mjs tests/file-rtc-diagnostics.mjs tests/file-startup-buffer.mjs tests/file-transfer-rate.mjs tests/file-offer-policy.mjs tests/file-relay-stream.mjs` | **PASS 75/75** (đã cập nhật `file-offer-policy.mjs`, `file-startup-buffer.mjs`, và thêm mới 3 test trong `file-relay-stream.mjs`) |
| Relay Body Test | `node tests/file-relay-protocol.mjs` | **PASS** |
| .NET Relay Pipe Checks | `dotnet run --project tests/file-relay/FileRelayChecks.csproj` | **PASS 7/7** |
| .NET Presence Checks | `dotnet run --project tests/presence/PresenceChecks.csproj` | **PASS 9/9** |
| .NET Monitoring Checks | `dotnet run --project tests/monitoring/MonitoringChecks.csproj` | **PASS 15/15** |

### 3.2. Integration Tests trên DB tạm riêng (SQL Server `TRUNG`)
- Chạy trên backend tạm cổng `5257` trỏ DB tạm `PBL4_Phase1Test_20261123_185246` cài từ [01_schema.sql](../database/01_schema.sql) (không chạm DB `PBL4` thật; đã dừng tiến trình và `DROP DATABASE` sau khi xong):
  - `node tests/file-relay-http.mjs`: **PASS 7/7** (kiểm tra 2 & 4 luồng upload HTTPS với 0 B / 64.001 B / 2.000.137 B, hash khớp, kiểm tra phân quyền & endpoint diagnostics).
  - `node tests/files.integration.mjs`: **PASS 16/16** (gồm thương lượng v1/v2/v3/v4/v5/v6, kiểm tra 10 GiB, hash chốt sau, race tab nhận, ICE/SDP routing, giới hạn phiên đồng thời, hết hạn thật sau 60s).
  - Đo nhanh `/api/v1/files/relay/diagnostics` 110.000.000 byte trên loopback local:
    - Upload (`PUT`): `0,153s` (**`718,52 MB/s`**)
    - Download (`GET`): `0,343s` (**`320,31 MB/s`**)
- **Chạy qua Playwright Chrome thật trên DB tạm riêng (SQL Server `TRUNG` + Vite cổng `5175` + Backend tạm cổng `5257`):**
  Đã chạy lần lượt cả 4 bộ E2E Chrome thật (khởi động lại backend tạm giữa mỗi bộ để tách bộ đếm rate-limit auth, không dùng DB `PBL4` thật; đã dừng sạch tiến trình và `DROP DATABASE` sau khi xong):

### 3.3. Kết quả 4 bộ E2E trình duyệt Chrome thật (Playwright)
| Bộ kiểm thử | Phạm vi kiểm tra | Kết quả | Số liệu đo nổi bật trên Chrome local |
|---|---|---|---|
| [file-relay-diagnostics.e2e.mjs](../tests/file-relay-diagnostics.e2e.mjs) | Cài đặt Nhà phát triển (HTTPS 4 kết nối), đo đường truyền 110 MB, SHA-256, desktop/mobile | **PASS** | Upload **79,72 MB/s** (`1,4s`); Download + ghi đĩa + SHA-256 **21,57 MB/s** (`5,1s`) |
| [file-flow.e2e.mjs](../tests/file-flow.e2e.mjs) | 110 MB thương lượng cửa sổ 8 MB, chat song song, tự động `file-v6` 2 kết nối cho > 100 MiB, fallback server cũ `file-v4`, 8 kênh `file-v5`, `READY` cũ 2,10 MB, hủy khi đĩa chậm, chuyển WebRTC → HTTPS | **PASS 8/8 nhóm** | Khớp 100% SHA-256, 0 lỗi JS trình duyệt |
| [file-stream.e2e.mjs](../tests/file-stream.e2e.mjs) | File `<= 100 MiB` qua `file-v5-0` (0 B, 16 KiB, 16 KiB+1, 100 MiB), đa kênh 1/2/4/8, 2 kết nối `file-v6` > 100 MiB, chặn đổi đuôi `.m4a` → `.exe`, sai hash, hết đĩa, lỗi/hủy sau ghi từng phần (`300 KiB`), 2 phiên độc lập, mất `CompleteFile` | **PASS 24/24 ca** | 8 MiB+7 B: `7,074s` (1 kênh), `7,353s` (2 kênh), `6,253s` (4 kênh), `4,674s` (8 kênh) |
| [file-relay.e2e.mjs](../tests/file-relay.e2e.mjs) | Byte sớm HTTP, hủy giữa phiên, hoãn hết hạn đăng nhập khi relay chạy, 1/2/4 kết nối HTTPS × 3 lượt file 110 MB, tự chuyển WebRTC → HTTPS cùng thẻ và tái dùng file đích | **PASS toàn bộ** | 110 MB (bấm Nhận → lưu & SHA-256): **1 kết nối** `7,02 / 6,89 / 6,63 MB/s` (trung vị **6,89**); **2 kết nối** `6,48 / 11,47 / 14,21 MB/s` (trung vị **11,47**); **4 kết nối** `15,01 / 14,10 / 6,62 MB/s` (trung vị **14,10**) |

---

## 4. Đo đạc tốc độ đối chứng trên AWS (`https://rt.wiremess.io.vn`)

Phép đo thực hiện từ máy Windows tới `https://rt.wiremess.io.vn/assets/.phase1-bench-110m.bin` (`110.000.000 byte` cố định, không nén, xóa file tạm ngay sau khi đo) bằng `curl.exe` và chụp socket bằng `ss -tin '( sport = :443 )'` trên EC2.

| Chỉ số đo (110 MB tải xuống từ Sydney) | Trước Pha 1 (Baseline) | Sau Pha 1 | Mức cải thiện |
|---|---:|---:|---|
| Thời gian tải Lượt 1 | `10,706 giây` (`ttfb 1,080s`) | **`6,571 giây`** (`ttfb 0,920s`) | Nhanh hơn **38,6%** |
| Tốc độ Lượt 1 | `10,27 MB/s` | **`16,74 MB/s`** | **+63,0%** |
| Thời gian tải Lượt 2 | `10,441 giây` (`ttfb 0,913s`) | **`6,587 giây`** (`ttfb 1,003s`) | Nhanh hơn **36,9%** |
| Tốc độ Lượt 2 | `10,54 MB/s` | **`16,70 MB/s`** | **+58,5%** |
| Trần `tcp_wmem` / `wmem_max` | `4.194.304 byte` (~4,19 MB) | **`16.777.216 byte`** (~16,78 MB) | Tăng **4×** |
| Thời gian bị nghẽn đệm gửi (`sndbuf_limited`) | **`1.859 ms (35,9%)`** | **`0 ms (0%)`** | **Xóa bỏ hoàn toàn** |
| `Send-Q` / `snd_wnd` trên `ss -tin` | `3,59 MB` / `8,39 MB` | **`14,47 MB`** / **`16,78 MB`** | Đủ BDP tuyến RTT ~218 ms |
| Băng thông BBR (`bbr bw` / `delivery_rate`) | `119,3 Mbps` / `119,3 Mbps` | **`310,5 Mbps`** / **`273,3 Mbps`** | **~2,3× – 2,6×** |

---

## 5. Thông tin triển khai Production & Rollback trên AWS

- **Release mới đang chạy:** `20261123T115453Z-phase1`
  - `/opt/pbl4/current` → `/opt/pbl4/releases/20261123T115453Z-phase1`
  - `/var/www/pbl4/frontend` → `/var/www/pbl4/releases/20261123T115453Z-phase1`
- **Biến môi trường build Frontend Production:**
  - `VITE_API_BASE_URL=https://wiremess.io.vn/api/v1`
  - `VITE_FILE_RELAY_CONTENT_BASE_URL=https://rt.wiremess.io.vn/api/v1`
  - `VITE_CHAT_HUB_URL=https://rt.wiremess.io.vn/hubs/chat`
- **Bundle công khai đã xác minh khớp SHA-256 trên cả `wiremess.io.vn` và `rt.wiremess.io.vn`:**
  - File: `assets/index-Unf6XXVh.js`
  - SHA-256: `703a27a3cd18a6e750f1e731940c369027bc84c6504c7a9f7a4493300c5c1f68`
- **Xác minh dịch vụ sau khởi động lại:**
  - `pbl4`: `active` (lắng nghe `http://127.0.0.1:5000`, Environment `Production`, Content root `/opt/pbl4/releases/20261123T115453Z-phase1/backend`)
  - `nginx`: `active`
  - `http://127.0.0.1:5000/health/ready`: `Healthy`
  - `https://wiremess.io.vn/api/v1/files/configuration` & `https://rt.wiremess.io.vn/api/v1/files/configuration`: `401` (xác thực JWT hoạt động bình thường)
  - Đã kiểm tra xóa sạch tệp tạm `/var/www/pbl4/frontend/assets/.phase1-bench-110m.bin`.

### Lệnh rollback nhanh (nếu cần quay về bản trước)
```bash
sudo ln -sfn /opt/pbl4/releases/20261120-https-relay-5189353270 /opt/pbl4/current
sudo ln -sfn /var/www/pbl4/releases/20261120-https-relay-5189353270 /var/www/pbl4/frontend
sudo systemctl restart pbl4
# (Tuỳ chọn) Khôi phục sysctl TCP:
sudo cp /etc/sysctl.d/99-pbl4-bbr.conf.bak-20261123 /etc/sysctl.d/99-pbl4-bbr.conf
sudo sysctl --system
```

---

## 6. Đề xuất kế hoạch tiếp theo — Pha 2 (Multi-Part HTTPS Relay)

Pha 1 đã giải phóng nút thắt `tcp_wmem` cho 1 kết nối TCP, nhưng truyền qua **1 `GET` duy nhất** vẫn có thể bị dao động khi đường mạng quốc tế rớt gói nhiều hoặc khi truyền file nhiều GB không có resume. Đề xuất Pha 2:

1. **Chia Part cố định (4–8 MiB/part) & Song song 2 chiều (`4–6 PUT` + `4–6 GET`):**
   - Bỏ hoàn toàn thao tác `File.slice` 64 KB hàng trăm nghìn lần; B mở pool `4–6 GET` tải các part song song và ghi trực tiếp đúng offset (`writer.write({ type: 'write', position, data })`).
   - Server dùng `FileRelayPartStore` với `ArrayPool<byte>.Shared` giữ cửa sổ RAM giới hạn (24–32 MB/phiên), giải phóng từng slot ngay khi B tải xong part đó.
2. **Xác minh kết hợp cả hai lớp (Hybrid Integrity):**
   - Từng part dùng **`X-Part-SHA256` tính bằng `crypto.subtle.digest` phần cứng** (đạt ~1–3 GB/s) để verify ngay và hỗ trợ **retry/resume từng part** nếu rớt mạng giữa chừng.
   - Bỏ chờ hash 100% file trước khi mở lời mời; đồng thời tính **SHA-256 tuyến tính toàn file trong Web Worker** để chốt DB (`Sha256` / `VerifiedSha256`), bảo đảm **khớp 100%** khi kiểm tra bằng `Get-FileHash` / `sha256sum`.
3. **Gia hạn phiên cho file nhiều GB:** Thêm cơ chế gia hạn token / transfer receipt cho phiên kéo dài quá 30 phút.

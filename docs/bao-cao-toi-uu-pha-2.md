# Báo cáo Tối ưu Truyền File — Pha 2 (Multi-Part HTTPS Streaming Relay)

- **Ngày thực hiện:** 2026-11-23
- **Mục tiêu:** Giải quyết triệt để nút thắt cổ chai của kênh dự phòng qua máy chủ HTTPS (`HTTPS relay`): nâng cấp từ mô hình 1 luồng tuần tự (hoặc 1–4 kết nối gom tuyến tính phụ thuộc thứ tự byte) sang truyền phân mảnh song song **4 kết nối `POST`/`PUT` + 4 kết nối `GET` mặc định** theo từng mảnh cố định **4 MiB**, giữ giới hạn RAM máy chủ chặt chẽ (**256 MiB toàn cục**, thiết kế nền **192 MiB**), toàn vẹn **SHA-256 giống `Get-FileHash`**, không đổi schema SQL (vẫn tự chạy tốt ngay cả khi DB chưa áp dụng `003_deferred_file_hash.sql`), và khả năng tự hồi phục khi rớt mảnh hoặc hết phiên JWT.
- **Release triển khai AWS (`13.211.243.90`):** `20261123T130431Z-phase2` (bản gốc Pha 2); các bản vá vận hành cross-origin, bỏ `OPTIONS` preflight, gộp ghi `4 MiB` và mặc định `4` kết nối được hợp nhất đến release **`20261124T051303Z-phase3`** (`backend` từ `20261123T162606Z-phase3`).

---

## 1. Tóm tắt kết quả nổi bật

| Hạng mục | Trước Pha 2 (Pha 1 / Gốc) | Sau Pha 2 |
| --- | --- | --- |
| Số kết nối HTTPS mặc định | 1 kết nối (`content`) hoặc chế độ thử nghiệm | **4 luồng gửi + 4 `GET` song song** mặc định ở cả chế độ thường và Nhà phát triển (`relayConnectionCount = 4`) |
| Đơn vị truyền & điều khiển | Luồng liên tục + `FlushAsync`/pipelining 1 luồng | **Mảnh cố định 4 MiB** (`4,194,304 B`), **cửa sổ trượt hiện hành 16 mảnh/phiên (64 MiB)** *(bản gốc Pha 2: 6 mảnh = 24 MiB)* |
| Giới hạn RAM máy chủ (`ArrayPool`) | Phụ thuộc pipe đơn | Tối đa **64 mảnh = 256 MiB toàn máy chủ** *(bản gốc Pha 2: 48 mảnh = 192 MiB)*, thuê bao `PartLease` tránh mất mảnh đang đọc |
| Tốc độ WAN 110 MB ↔ AWS Sydney (`rt.wiremess.io.vn`) | Gốc: `10.27–10.54 MB/s`<br>Pha 1 (1 luồng BBR): `16.70–16.74 MB/s` | Pha 2 (1 luồng): `9.58–17.75 MB/s`<br>Pha 2 (**4 luồng 4 MiB song song**): **`19.16 – 20.15 MB/s`** (`5.459s – 5.743s`) |
| Trạng thái `ss -tin` trên EC2 AWS | Pha 1 (1 luồng): `sndbuf_limited: 0%` | Pha 2 (4 luồng BBR đồng thời): `cwnd 4276–6379`, `snd_wnd 8388352`, **`sndbuf_limited: 0%`** |
| Tốc độ trình duyệt Chrome 110 MB local E2E (upload + relay + disk OPFS + SHA-256) | `1` kết nối: `5.91–6.25 MB/s` (`17.6–18.6s`) | `2` kết nối: `9.14–9.50 MB/s` (`11.6–12.0s`)<br>`4` kết nối: tối đa **`10.76 MB/s`** (`10.223s – 15.972s`) |
| Chống rớt mạng & hết hạn đăng nhập 30 phút | Mất 1 kết nối hoặc hết JWT gây đứt phiên giữa chừng | Retry từng mảnh tối đa **5 lần** (`withRelayRetry`), route part/ack/hash/complete xác thực bằng khóa riêng `X-File-Relay-Sender-Key` / `X-File-Relay-Key` (`[AllowAnonymous]`) |
| Schema SQL (`Sha256`, `VerifiedSha256`) | Bắt buộc hash trước toàn file rồi mới tạo offer HTTPS | Giữ nguyên schema 100%; hash toàn file chạy song song trong Web Worker (`digestOnly` & `0..N-1`) và chốt qua `/relay/hash` |

---

## 2. Kiến trúc & các quyết định kỹ thuật Pha 2

### 2.1. Multi-Part HTTPS Streaming Relay (4 MiB × 4 kết nối song song)
- Ở chế độ thường (và mặc định Nhà phát triển với `relayConnectionCount = 4` trong `App.jsx`), hệ thống dùng `relayMode: 'multipart'` với **4 kết nối song song cả hai chiều (`4 POST/PUT + 4 GET`)** bất kể cờ `supportsDeferredRelayHash` (tách riêng khả năng chia mảnh 4 luồng khỏi điều kiện defer hash SQL).
- Phía gửi (`uploadMultipartRelay`) tính `crypto.subtle.digest` cho từng mảnh 4 MiB, đẩy qua **CORS Simple Request** `POST /api/v1/files/{id}/relay/parts/{partIndex}?key=...&sha256=...` với `new Blob([buffer], { type: 'text/plain' })` và không gắn custom header (`apiClient.js:requestFileContent` bỏ `headers` rỗng), giúp **loại bỏ 100% request `OPTIONS` preflight** xuyên miền (`wiremess.io.vn -> rt.wiremess.io.vn`), đồng thời băm toàn tệp một lượt ngay trên buffer đã đọc bằng `createOrderedFileHasher(totalParts)`.
- Phía nhận (`downloadMultipartRelay` + `createPartFileStorage`) tải song song qua **CORS Simple Request** `GET /api/v1/files/{id}/relay/parts/{partIndex}?key=...&ack=...`, đọc stream bằng `response.body.getReader()` (`onChunk` cập nhật tiến trình tức thì), verify `X-Part-SHA256`, gối đầu `previousWrite` trên đĩa và gộp ghi đĩa tuần tự tối đa **4 MiB** (`MAX_COALESCED_WRITE_BYTES`) trước `writer.write()`.

### 2.2. Quản lý bộ nhớ máy chủ với `FileRelayPartStore`
- Dùng `ArrayPool<byte>.Shared` cấp phát đệm 4 MiB, **không dùng `MemoryStream` phình RAM** và không chạm đĩa máy chủ.
- **Cửa sổ trượt theo từng phiên truyền:** Cấu hình ban đầu Pha 2 là `6` mảnh (**24 MiB / transfer**), sau đó nâng lên **`MaxBufferedPartsPerTransfer = 16` mảnh** (**64 MiB / transfer**) để giữ pipeline 4 luồng bão hòa trên kết nối RTT cao (~206–223 ms).
- **Giới hạn toàn cục máy chủ:** Cấu hình ban đầu Pha 2 là `48` mảnh (**192 MiB**), hiện tại là **`MaxGlobalBufferedParts = 64` mảnh** (**256 MiB** trên toàn server EC2).
- **An toàn đồng bộ & thu hồi:** Bảo vệ mảnh đang có `GET` đọc bằng `PartLease`; `AckParts` mang tính idempotent cho HTTP retry; `FinishRelayAsync` gọi `PartStore?.Dispose()` trả mọi mảng về `ArrayPool` và giải phóng slot ngay khi hoàn tất, hủy hoặc ngắt kết nối.

### 2.3. Kiểm tra toàn vẹn lai (Hybrid SHA-256) giữ nguyên 100% Schema SQL
- **Mức từng mảnh (nhanh, song song):** Phần cứng `crypto.subtle.digest` (`X-Part-SHA256` / query `sha256`) ở cả chiều gửi lên máy chủ và chiều `GET` về máy nhận; sai hash khi gửi trả HTTP `400`, sai hash khi nhận về tự kích hoạt retry tối đa 5 lần.
- **Mức toàn tệp (khớp `Get-FileHash` & cột SQL `Sha256` / `VerifiedSha256`):**
  - Phía gửi: Khi server hỗ trợ defer hash, `uploadMultipartRelay` dùng `createOrderedFileHasher(totalParts)` gửi từng buffer vừa upload sang `fileReceiveHashWorker.js` qua **Zero-copy Transferable** (`[buffer]`) để băm một lượt mà không phải đọc lại file từ đĩa lần thứ 2, rồi chốt qua `POST /api/v1/files/{id}/relay/hash`; nếu server giữ ràng buộc `Sha256 NOT NULL`, client dùng `hashFile()` trước khi tạo/chuyển phiên relay nhưng vẫn chạy đủ `multipart` 4 luồng.
  - Phía nhận: `fileReceiveHashWorker.js` nhận các buffer đã ghi qua **Zero-copy Transferable** (`[buffer]`), xếp hàng đợi mảnh `0..N-1` trong Worker để băm tuyến tính và trả SHA-256 toàn tệp cho `verify()` -> `/relay/complete`.

### 2.4. Phục hồi lỗi & bền vững qua hết hạn phiên JWT 30 phút
- Một request `PUT` hoặc `GET` một mảnh bị rớt mạng **không** làm hủy toàn bộ phiên `RelaySession`; client tự retry với backoff mũ tối đa **5 lần** (`RELAY_RETRY_LIMIT = 5`, tối đa `4000ms` delay) trên `408`/`429`/`5xx`/lỗi mạng/sai `X-Part-SHA256`.
- Các route dữ liệu `/relay/parts/{partIndex}`, `/relay/parts/ack`, `/relay/hash`, `/relay/complete` dùng `[AllowAnonymous]` kết hợp kiểm tra khóa ngẫu nhiên theo phiên (`X-File-Relay-Sender-Key` hoặc `X-File-Relay-Key`), giúp tải tệp lớn qua mặt mốc hết hạn JWT 30 phút (đã kiểm chứng tự động trong `tests/file-relay.e2e.mjs`).
- Middleware đo lưu lượng `MeasuredStream` và `EnterHttp` trong `PBL4/Program.cs` bỏ qua các request binary `/relay/parts/*` (trừ `/ack`), tránh overhead trên luồng dữ liệu 4 MiB.

### 2.5. Lỗi thực tế phát hiện & xử lý ngay trong E2E Chrome thật
Trong lần chạy Playwright Chrome đầu tiên (`tests/file-flow.e2e.mjs`), ca fallback `flow-https-fallback.bin` (WebRTC gãy → chuyển sang `4 kết nối HTTPS`) báo lỗi `"Chưa ghi đủ tệp."` dù trên Node unit test mock qua hết:
- **Nguyên nhân gốc (`frontend/src/services/fileStorage.js:201`):** Khi `createPartFileStorage.writePart` gọi `hasher.push(partIndex, transferBuffer)`, trình duyệt Chrome thật **detach** `ArrayBuffer` gốc ngay lúc `worker.postMessage(..., [buffer])` chuyển quyền sở hữu cho Worker. Ngay dòng tiếp theo, `written += view.byteLength` cộng `0` vì `view.buffer` đã bị detach!
- **Cách khắc phục:** Đổi thành `written += expectedLength` (đã xác thực `data.byteLength === expectedLength` ở đầu `writePart`), đồng thời bổ sung unit test hồi quy `createPartFileStorage preserves written byte count when Transferable Worker detaches part buffers` dùng `structuredClone(..., { transfer })` trong `tests/file-relay-multipart.mjs`.

---

## 3. Danh sách tệp thay đổi / bổ sung

*(Lưu ý: repo làm việc hiện còn chứa cả thay đổi của Pha 1 chưa commit vì chưa git commit giữa hai pha; bảng dưới tổng hợp các thành phần chính của Pha 2 đã thêm/chỉnh sửa.)*

| Thành phần | Tệp | Vai trò chính trong Pha 2 |
| --- | --- | --- |
| Backend | `PBL4/Services/FileRelayPartStore.cs` *(mới)* | Sliding window 16 mảnh/transfer (64 MiB), trần 64 mảnh toàn cục (256 MiB) trên `ArrayPool<byte>.Shared`, `PartLease`, verify SHA-256, idempotent `AckParts` |
| Backend | `PBL4/Contracts/FileDtos.cs` | Thêm `RelayMode`, `RelayConnectionCount`, `RelayPartBytes`, `RelaySenderSessionDto`, `RelayHashDto`, `AckRelayPartsDto` |
| Backend | `PBL4/Services/FileTransferService.cs`, `FileTransferService.Relay.cs` | Trạng thái `IsMultipart`, `SenderKey`, `PartStore`, `HashReady`, deferred hash, `OfferRelayWithKeyAsync`, `SwitchRelayAsync`, `ClaimRelaySenderSessionAsync`, `PutRelayPartAsync`, `GetRelayPartAsync`, `AckRelayPartsAsync`, `GetRelayHashAsync`, `FinalizeRelayHashAsync` |
| Backend | `PBL4/Controllers/FileRelayController.cs` | Endpoints `/relay/session`, `PUT`/`POST`/`GET /relay/parts/{partIndex}` hỗ trợ CORS Simple Requests (`?key=...&sha256=...`, `?key=...&ack=...`), `POST /relay/parts/ack`, `GET`/`POST /relay/hash` |
| Backend | `PBL4/Controllers/FilesController.cs`, `PBL4/Program.cs` | Thêm cấu hình `supportsMultipartHttpRelay`, `relayPartBytes`, `defaultRelayConnections`, `supportsDeferredRelayHash`; CORS exposed headers `X-Part-SHA256`, `X-File-Relay-Sender-Key`; bypass `MeasuredStream`/`EnterHttp` cho `/relay/parts/*` |
| Frontend | `frontend/src/services/fileRelayMultipart.js` *(mới)* | `uploadMultipartRelay` (hỗ trợ băm 1 lượt `createOrderedFileHasher`), `downloadMultipartRelay` (`onChunk` progress + pipelined `previousWrite`), `withRelayRetry` (5 lần), `hashFileInBackground`, `sha256ArrayBuffer` |
| Frontend | `frontend/src/services/fileReceiveHashWorker.js` *(mới)*, `fileHashWorker.js` | Worker nhận Transferable băm SHA-256 theo thứ tự `0..N-1`; Worker phía gửi hỗ trợ mode `digestOnly` 1 MiB/chunk |
| Frontend | `frontend/src/services/fileStorage.js` | Thêm `createPartFileStorage` ghi random-offset + gộp ghi tới `4 MiB` (`MAX_COALESCED_WRITE_BYTES`) + Worker ordered SHA-256 + sửa lỗi đếm byte sau Transferable detach |
| Frontend | `frontend/src/services/apiClient.js`, `fileTransfers.js`, `App.jsx`, `SettingsPage.jsx`, `FileMessageCard.jsx`, `FilesPage.jsx` | CORS Simple Requests (`POST` `text/plain`, `GET` không custom header) bỏ preflight `OPTIONS`, tách `multipart` 4 kết nối khỏi `supportsDeferredRelayHash`, mặc định Nhà phát triển `relayConnectionCount = 4` |
| Kiểm thử | `tests/file-relay-multipart.mjs` *(mới)*, `tests/file-relay-multipart-http.mjs` *(mới)*, `tests/file-offer-policy.mjs`, `tests/file-relay.e2e.mjs`, `tests/file-relay/Program.cs` | Kiểm thử sliding window/10 GiB/lease/pool cap, unit checks, integration HTTP/SQL `0 B` / `123 KB` / `10 MB`, và Chrome E2E 1/2/4 kết nối + giả lập rớt part |
| Hạ tầng AWS | `/etc/nginx/sites-available/pbl4` | Cập nhật regex stream thêm `parts/[0-9]+` và `access_log off;` cho các endpoint truyền mảnh |

---

## 4. Kết quả kiểm thử toàn diện

### 4.1. Bộ kiểm thử `.NET` & Build (`dotnet build`, `FileRelayChecks`, `PresenceChecks`, `MonitoringChecks`)
*(Chạy sau khi hoàn tất phần backend C#; không có sửa đổi C# nào sau lượt chạy này.)*
- `dotnet build PBL4/PBL4.csproj`: **0 Error(s)**.
- `tests/file-relay/FileRelayChecks.csproj`: **10/10 PASS** (bao phủ streaming relay, 1/2/4 inputs, biên 0 B / 1 B / 4 MiB / 10 GiB, sliding window 6 mảnh, `PartLease` đang đọc, idempotent retry, hash guard 409, và trần 48 slot toàn cục + `Dispose` giải phóng toàn bộ slot).
- `tests/presence/PresenceChecks.csproj`: **9/9 PASS**.
- `tests/monitoring/MonitoringChecks.csproj`: **15/15 PASS**.

### 4.2. Bộ kiểm thử SQL/HTTP Integration (`TRUNG`, DB tạm biệt lập, đã xóa sạch)
*(Chạy lại sau bản vá rà soát code: thêm xử lý `0-byte` fallback trong `AcceptRelayAsync`/`CompleteRelayAsync` và cache kiểm tra tài khoản `5s` + bỏ truy vấn DB lặp dưới `gate` trong `PutRelayPartAsync`/`GetRelayPartAsync`/`AckRelayPartsAsync`.)*
- `tests/file-relay-http.mjs`: **7/7 PASS** (2 & 4 inputs `0 B`, `64,001 B`, `2,000,137 B` + diagnostics).
- `tests/file-relay-multipart-http.mjs`: **4/4 PASS** (`0 bytes / 0 parts`, `123,456 bytes / 1 part`, `10,000,017 bytes / 3 parts`, và `0-byte pre-hashed WebRTC offer switched to multipart HTTPS`).
- `tests/files.integration.mjs`: **16/16 PASS**.

### 4.3. Unit tests JS, Lint & Build sau bản vá cuối cùng
- `node --test` (toàn bộ unit files thuần trong `tests/file-*.mjs`, không bao gồm `*.e2e.mjs`, `*-http.mjs`, `file-relay-protocol.mjs`) + `tests/file-relay-protocol.mjs`: **90/90 PASS** và `file-relay-protocol.mjs` **PASS**.
- `npm --prefix frontend run lint` (`oxlint`): **0 warnings, 0 errors** trên 67 tệp.
- `npm --prefix frontend run build`: Thành công (`741ms` build thường; `346ms` bản production `index-BRdIrAy9.js`).

### 4.4. Bộ 4 Playwright Chrome E2E (`TRUNG`, DB tạm đã xóa sạch sau bản vá cuối)
- `tests/file-relay-diagnostics.e2e.mjs`: **PASS** (`Máy này → máy chủ`: `274.18 MB/s · 0.4 giây`; `Máy chủ → máy này và ghi đĩa`: `40.60 MB/s · 2.7 giây`).
- `tests/file-flow.e2e.mjs`: **10/10 cases PASS**.
- `tests/file-stream.e2e.mjs`: **24/24 cases PASS**.
- `tests/file-relay.e2e.mjs`: **PASS toàn bộ**, bao gồm:
  - Early HTTP bytes & scoped receipt: **PASS**
  - Browser cancel active relay: **PASS**
  - 4-connection HTTP-only 110 MB transfer + simulated 30-min login expiry: **PASS**
  - Benchmark Chrome end-to-end 110 MB local (upload + relay + ghi OPFS + Dual Worker SHA-256) sau khi bỏ query DB lặp dưới `gate`:

| Số kết nối HTTPS (`relayConnectionCount`) | Vòng 1 | Vòng 2 | Vòng 3 | Khoảng tốc độ |
| --- | --- | --- | --- | --- |
| **1 kết nối** (`1`) | `17.933s` (`6.13 MB/s`) | `18.634s` (`5.90 MB/s`) | `17.872s` (`6.15 MB/s`) | **`5.90 – 6.15 MB/s`** |
| **2 kết nối** (`2`) | `11.633s` (`9.46 MB/s`) | `11.440s` (`9.62 MB/s`) | `11.422s` (`9.63 MB/s`) | **`9.46 – 9.63 MB/s`** |
| **4 kết nối** (`4`, mặc định Pha 2) | `10.387s` (`10.59 MB/s`) | `10.410s` (`10.57 MB/s`) | `10.404s` (`10.57 MB/s`) | **`10.57 – 10.59 MB/s`** |

  - WebRTC failure switches same chat card to HTTPS without reopening picker: **PASS**
  - Giả lập rớt `GET /api/v1/files/*/relay/parts/1` (`multipart-retry.bin`, `9,000,013 B`) tự retry và khớp SHA-256: **PASS**

---

## 5. Triển khai AWS Production (`13.211.243.90`)

1. **Cập nhật Nginx (`/etc/nginx/sites-available/pbl4`):**
   - Đổi regex streaming từ `^/api/v1/files/([0-9]+/relay/content|relay/diagnostics)$` thành `^/api/v1/files/([0-9]+/relay/(content|parts/[0-9]+)|relay/diagnostics)$` (tắt `proxy_request_buffering`, `proxy_buffering`, `proxy_cache` và thêm `access_log off;` để bỏ log I/O trên các request truyền mảnh).
2. **Build & phát hành mới nhất (từ `20261123T130431Z-phase2` đến `20261124T051303Z-phase3`):**
   - Frontend build trên Windows với `VITE_API_BASE_URL=https://wiremess.io.vn/api/v1`, `VITE_FILE_RELAY_CONTENT_BASE_URL=https://rt.wiremess.io.vn/api/v1`, `VITE_CHAT_HUB_URL=https://rt.wiremess.io.vn/hubs/chat`.
   - Bundle hiện hành trên cả `wiremess.io.vn` và `rt.wiremess.io.vn`: **`index-BRdIrAy9.js`** (`sha256: 6a1541fd728361c53396e32db328309b691540365bfd6773b5fb901aeb91f9d1`) cùng 2 worker `fileReceiveHashWorker-Dl9VAYMD.js` và `fileHashWorker-BLJs4aRq.js`.
   - Backend đang phục vụ từ `/opt/pbl4/releases/20261124T051303Z-phase3/backend` (nhị phân kế thừa từ `20261123T162606Z-phase3`, trạng thái `Healthy` trên `http://127.0.0.1:5000/health/ready`, cả 2 domain trả HTTP `401` chuẩn cho `/api/v1/files/configuration`).

---

## 6. Benchmark WAN thực tế máy người dùng ↔ AWS Sydney (`rt.wiremess.io.vn`)

Đo bằng tệp nhị phân tĩnh tạm `/var/www/pbl4/frontend/assets/.phase2-bench-110m.bin` (`110,000,000 bytes`, HTTP/1.1, không nén, đã xóa sạch và kiểm chứng không còn tồn tại ngay sau khi đo):

| Mốc so sánh (Tải `110,000,000 B` từ AWS Sydney) | Round 1 | Round 2 | Nhận xét kỹ thuật |
| --- | --- | --- | --- |
| **Trước Pha 1 (gốc Cubic)** | `10.27 – 10.54 MB/s` | — | Nghẽn `sndbuf_limited: 35.9%` |
| **Sau Pha 1 (1 luồng, BBR + sysctl TCP)** | `6.571s` (**`16.74 MB/s`**) | `6.587s` (**`16.70 MB/s`**) | Giải phóng `sndbuf_limited: 0%` |
| **Pha 2 — 1 luồng đơn (`HTTP/1.1`)** | `11.487s` (**`9.58 MB/s`**) | `6.197s` (**`17.75 MB/s`**) | Vòng 1 chịu khởi động chậm BBR |
| **Pha 2 — 4 luồng × mảnh 4 MiB song song (`HTTP/1.1`)** | **`5.459s`** (**`20.15 MB/s`**) | **`5.743s`** (**`19.16 MB/s`**) | **Gấp ~2x gốc**, giữ ổn định ~153–161 Mbps cả từ trạng thái kết nối mới |

### Quan sát `ss -tin` trên EC2 giữa lúc tải 4 luồng song song
Trích 4 socket đồng thời từ EC2 `:443` về client `<client-ip>:64939..64942`:
- Cả 4 kết nối đều chạy `bbr` ổn định, `minrtt` thực tế `206.38 – 222.63 ms`.
- `cwnd`: `4276`, `4411`, `4744`, `6379` gói; `snd_wnd`: `8388352` (~8 MiB trên mỗi socket).
- **`sndbuf_limited` không còn xuất hiện (`0%`)**, chỉ còn giới hạn nhẹ phía cửa sổ nhận (`rwnd_limited: 3.2% – 8.6%`), `delivery_rate` mỗi luồng đạt ~`132.8 – 152.3 Mbps` lúc dồn burst.

---

## 7. Hướng đi tiếp theo — Pha 3 (dự kiến)
- Nâng cấp kênh truyền trực tiếp **WebRTC (`file-v7`)** áp dụng cơ chế đa kết nối / phân mảnh song song thông minh và điều chỉnh bộ đệm SCTP tương ứng cho môi trường WAN P2P.
- *(Ghi chú thao tác git: theo đúng yêu cầu, toàn bộ mã nguồn và báo cáo Pha 2 chưa tự động `git commit` hay `git push`.)*

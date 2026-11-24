# Báo cáo Tối ưu Truyền File — Pha 3 (WebRTC `file-v7` & Chính sách HTTPS-over-TURN)

- **Ngày thực hiện:** 2026-11-23
- **Mục tiêu:** Giải quyết các nút thắt còn lại của kênh truyền trực tiếp WebRTC P2P (`file-v5`/`file-v6`) gồm: khung dữ liệu nhỏ `16 KiB`, chia cắt đệm gửi `1 MiB`, Head-of-Line blocking khi chia round-robin tĩnh, trần cửa sổ ACK `8 MB`, băm SHA-256 trên Main Thread — đồng thời áp dụng chính sách mặc định **chuyển thẳng sang HTTPS 4 luồng Pha 2 thay vì đi qua TURN**, kèm công tắc bật/tắt `TURN` ngay trong phần cài đặt Nhà phát triển.
- **Release triển khai AWS (`13.211.243.90`):** **`20261123T170839Z-phase3`** (backend từ `20261123T162606Z-phase3` + frontend tối ưu đệm gửi/cửa sổ ACK `file-v7`; rollback pointer: `20261123T162606Z-phase3`).

---

## 1. Kiến trúc & các cải tiến chính của Pha 3 (`file-v7`)

### 1.1. Thông số giao thức `file-v7` (2 kết nối P2P mặc định cho tệp lớn)
| Thông số | Trước Pha 3 (`file-v5` / `file-v6`) | Pha 3 (`file-v7`) |
| --- | --- | --- |
| Kích thước khung (`maxChunkBytes`) | Cố định `16 KiB` (`16,384 B`) | Thương lượng tối đa **`64 KiB`** (`65,536 B`, kẹp theo `pc.sctp.maxMessageSize - 8`) |
| Số kết nối mặc định | Tệp nhỏ `<= 100 MiB`: 1 kênh `file-v5`<br>Tệp lớn `> 100 MiB`: 2 kết nối `file-v6` | Tệp nhỏ `<= 100 MiB`: **1 kết nối `file-v7`**<br>Tệp lớn `> 100 MiB`: **2 kết nối `file-v7`** (backend cho phép `1 / 2 / 4`) |
| Lập lịch gửi giữa nhiều kết nối | Round-robin tĩnh từng `16 KiB` (`position / 16 KiB % channels`) | **Work-stealing theo khối lớn** (`1 MiB` cho tệp `> 2 MiB`; `256 KiB` cho tệp `<= 2 MiB`), kết nối rảnh tự rút khối kế tiếp |
| Đệm gửi DataChannel | Chia đều `1 MiB / số kênh` (còn `512 KiB/kết nối` khi chạy 2 kết nối) | **Độc lập `512 KiB / mỗi kết nối`** (`1 MiB` tổng trên 2 kết nối `file-v7`), ngưỡng **`bufferedAmountLowThreshold = 256 KiB`** (`50%`) và `waitForBuffer` poll `50 ms` theo `Math.min(highWaterMark - nextBytes, bufferedAmountLowThreshold)` để tránh đánh thức sớm |
| Cửa sổ ACK ứng dụng (`fileFlowControl`) | Khởi đầu `2 MiB`, trần tối đa `8,000,000 B` | Khởi đầu **`4 MiB`**, tự mở rộng lên trần **`16 MiB`** (`16,777,216 B`) theo `ackWaitMs`, `bufferWaitMs` (`epochBufferWait`), dự phòng `4 MiB` (`WRITE_RESERVE_BYTES * 8`) khi `receiverWriteMs < 120 ms` |
| Ghi đĩa & SHA-256 | Ghi tuần tự `256 KiB` + `@noble/hashes` trên Main Thread phía nhận | Ghi **random-offset trực tiếp từng khối**, gộp ghi tuần tự tới **`4 MiB`** (`MAX_COALESCED_WRITE_BYTES`) + **Zero-copy Transferable** sang Worker (`createOrderedFileHasher`); phía gửi đọc trước 2 khối (`prefetched`) và băm một lượt cùng lúc truyền |
| Bắt tay & chịu lỗi NAT | Timeout cố định, đòi đủ toàn bộ kênh mới chạy | Hạn bắt tay backend **`60s`**, frontend timeout **`8s`** (khi tắt TURN và có HTTPS relay; `15s` ngược lại), xử lý `iceconnectionstatechange = 'failed'`, `waitReadyGrace(2000)` cho `file-v7` chạy tiếp trên kênh 0 khi kênh phụ bị NAT chặn, lỗi kênh tự fallback sang HTTPS multipart |
| Khả năng tương thích & DB | Không đổi SQL Schema | Không đổi SQL Schema; client cũ không có `supportsWebRtcV7` tự lùi sạch về `file-v6` / `file-v5` / `file-v4` / `file-v3` / `file-v1` |

### 1.2. Chính sách ưu tiên HTTPS 4 luồng thay TURN & công tắc Nhà phát triển
- **Khi tắt (mặc định ở chế độ thường):**
  1. `filterIceServers(iceServers, false)` lọc bỏ mọi URL `turn:` / `turns:` trước khi khởi tạo `RTCPeerConnection` (chỉ giữ lại `stun:` để đục lỗ P2P trực tiếp).
  2. Nếu không kết nối được P2P trực tiếp — hoặc nếu phát hiện `monitorFileRtc` đi qua route `turn` trong khi máy chủ có `supportsHttpFileRelay: true` — phiên tự động chuyển sang **4 luồng HTTPS Pha 2 (`?mode=multipart&connections=4`)**.
- **Khi bật trong Cài đặt → Nhà phát triển (`Cho phép chuyển tiếp qua TURN cho truyền file`):**
  - `FileTransferProvider` cập nhật trực tiếp `setAllowTurnForFiles(true)` trên trình quản lý đang chạy, giữ nguyên danh sách `turn:`/`turns:` và cho phép phiên WebRTC đi qua TURN khi cấu hình `WebRtc:IceServers` có sẵn server TURN.

---

## 2. Danh sách tệp thay đổi / bổ sung trong Pha 3

| Thành phần | Tệp | Vai trò chính |
| --- | --- | --- |
| Backend | `PBL4/Services/FileTransferService.cs` | Thêm `HighSpeedProtocol = "file-v7"`, `MaximumParallelFileConnections = 4`, hạn bắt tay `accepted` `60s`, cho phép `begin` ngay khi `Signals[0].Answered` với `file-v7` |
| Backend | `PBL4/Controllers/FilesController.cs` | Thêm `supportsWebRtcV7: true`, `maximumParallelFileConnections: 4`, `defaultParallelFileConnections: 2`, `v7MaxChunkBytes: 65536`, `v7BlockBytes: 1048576` trong `/api/v1/files/configuration` |
| Frontend Protocol | `frontend/src/services/fileProtocol.js` | Hằng số `HIGH_SPEED_PROTOCOL`, `V7_MAX_CHUNK_BYTES`, `V7_BLOCK_BYTES`, `V7_SEND_BUFFER_PER_CONNECTION` (`512 KiB`), `V7_INITIAL_FILE_WINDOW` (`4 MiB`), `V7_MAX_FILE_WINDOW` (`16 MiB`), `V7_MAX_OUT_OF_ORDER_BLOCKS` (`16`), `waitForBuffer()` kiểm tra `pollDrained` (`50 ms`) theo ngưỡng `bufferedAmountLowThreshold`, `filterIceServers()` |
| Frontend Flow Control | `frontend/src/services/fileFlowControl.js` | Thêm `maxWindowCap`, `slowWriteMs` (`300 ms` cho `file-v7`), `epochBufferWait`, `reserveBytes = 4 MiB`, và `waitedOnPipeline` dựa trên cả `ackWaitMs` lẫn `bufferWaitMs` để mở khóa cửa sổ `16 MiB` khi máy nhận ghi nhanh |
| Frontend Storage | `frontend/src/services/fileStorage.js` | `createOrderedFileHasher` dùng chung cho phía gửi/nhận, `createPartFileStorage` gộp ghi tuần tự tối đa `4 MiB` (`MAX_COALESCED_WRITE_BYTES`) giảm `receiverWriteMs` |
| Frontend Streaming | `frontend/src/services/fileStreamProtocol.js` | Kiểm tra chỗ trống đệm trước `claimNextBlock()` để không ôm khối trên kênh đầy đệm, ngưỡng `lowThreshold = 256 KiB` (`50%` của `512 KiB`), 2-block `prefetched` + `createOrderedFileHasher` băm một lượt, `waitReadyGrace(2000)` chạy tiếp trên kênh 0 khi kênh phụ lỗi NAT, `MAX_QUEUED_V7_WRITES = 8` |
| Frontend Manager & UI | `frontend/src/services/fileTransfers.js`, `App.jsx`, `realtime/FileTransferProvider.jsx`, `pages/SettingsPage.jsx`, `components/chat/FileMessageCard.jsx`, `pages/FilesPage.jsx`, `components/files/FileRtcDiagnostics.jsx` | Handshake timeout `8s`/`15s`, bắt `iceconnectionstatechange = 'failed'`, `sendFile().catch()` fallback sang HTTPS, lọc/chuyển `TURN → HTTPS`, công tắc Nhà phát triển, tách `multipart` 4 luồng khỏi `supportsDeferredRelayHash` |
| Backend Relay Fixes | `PBL4/Services/FileTransferService.Relay.cs` | Sửa fallback `0 byte` WebRTC → HTTPS multipart hoàn tất sạch không lỗi 400; cache kiểm tra tài khoản `5s` (`NeedsAccountCheck`) và bỏ query `FileTransfers` lặp trên từng mảnh `PUT`/`GET`/`ACK` sau khi phiên đã bắt đầu |
| Kiểm thử | `tests/file-v7-protocol.mjs` *(mới)*, `tests/file-offer-policy.mjs`, `tests/file-relay-multipart-http.mjs`, `tests/files.integration.mjs`, `tests/file-flow.e2e.mjs`, `tests/file-stream.e2e.mjs` | Unit test work-stealing / Worker SHA-256 / kẹp `maxChunkBytes` / neo `ACK` liên tiếp & chặn lệch 16 khối / lọc TURN, kiểm thử SignalR+SQL `file-v7` + `0-byte` fallback, và Chrome E2E `file-v7` + công tắc TURN |

---

## 3. Kết quả kiểm thử sau các chỉnh sửa cuối cùng

1. **JS Unit Tests, Lint & Build (chạy sau bản vá đệm gửi `512 KiB` & mở khóa cửa sổ `16 MiB`):**
   - `node --test` trên toàn bộ bộ unit thuần `tests/file-*.mjs` (không gồm `*.e2e.mjs`, `*-http.mjs`, `file-relay-protocol.mjs`): **88/88 PASS** (gồm test mới trong `tests/file-v7-protocol.mjs` xác nhận `bufferedAmountLowThreshold = 256 KiB` và `windowBytes` mở rộng từ `4 MiB` lên `16 MiB` ở mức `~4.5 MB/s`, `writeMs = 11 ms`) + `tests/file-relay-protocol.mjs` **PASS**.
   - `npm --prefix frontend run lint` (`oxlint`): **0 warnings, 0 errors** trên 67 tệp.
   - `npm --prefix frontend run build`: Thành công (`409ms` cho bản production).
2. **Playwright Chrome E2E sau bản vá cuối (`TRUNG`, DB tạm `PBL4_V7OptE2E_20261124000044`, Vite `5175`, Backend `5257`, đã dọn sạch và `DROP DATABASE`):**
   - `tests/file-flow.e2e.mjs`: **9/9 PASS**, gồm:
     - `normal mode automatically uses two v7 connections for 110 MB (23.99s, 4.59 MB/s), exact SHA-256 and concurrent chat`.
     - `Developer TURN toggle filters turn: ICE servers when OFF and retains them when ON`.
     - `WebRTC failure switches to HTTPS without stale WebRTC statistics, exact SHA-256`, fallback server cũ, `8` kênh `file-v5`, `2` kết nối `file-v7`, `2.1 MB · Cố định`, và hủy giữa chừng.
   - `tests/file-stream.e2e.mjs`: **24/24 PASS**.
3. **Các bộ backend `.NET` & SQL/HTTP Integration ở mốc bản dựng C# hiện hành (không sửa C# ở lượt tối ưu `file-v7` cuối):**
   - `dotnet build PBL4/PBL4.csproj`: **0 Error(s)**.
   - `tests/file-relay/FileRelayChecks.csproj`: **10/10 PASS**; `tests/presence/PresenceChecks.csproj`: **9/9 PASS**; `tests/monitoring/MonitoringChecks.csproj`: **15/15 PASS**.
   - `tests/file-relay-http.mjs`: **7/7 PASS**; `tests/file-relay-multipart-http.mjs`: **4/4 PASS**; `tests/files.integration.mjs`: **16/16 PASS**.

---

## 4. Triển khai AWS Production (`13.211.243.90`)

- **Release mới nhất:** **`20261123T170839Z-phase3`** (`/opt/pbl4/current` → `/opt/pbl4/releases/20261123T170839Z-phase3`, `/var/www/pbl4/frontend` → `/var/www/pbl4/releases/20261123T170839Z-phase3`).
- **Rollback pointer (`deployment.json`):** `/opt/pbl4/releases/20261123T162606Z-phase3` và `/var/www/pbl4/releases/20261123T162606Z-phase3`.
- **Bundle production đã xác minh:** **`index-XG7kPZAO.js`** (`456,452 B`, `sha256: bb5e4fc4d90c2c233278910b50c0af16cf80da4cfc1e823b27bbe1870b5fea79`, chứa đầy đủ 3 URL production `https://wiremess.io.vn/api/v1`, `https://rt.wiremess.io.vn/api/v1`, `https://rt.wiremess.io.vn/hubs/chat`) cùng `fileReceiveHashWorker-Dl9VAYMD.js` (`6,168 B`) và `fileHashWorker-BLJs4aRq.js` (`6,318 B`).
- **Xác minh thực tế:**
  - `systemctl is-active pbl4` trả `active`; `http://127.0.0.1:5000/health/ready` trên EC2 trả `Healthy`.
  - Cả `https://wiremess.io.vn/api/v1/files/configuration` và `https://rt.wiremess.io.vn/api/v1/files/configuration` trả HTTP `401`.
  - SHA-256 của `/assets/index-XG7kPZAO.js` tải từ cả `https://wiremess.io.vn` và `https://rt.wiremess.io.vn` đều khớp **`bb5e4fc4d90c2c233278910b50c0af16cf80da4cfc1e823b27bbe1870b5fea79`**.

*(Toàn bộ mã nguồn Pha 1, Pha 2, Pha 3 và 3 file báo cáo hiện vẫn giữ ở working tree theo yêu cầu, chưa `git commit` / `git push`.)*

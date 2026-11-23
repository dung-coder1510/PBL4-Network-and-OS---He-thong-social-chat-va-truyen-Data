using System.Globalization;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using PBL4.Contracts;
using PBL4.Data;
using PBL4.Models;
using PBL4.Realtime;

namespace PBL4.Services;

public sealed partial class FileTransferService(IServiceScopeFactory scopes,
    IHubContext<ChatHub, IChatClient> hub, PresenceTracker presence, MonitoringService monitoring)
{
    public const long MaximumFileBytes = 10L * 1024 * 1024 * 1024;
    public const long LegacyMaximumFileBytes = 100L * 1024 * 1024;
    public const int MaximumFileChannels = 8;
    private const int ParallelConnectionCount = 2;
    private const string DeferredHashProtocol = "file-v4";
    private const string MultichannelProtocol = "file-v5";
    private const string ParallelConnectionsProtocol = "file-v6";
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly Dictionary<long, EndpointPair> active = [];

    private sealed class EndpointPair(int senderId, int receiverId, string senderConnection)
    {
        public int SenderId { get; } = senderId;
        public int ReceiverId { get; } = receiverId;
        public string Sender { get; } = senderConnection;
        public string? Receiver { get; set; }
        public string? SenderSession { get; init; }
        public string? ReceiverSession { get; set; }
        public RelaySession? Relay { get; set; }
        public string[] SupportedProtocols { get; init; } = ["file-v1"];
        public string ProtocolVersion { get; set; } = "file-v1";
        public int RequestedChannelCount { get; init; } = 1;
        public int ChannelCount { get; set; } = 1;
        public DateTime Deadline { get; set; } = DateTime.UtcNow.AddSeconds(60);
        public ConnectionSignals[] Signals { get; set; } = [];
        public DateTime LastSenderReport { get; set; }
        public DateTime LastReceiverReport { get; set; }
        public string? SenderStage { get; set; }
        public string? ReceiverStage { get; set; }
        public long Size { get; set; }
        public long SenderBytes { get; set; }
        public long ReceiverBytes { get; set; }
    }

    private sealed class ConnectionSignals
    {
        public bool Offered { get; set; }
        public bool Answered { get; set; }
        public int SenderCandidates { get; set; }
        public int ReceiverCandidates { get; set; }
    }

    // Database chưa chạy migration vẫn nhận/gửi được bằng các phiên bản cũ.
    public static async Task<bool> SupportsDeferredHashAsync(AppDbContext db, CancellationToken ct = default)
        => await db.Database.SqlQueryRaw<int>(
            "SELECT ISNULL(COLUMNPROPERTY(OBJECT_ID(N'dbo.FileTransfers'), N'Sha256', 'AllowsNull'), 0) AS [Value]")
            .SingleAsync(ct) == 1;

    public Task<FileTransferDto> OfferAsync(int userId, string connectionId, OfferFileDto request, string? sessionId = null) =>
        CreateOfferAsync(userId, connectionId, request, sessionId, false);

    private async Task<FileTransferDto> CreateOfferAsync(int userId, string connectionId, OfferFileDto request,
        string? sessionId, bool relay)
    {
        if (!long.TryParse(request.ConversationId, NumberStyles.None, CultureInfo.InvariantCulture,
                out var conversationId) || conversationId <= 0 || request.ClientTransferId == Guid.Empty ||
            request.FileSizeBytes is < 0 or > MaximumFileBytes ||
            string.IsNullOrWhiteSpace(request.FileName) || request.FileName.Length > 255 ||
            request.FileName.Any(character => char.IsControl(character) || character is '/' or '\\'))
            throw new HubException("Thông tin tệp không hợp lệ (tối đa 10737.4 MB).");
        if (request.RequestedChannelCount is < 1 or > MaximumFileChannels ||
            request.SupportedProtocols is { Length: > 4 } || request.SupportedProtocols?.Any(protocol =>
                protocol is not ("file-v1" or "file-v2" or "file-v3" or DeferredHashProtocol or
                    MultichannelProtocol or ParallelConnectionsProtocol)) == true)
            throw new HubException("Giao thức hoặc số kênh truyền file không hợp lệ.");
        var protocols = request.SupportedProtocols is { Length: > 0 }
            ? request.SupportedProtocols.Distinct().ToArray() : ["file-v1"];
        var offersParallelConnections = protocols.Contains(ParallelConnectionsProtocol);
        if (offersParallelConnections && request.RequestedChannelCount != ParallelConnectionCount)
            throw new HubException("Chế độ hai kết nối cần đúng hai kênh.");
        if (request.RequestedChannelCount > 1 && !offersParallelConnections && !protocols.Contains(MultichannelProtocol))
            throw new HubException("Truyền từ 2 đến 8 kênh cần giao thức đa kênh.");
        var deferredHash = !relay && request.Sha256Hex is null &&
            protocols.All(protocol => protocol is DeferredHashProtocol or MultichannelProtocol or ParallelConnectionsProtocol);
        if (protocols.Contains(DeferredHashProtocol) && (!deferredHash || request.FileSizeBytes <= LegacyMaximumFileBytes))
            throw new HubException("Lời mời file-v4 chỉ dùng cho tệp lớn và chốt SHA-256 trong lúc truyền.");
        if (!relay && request.FileSizeBytes > LegacyMaximumFileBytes && !protocols.Any(protocol =>
                protocol is "file-v3" or DeferredHashProtocol or MultichannelProtocol or ParallelConnectionsProtocol))
            throw new HubException("Tệp trên 104.9 MB cần phiên bản truyền theo luồng mới ở cả hai máy.");
        var hash = deferredHash ? null : ParseHash(request.Sha256Hex);
        await gate.WaitAsync();
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var conversation = await db.DirectConversations.AsNoTracking()
                .SingleOrDefaultAsync(item => item.Id == conversationId &&
                    (item.UserAID == userId || item.UserBID == userId));
            if (conversation is null) throw new HubException("Không tìm thấy cuộc trò chuyện.");
            var receiverId = conversation.UserAID == userId ? conversation.UserBID : conversation.UserAID;
            if (!await db.Users.AnyAsync(item => item.Id == receiverId && !item.IsDisabled))
                throw new HubException("Người nhận không khả dụng.");
            var existing = await db.FileTransfers.SingleOrDefaultAsync(item =>
                item.SenderId == userId && item.ClientTransferId == request.ClientTransferId);
            if (existing is not null)
            {
                if (existing.ConversationId != conversationId || existing.FileName != request.FileName ||
                    existing.FileSizeBytes != request.FileSizeBytes ||
                    (hash is not null && (existing.Sha256 is null || !existing.Sha256.SequenceEqual(hash))))
                    throw new HubException("Mã truyền tệp đã được dùng cho tệp khác.");
                return ToDto(existing, receiverId, active.GetValueOrDefault(existing.Id));
            }
            if (!relay && presence.GetValidConnectionIds([receiverId]).Count == 0)
                throw new HubException("Người nhận cần mở ứng dụng để nhận tệp.");
            if (active.Count >= 1000 || active.Values.Count(item =>
                    item.SenderId == userId || item.ReceiverId == userId) >= 2 ||
                active.Values.Count(item => item.SenderId == receiverId || item.ReceiverId == receiverId) >= 2)
                throw new HubException("Tối đa 2 phiên truyền đang chờ hoặc đang chạy mỗi tài khoản.");
            if (deferredHash && !await SupportsDeferredHashAsync(db))
                throw new HubException("Database chưa hỗ trợ chốt SHA-256 trong lúc truyền. Vui lòng tải lại trang.");
            var transfer = new FileTransfer
            {
                ConversationId = conversationId, ClientTransferId = request.ClientTransferId,
                SenderId = userId, FileName = request.FileName, FileSizeBytes = request.FileSizeBytes,
                Sha256 = hash, CreatedAt = DateTime.UtcNow
            };
            db.FileTransfers.Add(transfer);
            await db.SaveChangesAsync();
            var endpoints = new EndpointPair(userId, receiverId, connectionId)
            {
                Size = transfer.FileSizeBytes,
                SupportedProtocols = protocols,
                RequestedChannelCount = request.RequestedChannelCount,
                SenderSession = sessionId,
                Relay = relay ? new RelaySession(sessionId!) : null
            };
            active.Add(transfer.Id, endpoints);
            return await PublishAsync(transfer, endpoints);
        }
        finally { gate.Release(); }
    }

    public async Task<FileTransferDto> ActAsync(int userId, string connectionId,
        FileActionDto request, string action, CompleteFileDto? completed = null, string? sourceHash = null,
        string? sessionId = null)
    {
        var id = ParseId(request.TransferId);
        await gate.WaitAsync();
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var transfer = await db.FileTransfers.Include(item => item.Conversation)
                .SingleOrDefaultAsync(item => item.Id == id &&
                    (item.Conversation.UserAID == userId || item.Conversation.UserBID == userId));
            if (transfer is null) throw new HubException("Không tìm thấy phiên truyền.");
            var endpoints = active.GetValueOrDefault(id);
            if (endpoints is null)
                throw new HubException("Phiên truyền đã kết thúc. Hãy tải lại danh sách.");
            if (endpoints.Relay is not null)
                throw new HubException("Phiên truyền đang dùng HTTPS.");
            if (Convert.ToBase64String(transfer.RowVersion) != request.ExpectedVersion)
                throw new HubException("Trạng thái đã thay đổi ở tab khác. Hãy thử lại.");
            var sender = userId == endpoints.SenderId && connectionId == endpoints.Sender;
            var receiver = userId == endpoints.ReceiverId &&
                (endpoints.Receiver is null || connectionId == endpoints.Receiver);
            if (!sender && !receiver) throw new HubException("Phiên truyền thuộc tab khác.");
            if (action is not ("fail" or "cancel") &&
                await db.Users.AnyAsync(item => (item.Id == endpoints.SenderId ||
                    item.Id == endpoints.ReceiverId) && item.IsDisabled))
                throw new HubException("Tài khoản không khả dụng.");
            if (endpoints.Deadline <= DateTime.UtcNow)
                throw new HubException("Phiên truyền đã hết thời gian chờ.");
            switch (action)
            {
                case "accept" when receiver && transfer.Status == "offered":
                    if (!presence.GetValidConnectionIds([endpoints.SenderId]).Contains(endpoints.Sender))
                        throw new HubException("Tab gửi đã ngắt kết nối.");
                    var protocol = request.ProtocolVersion ?? "file-v1";
                    var parallelConnections = protocol == ParallelConnectionsProtocol;
                    var maxChannels = protocol is MultichannelProtocol or ParallelConnectionsProtocol
                        ? endpoints.RequestedChannelCount : 1;
                    if (request.ChannelCount < 1 || request.ChannelCount > maxChannels ||
                        parallelConnections && request.ChannelCount != ParallelConnectionCount ||
                        !endpoints.SupportedProtocols.Contains(protocol) ||
                        transfer.FileSizeBytes > LegacyMaximumFileBytes &&
                        protocol is not ("file-v3" or DeferredHashProtocol or MultichannelProtocol or ParallelConnectionsProtocol))
                        throw new HubException("Hai tab chưa hỗ trợ cùng giao thức truyền file.");
                    endpoints.ProtocolVersion = protocol;
                    endpoints.ChannelCount = request.ChannelCount;
                    endpoints.Signals = parallelConnections ? [new(), new()] : [new()];
                    endpoints.Receiver = connectionId;
                    endpoints.ReceiverSession = sessionId;
                    endpoints.Deadline = DateTime.UtcNow.AddSeconds(45);
                    transfer.AcceptedAt = DateTime.UtcNow;
                    transfer.Status = "accepted";
                    break;
                case "reject" when receiver && transfer.Status == "offered":
                    transfer.Status = "rejected";
                    break;
                case "begin" when sender && transfer.Status == "accepted" && endpoints.Signals.All(signals => signals.Answered):
                    transfer.Status = "transferring";
                    endpoints.Deadline = DateTime.UtcNow.AddMinutes(30);
                    break;
                case "hash" when sender && transfer.Status == "transferring" &&
                    endpoints.ProtocolVersion is DeferredHashProtocol or MultichannelProtocol or ParallelConnectionsProtocol:
                    var digest = ParseHash(sourceHash);
                    if (transfer.Sha256 is not null)
                    {
                        if (!transfer.Sha256.SequenceEqual(digest))
                            throw new HubException("SHA-256 của bên gửi đã được chốt.");
                        return ToDto(transfer, endpoints.ReceiverId, endpoints);
                    }
                    transfer.Sha256 = digest;
                    break;
                case "complete" when receiver && transfer.Status == "transferring" && completed is not null:
                    var verified = ParseHash(completed.VerifiedSha256Hex);
                    if (transfer.Sha256 is null)
                        throw new HubException("Bên gửi chưa chốt SHA-256 cho phiên truyền.");
                    if (completed.ReceivedBytes != transfer.FileSizeBytes || !verified.SequenceEqual(transfer.Sha256))
                        throw new HubException("Số byte hoặc SHA-256 không khớp.");
                    transfer.VerifiedSha256 = verified;
                    transfer.Status = "completed";
                    break;
                case "cancel" when sender || receiver:
                    transfer.Status = "cancelled";
                    break;
                case "fail" when sender || receiver:
                    // Chỉ lưu mã thuộc allowlist, không lưu thông báo lỗi tùy ý từ client.
                    // Gắn nguồn báo cáo; đây là lời khai client, không phải chẩn đoán chắc chắn.
                    var reason = request.FailureCode is "HASH_MISMATCH" or "WEBRTC_FAILED" or "TRANSFER_TIMEOUT" or "INVALID_CHUNK"
                        ? request.FailureCode : "UNKNOWN";
                    monitoring.File(request.TransferId, sender ? "client-A" : "client-B", "failure-report", reason: reason);
                    transfer.Status = "failed";
                    break;
                default: throw new HubException("Thao tác không phù hợp trạng thái phiên truyền.");
            }
            if (transfer.Status is not ("offered" or "accepted" or "transferring"))
                transfer.FinishedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
            if (transfer.FinishedAt.HasValue) active.Remove(id);
            return await PublishAsync(transfer, endpoints);
        }
        finally { gate.Release(); }
    }

    // Telemetry không thay đổi trạng thái nghiệp vụ. Giới hạn 1 mẫu/5 giây mỗi đầu,
    // kiểm tra đúng tài khoản/tab và phiên còn hoạt động trước khi nhận báo cáo.
    public async Task ReportAsync(int userId, string connectionId, FileObservationDto report)
    {
        var id = ParseId(report.TransferId);
        if (report.Stage is not ("channel-open" or "transferring" or "verifying" or "failed") ||
            report.Bytes < 0 || report.Bytes > MaximumFileBytes ||
            report.Reason is not (null or "UNKNOWN" or "HASH_MISMATCH" or "WEBRTC_FAILED" or "TRANSFER_TIMEOUT" or "INVALID_CHUNK"))
            throw new HubException("Báo cáo không hợp lệ.");
        await gate.WaitAsync();
        try
        {
            if (!active.TryGetValue(id, out var pair) || pair.Relay is not null) return;
            var sender = pair.SenderId == userId && pair.Sender == connectionId;
            var receiver = pair.ReceiverId == userId && pair.Receiver == connectionId;
            if (!sender && !receiver) throw new HubException("Báo cáo thuộc tab khác.");
            var now = DateTime.UtcNow;
            if (pair.Deadline <= now || report.Bytes > pair.Size ||
                report.Bytes < (sender ? pair.SenderBytes : pair.ReceiverBytes)) return;
            static int Rank(string? stage) => stage switch { "channel-open" => 1, "transferring" => 2, "verifying" => 3, "failed" => 4, _ => 0 };
            var previousStage = sender ? pair.SenderStage : pair.ReceiverStage;
            if (Rank(report.Stage) < Rank(previousStage) || sender && report.Stage == "verifying") return;
            // Đổi giai đoạn được báo ngay; mẫu tiến độ cùng giai đoạn tối đa mỗi 5 giây.
            if (report.Stage == previousStage && now - (sender ? pair.LastSenderReport : pair.LastReceiverReport) < TimeSpan.FromSeconds(5)) return;
            if (sender) { pair.LastSenderReport = now; pair.SenderStage = report.Stage; pair.SenderBytes = report.Bytes ?? pair.SenderBytes; }
            else { pair.LastReceiverReport = now; pair.ReceiverStage = report.Stage; pair.ReceiverBytes = report.Bytes ?? pair.ReceiverBytes; }
            monitoring.File(report.TransferId, sender ? "client-A" : "client-B", report.Stage, report.Bytes, report.Reason);
        }
        finally { gate.Release(); }
    }

    public async Task SignalAsync(int userId, string connectionId, FileSignalDto signal)
    {
        var id = ParseId(signal.TransferId);
        if (signal.Payload is null || signal.Payload.Length > (signal.Kind == "ice" ? 4096 : 24000))
            throw new HubException("Báo hiệu quá lớn.");
        await gate.WaitAsync();
        try
        {
            if (!active.TryGetValue(id, out var endpoints) || endpoints.Relay is not null || endpoints.Receiver is null ||
                endpoints.Deadline <= DateTime.UtcNow)
                throw new HubException("Phiên báo hiệu không còn hiệu lực.");
            var sender = userId == endpoints.SenderId && connectionId == endpoints.Sender;
            var receiver = userId == endpoints.ReceiverId && connectionId == endpoints.Receiver;
            if (!sender && !receiver) throw new HubException("Báo hiệu thuộc tab khác.");
            if (signal.ConnectionIndex < 0 || signal.ConnectionIndex >= endpoints.Signals.Length)
                throw new HubException("Chỉ số kết nối báo hiệu không hợp lệ.");
            var signals = endpoints.Signals[signal.ConnectionIndex];
            if (!presence.GetValidConnectionIds([endpoints.SenderId, endpoints.ReceiverId])
                    .Contains(sender ? endpoints.Receiver : endpoints.Sender))
                throw new HubException("Tab bên kia đã ngắt kết nối.");
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            if (await db.Users.AnyAsync(item =>
                    (item.Id == endpoints.SenderId || item.Id == endpoints.ReceiverId) && item.IsDisabled))
                throw new HubException("Tài khoản không khả dụng.");
            if (signal.Kind == "offer" && sender && !signals.Offered)
                signals.Offered = true;
            else if (signal.Kind == "answer" && receiver && signals.Offered && !signals.Answered)
                signals.Answered = true;
            else if (signal.Kind == "ice")
            {
                if (sender ? ++signals.SenderCandidates > 128 : ++signals.ReceiverCandidates > 128)
                    throw new HubException("Quá nhiều ICE candidate.");
                try
                {
                    using var document = JsonDocument.Parse(signal.Payload);
                    if (document.RootElement.ValueKind != JsonValueKind.Object)
                        throw new JsonException();
                }
                catch (JsonException) { throw new HubException("ICE candidate không hợp lệ."); }
            }
            else throw new HubException("Thứ tự báo hiệu không hợp lệ.");
            await hub.Clients.Client(sender ? endpoints.Receiver : endpoints.Sender).FileSignal(signal);
            if (signal.Kind != "ice") monitoring.File(signal.TransferId, "backend", signal.Kind);
        }
        finally { gate.Release(); }
    }

    public async Task SweepAsync(string? disconnectedConnection = null)
    {
        await gate.WaitAsync();
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var query = db.FileTransfers.Include(item => item.Conversation)
                .Where(item => item.Status == "offered" || item.Status == "accepted" ||
                    item.Status == "transferring");
            if (disconnectedConnection is not null)
            {
                var affected = active.Where(pair => pair.Value.Relay is null &&
                    (pair.Value.Sender == disconnectedConnection || pair.Value.Receiver == disconnectedConnection))
                    .Select(pair => pair.Key).ToArray();
                if (affected.Length == 0) return;
                query = query.Where(item => affected.Contains(item.Id));
            }
            var transfers = await query.ToListAsync();
            if (transfers.Count == 0) return;
            var userIds = transfers.SelectMany(item =>
                new[] { item.Conversation.UserAID, item.Conversation.UserBID }).Distinct().ToArray();
            var disabled = await db.Users.Where(item => item.IsDisabled && userIds.Contains(item.Id))
                .Select(item => item.Id).ToListAsync();
            foreach (var transfer in transfers)
            {
                var endpoints = active.GetValueOrDefault(transfer.Id);
                var receiverId = transfer.Conversation.UserAID == transfer.SenderId
                    ? transfer.Conversation.UserBID : transfer.Conversation.UserAID;
                if (endpoints?.Relay is { } relay)
                {
                    if (!relay.IsIdle && !disabled.Contains(endpoints.SenderId) && !disabled.Contains(endpoints.ReceiverId))
                        continue;
                    await FinishRelayAsync(db, transfer, endpoints, transfer.Status == "offered" ? "expired" : "failed");
                    continue;
                }
                var connected = presence.GetValidConnectionIds([transfer.SenderId, receiverId]);
                if (endpoints is not null && endpoints.Deadline > DateTime.UtcNow &&
                    endpoints.Sender != disconnectedConnection &&
                    (disconnectedConnection is null || endpoints.Receiver != disconnectedConnection) &&
                    connected.Contains(endpoints.Sender) &&
                    (endpoints.Receiver is null || connected.Contains(endpoints.Receiver)) &&
                    !disabled.Contains(transfer.SenderId) && !disabled.Contains(receiverId)) continue;
                var failureReason = endpoints is null ? "SERVER_STATE_LOST"
                    : disabled.Contains(transfer.SenderId) || disabled.Contains(receiverId) ? "ACCOUNT_DISABLED"
                    : endpoints.Deadline <= DateTime.UtcNow ? (transfer.Status == "offered" ? "OFFER_TIMEOUT" : "TRANSFER_TIMEOUT")
                    : "ENDPOINT_DISCONNECTED";
                monitoring.File(transfer.Id.ToString(CultureInfo.InvariantCulture), "backend", "failure-report", reason: failureReason);
                transfer.Status = transfer.Status == "offered" ? "expired" : "failed";
                transfer.FinishedAt = DateTime.UtcNow;
                await db.SaveChangesAsync();
                active.Remove(transfer.Id);
                await PublishAsync(transfer, endpoints ??
                    new EndpointPair(transfer.SenderId, receiverId, ""));
            }
        }
        finally { gate.Release(); }
    }

    // Loc rieng conversation khi mo chat; van kiem tra thanh vien o moi truy van lich su file.
    public async Task<FilePageDto> ListAsync(int userId, long? beforeId, long? conversationId = null)
    {
        await gate.WaitAsync();
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var rows = await db.FileTransfers.AsNoTracking().Include(item => item.Conversation)
                .Where(item => (item.Conversation.UserAID == userId || item.Conversation.UserBID == userId) &&
                    (!conversationId.HasValue || item.ConversationId == conversationId.Value) &&
                    (!beforeId.HasValue || item.Id < beforeId.Value))
                .OrderByDescending(item => item.Id).Take(51).ToListAsync();
            var more = rows.Count > 50;
            var items = rows.Take(50).Select(item => ToDto(item,
                item.Conversation.UserAID == item.SenderId ? item.Conversation.UserBID : item.Conversation.UserAID,
                active.GetValueOrDefault(item.Id))).ToArray();
            return new FilePageDto(items, more ? items[^1].Id : null);
        }
        finally { gate.Release(); }
    }

    private async Task<FileTransferDto> PublishAsync(FileTransfer transfer, EndpointPair endpoints)
    {
        var dto = ToDto(transfer, endpoints.ReceiverId, endpoints);
        monitoring.File(dto.Id, "backend", dto.Status, reason: dto.Status == "failed" ? "UNKNOWN" : null);
        var connections = presence.GetValidConnectionIds([endpoints.SenderId, endpoints.ReceiverId]);
        if (connections.Count > 0) await hub.Clients.Clients(connections).FileChanged(dto);
        return dto;
    }

    private static FileTransferDto ToDto(FileTransfer transfer, int receiverId, EndpointPair? endpoints) => new(
        transfer.Id.ToString(CultureInfo.InvariantCulture), transfer.ClientTransferId,
        transfer.ConversationId.ToString(CultureInfo.InvariantCulture), transfer.SenderId, receiverId,
        transfer.FileName, transfer.FileSizeBytes,
        transfer.Sha256 is null ? null : Convert.ToHexString(transfer.Sha256).ToLowerInvariant(),
        transfer.VerifiedSha256 is null ? null : Convert.ToHexString(transfer.VerifiedSha256).ToLowerInvariant(),
        transfer.Status, DateTime.SpecifyKind(transfer.CreatedAt, DateTimeKind.Utc),
        transfer.AcceptedAt.HasValue ? DateTime.SpecifyKind(transfer.AcceptedAt.Value, DateTimeKind.Utc) : null,
        transfer.FinishedAt.HasValue ? DateTime.SpecifyKind(transfer.FinishedAt.Value, DateTimeKind.Utc) : null,
        Convert.ToBase64String(transfer.RowVersion), endpoints?.Sender, endpoints?.Receiver,
        endpoints?.SupportedProtocols ?? ["file-v1"],
        endpoints?.ProtocolVersion, endpoints?.ChannelCount ?? 1, endpoints?.RequestedChannelCount ?? 1,
        endpoints?.Relay is null ? null : "https", endpoints?.Relay?.ReceiverReady ?? false,
        endpoints?.Relay?.ForwardedBytes ?? 0, endpoints?.Relay?.ConnectionCount ?? 1);

    private static long ParseId(string value) =>
        long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var id) && id > 0
            ? id : throw new HubException("Mã phiên truyền không hợp lệ.");

    private static byte[] ParseHash(string? value)
    {
        if (value is null || value.Length != 64 || !value.All(Uri.IsHexDigit))
            throw new HubException("SHA-256 phải gồm 64 ký tự hex.");
        return Convert.FromHexString(value);
    }
}

using System.Globalization;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using PBL4.Contracts;
using PBL4.Data;
using PBL4.Models;
using PBL4.Realtime;

namespace PBL4.Services;

public sealed class FileTransferService(IServiceScopeFactory scopes,
    IHubContext<ChatHub, IChatClient> hub, PresenceTracker presence)
{
    public const long MaximumFileBytes = 100 * 1024 * 1024;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly Dictionary<long, EndpointPair> active = [];

    private sealed class EndpointPair(int senderId, int receiverId, string senderConnection)
    {
        public int SenderId { get; } = senderId;
        public int ReceiverId { get; } = receiverId;
        public string Sender { get; } = senderConnection;
        public string? Receiver { get; set; }
        public DateTime Deadline { get; set; } = DateTime.UtcNow.AddSeconds(60);
        public bool Offered { get; set; }
        public bool Answered { get; set; }
        public int SenderCandidates { get; set; }
        public int ReceiverCandidates { get; set; }
    }

    public async Task<FileTransferDto> OfferAsync(int userId, string connectionId, OfferFileDto request)
    {
        if (!long.TryParse(request.ConversationId, NumberStyles.None, CultureInfo.InvariantCulture,
                out var conversationId) || conversationId <= 0 || request.ClientTransferId == Guid.Empty ||
            request.FileSizeBytes is < 0 or > MaximumFileBytes ||
            string.IsNullOrWhiteSpace(request.FileName) || request.FileName.Length > 255 ||
            request.FileName.Any(character => char.IsControl(character) || character is '/' or '\\'))
            throw new HubException("Thông tin tệp không hợp lệ (tối đa 100 MiB).");
        var hash = ParseHash(request.Sha256Hex);
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
                    existing.FileSizeBytes != request.FileSizeBytes || !existing.Sha256.SequenceEqual(hash))
                    throw new HubException("Mã truyền tệp đã được dùng cho tệp khác.");
                return ToDto(existing, receiverId, active.GetValueOrDefault(existing.Id));
            }
            if (presence.GetValidConnectionIds([receiverId]).Count == 0)
                throw new HubException("Người nhận cần mở ứng dụng để nhận tệp.");
            if (active.Count >= 1000 || active.Values.Count(item =>
                    item.SenderId == userId || item.ReceiverId == userId) >= 2 ||
                active.Values.Count(item => item.SenderId == receiverId || item.ReceiverId == receiverId) >= 2)
                throw new HubException("Tối đa 2 phiên truyền đang chờ hoặc đang chạy mỗi tài khoản.");
            var transfer = new FileTransfer
            {
                ConversationId = conversationId, ClientTransferId = request.ClientTransferId,
                SenderId = userId, FileName = request.FileName, FileSizeBytes = request.FileSizeBytes,
                Sha256 = hash, CreatedAt = DateTime.UtcNow
            };
            db.FileTransfers.Add(transfer);
            await db.SaveChangesAsync();
            var endpoints = new EndpointPair(userId, receiverId, connectionId);
            active.Add(transfer.Id, endpoints);
            return await PublishAsync(transfer, endpoints);
        }
        finally { gate.Release(); }
    }

    public async Task<FileTransferDto> ActAsync(int userId, string connectionId,
        FileActionDto request, string action, CompleteFileDto? completed = null)
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
                    endpoints.Receiver = connectionId;
                    endpoints.Deadline = DateTime.UtcNow.AddSeconds(45);
                    transfer.AcceptedAt = DateTime.UtcNow;
                    transfer.Status = "accepted";
                    break;
                case "reject" when receiver && transfer.Status == "offered":
                    transfer.Status = "rejected";
                    break;
                case "begin" when sender && transfer.Status == "accepted" && endpoints.Answered:
                    transfer.Status = "transferring";
                    endpoints.Deadline = DateTime.UtcNow.AddMinutes(30);
                    break;
                case "complete" when receiver && transfer.Status == "transferring" && completed is not null:
                    var verified = ParseHash(completed.VerifiedSha256Hex);
                    if (completed.ReceivedBytes != transfer.FileSizeBytes || !verified.SequenceEqual(transfer.Sha256))
                        throw new HubException("Số byte hoặc SHA-256 không khớp.");
                    transfer.VerifiedSha256 = verified;
                    transfer.Status = "completed";
                    break;
                case "cancel" when sender || receiver:
                    transfer.Status = "cancelled";
                    break;
                case "fail" when sender || receiver:
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

    public async Task SignalAsync(int userId, string connectionId, FileSignalDto signal)
    {
        var id = ParseId(signal.TransferId);
        if (signal.Payload is null || signal.Payload.Length > (signal.Kind == "ice" ? 4096 : 24000))
            throw new HubException("Báo hiệu quá lớn.");
        await gate.WaitAsync();
        try
        {
            if (!active.TryGetValue(id, out var endpoints) || endpoints.Receiver is null ||
                endpoints.Deadline <= DateTime.UtcNow)
                throw new HubException("Phiên báo hiệu không còn hiệu lực.");
            var sender = userId == endpoints.SenderId && connectionId == endpoints.Sender;
            var receiver = userId == endpoints.ReceiverId && connectionId == endpoints.Receiver;
            if (!sender && !receiver) throw new HubException("Báo hiệu thuộc tab khác.");
            if (!presence.GetValidConnectionIds([endpoints.SenderId, endpoints.ReceiverId])
                    .Contains(sender ? endpoints.Receiver : endpoints.Sender))
                throw new HubException("Tab bên kia đã ngắt kết nối.");
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            if (await db.Users.AnyAsync(item =>
                    (item.Id == endpoints.SenderId || item.Id == endpoints.ReceiverId) && item.IsDisabled))
                throw new HubException("Tài khoản không khả dụng.");
            if (signal.Kind == "offer" && sender && !endpoints.Offered)
                endpoints.Offered = true;
            else if (signal.Kind == "answer" && receiver && endpoints.Offered && !endpoints.Answered)
                endpoints.Answered = true;
            else if (signal.Kind == "ice")
            {
                if (sender ? ++endpoints.SenderCandidates > 128 : ++endpoints.ReceiverCandidates > 128)
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
                var affected = active.Where(pair => pair.Value.Sender == disconnectedConnection ||
                    pair.Value.Receiver == disconnectedConnection).Select(pair => pair.Key).ToArray();
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
                var connected = presence.GetValidConnectionIds([transfer.SenderId, receiverId]);
                if (endpoints is not null && endpoints.Deadline > DateTime.UtcNow &&
                    endpoints.Sender != disconnectedConnection &&
                    (disconnectedConnection is null || endpoints.Receiver != disconnectedConnection) &&
                    connected.Contains(endpoints.Sender) &&
                    (endpoints.Receiver is null || connected.Contains(endpoints.Receiver)) &&
                    !disabled.Contains(transfer.SenderId) && !disabled.Contains(receiverId)) continue;
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

    public async Task<FilePageDto> ListAsync(int userId, long? beforeId)
    {
        await gate.WaitAsync();
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var rows = await db.FileTransfers.AsNoTracking().Include(item => item.Conversation)
                .Where(item => (item.Conversation.UserAID == userId || item.Conversation.UserBID == userId) &&
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
        var connections = presence.GetValidConnectionIds([endpoints.SenderId, endpoints.ReceiverId]);
        if (connections.Count > 0) await hub.Clients.Clients(connections).FileChanged(dto);
        return dto;
    }

    private static FileTransferDto ToDto(FileTransfer transfer, int receiverId, EndpointPair? endpoints) => new(
        transfer.Id.ToString(CultureInfo.InvariantCulture), transfer.ClientTransferId,
        transfer.ConversationId.ToString(CultureInfo.InvariantCulture), transfer.SenderId, receiverId,
        transfer.FileName, transfer.FileSizeBytes, Convert.ToHexString(transfer.Sha256).ToLowerInvariant(),
        transfer.VerifiedSha256 is null ? null : Convert.ToHexString(transfer.VerifiedSha256).ToLowerInvariant(),
        transfer.Status, DateTime.SpecifyKind(transfer.CreatedAt, DateTimeKind.Utc),
        transfer.AcceptedAt.HasValue ? DateTime.SpecifyKind(transfer.AcceptedAt.Value, DateTimeKind.Utc) : null,
        transfer.FinishedAt.HasValue ? DateTime.SpecifyKind(transfer.FinishedAt.Value, DateTimeKind.Utc) : null,
        Convert.ToBase64String(transfer.RowVersion), endpoints?.Sender, endpoints?.Receiver);

    private static long ParseId(string value) =>
        long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var id) && id > 0
            ? id : throw new HubException("Mã phiên truyền không hợp lệ.");

    private static byte[] ParseHash(string value)
    {
        if (value is null || value.Length != 64 || !value.All(Uri.IsHexDigit))
            throw new HubException("SHA-256 phải gồm 64 ký tự hex.");
        return Convert.FromHexString(value);
    }
}

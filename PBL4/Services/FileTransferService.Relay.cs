using System.Globalization;
using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using PBL4.Contracts;
using PBL4.Data;
using PBL4.Models;

namespace PBL4.Services;

public sealed partial class FileTransferService
{
    private const int MaximumLiveRelays = 16;
    private const string RelayConflict = "Phiên chuyển tiếp đã đổi trạng thái. Hãy kiểm tra thẻ file.";

    private sealed record RelayBody(FileRelayPipe Pipe, FileRelayContent Content);

    private sealed class RelaySession
    {
        private long lastProgress = Environment.TickCount64;
        private long lastAccountCheck = Environment.TickCount64;
        private long forwardedBytes;

        public RelaySession(string senderSession, bool multipart = false, int connectionCount = 1)
        {
            SenderSession = senderSession;
            IsMultipart = multipart;
            ConnectionCount = connectionCount;
            PartBytes = multipart ? FileRelayPartStore.DefaultPartBytes : null;
            SenderKey = Convert.ToHexString(RandomNumberGenerator.GetBytes(24));
        }

        public string SenderSession { get; }
        public string SenderKey { get; }
        public bool IsMultipart { get; }
        public int? PartBytes { get; }
        public string? ReceiverSession { get; set; }
        public string? Key { get; set; }
        public bool ReceiverReady { get; set; }
        public bool MultipartStarted { get; set; }
        public int ConnectionCount { get; set; }
        public bool[] UploadClaimed { get; set; } = [];
        public FileRelayPartStore? PartStore { get; set; }
        public CancellationTokenSource Ended { get; } = new();
        public TaskCompletionSource<RelayBody> Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource<string> HashReady { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Drained { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource<FileTransferDto> Finished { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public string? Mode => IsMultipart ? "multipart" : null;
        public bool HasStarted => IsMultipart ? MultipartStarted : Started.Task.IsCompleted;
        public bool IsTransferring => IsMultipart ? MultipartStarted : Started.Task.IsCompletedSuccessfully;
        public long ForwardedBytes => Interlocked.Read(ref forwardedBytes);
        public bool IsIdle => Environment.TickCount64 - Interlocked.Read(ref lastProgress) >=
            (ReceiverReady && !HasStarted ? 300_000 : 60_000);
        public bool NeedsAccountCheck => Environment.TickCount64 - Interlocked.Read(ref lastAccountCheck) >= 5_000;
        public void Touch() => Interlocked.Exchange(ref lastProgress, Environment.TickCount64);
        public void MarkAccountsChecked() => Interlocked.Exchange(ref lastAccountCheck, Environment.TickCount64);
        public void Forward(int size) { Interlocked.Add(ref forwardedBytes, size); Touch(); }
    }

    public Task<FileTransferDto> OfferRelayAsync(int userId, string sessionId, OfferFileDto request) =>
        CreateOfferAsync(userId, "", request, sessionId, true);

    public async Task<(FileTransferDto Transfer, string? SenderKey)> OfferRelayWithKeyAsync(
        int userId, string sessionId, OfferFileDto request)
    {
        var transfer = await CreateOfferAsync(userId, "", request, sessionId, true);
        await gate.WaitAsync();
        try
        {
            var id = ParseId(transfer.Id);
            var key = active.GetValueOrDefault(id)?.Relay?.SenderKey;
            return (transfer, key);
        }
        finally { gate.Release(); }
    }

    public async Task<FileTransferDto> GetFileAsync(long id, int userId)
    {
        await gate.WaitAsync();
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var transfer = await FindRelayTransferAsync(db, id, userId);
            var receiverId = transfer.Conversation.UserAID == transfer.SenderId
                ? transfer.Conversation.UserBID : transfer.Conversation.UserAID;
            return ToDto(transfer, receiverId, active.GetValueOrDefault(id));
        }
        finally { gate.Release(); }
    }

    public async Task<(FileTransferDto Transfer, string? SenderKey)> SwitchRelayAsync(long id, int userId,
        string sessionId, string? mode = null, int connections = 4)
    {
        if (mode is not null && mode != "multipart")
            throw new FileRelayException(400, "Chế độ chuyển tiếp tệp không hợp lệ.");
        if (mode == "multipart" && connections is not (1 or 2 or 4))
            throw new FileRelayException(400, "Chế độ đa phần cần 1, 2 hoặc 4 kết nối.");
        await gate.WaitAsync();
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var transfer = await FindRelayTransferAsync(db, id, userId);
            if (!active.TryGetValue(id, out var endpoints) || endpoints.SenderSession is null)
                throw new FileRelayException(409, RelayConflict);
            if (!(userId == endpoints.SenderId && sessionId == endpoints.SenderSession) &&
                !(userId == endpoints.ReceiverId && sessionId == endpoints.ReceiverSession))
                throw new FileRelayException(403, "Phiên truyền thuộc tab khác.");
            if (endpoints.Relay is not null)
            {
                var existingKey = userId == endpoints.SenderId && sessionId == endpoints.SenderSession
                    ? endpoints.Relay.SenderKey : null;
                return (ToDto(transfer, endpoints.ReceiverId, endpoints), existingKey);
            }
            await CheckRelayAccountsAsync(db, endpoints);
            transfer.AcceptedAt = null;
            transfer.Status = "offered";
            await db.SaveChangesAsync();
            var multipart = mode == "multipart" && (transfer.Sha256 is not null || await SupportsDeferredHashAsync(db));
            endpoints.Relay = new RelaySession(endpoints.SenderSession, multipart, multipart ? connections : 1);
            if (transfer.Sha256 is not null)
                endpoints.Relay.HashReady.TrySetResult(Convert.ToHexString(transfer.Sha256).ToLowerInvariant());
            var dto = await PublishAsync(transfer, endpoints);
            var senderKey = userId == endpoints.SenderId && sessionId == endpoints.SenderSession
                ? endpoints.Relay.SenderKey : null;
            return (dto, senderKey);
        }
        finally { gate.Release(); }
    }

    public async Task<RelaySenderSessionDto> ClaimRelaySenderSessionAsync(long id, int userId, string sessionId)
    {
        await gate.WaitAsync();
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await FindRelayTransferAsync(db, id, userId);
            var (endpoints, relay) = FindLiveRelay(id);
            if (userId != endpoints.SenderId || sessionId != relay.SenderSession)
                throw new FileRelayException(403, "Phiên truyền thuộc tab khác.");
            if (!relay.IsMultipart) throw new FileRelayException(409, RelayConflict);
            await CheckRelayAccountsAsync(db, endpoints);
            relay.Touch();
            return new RelaySenderSessionDto(relay.SenderKey, relay.Mode!,
                relay.PartBytes ?? FileRelayPartStore.DefaultPartBytes, relay.ConnectionCount);
        }
        finally { gate.Release(); }
    }

    public async Task<FileRelayAcceptanceDto> AcceptRelayAsync(long id, int userId, string sessionId, FileActionDto request)
    {
        await gate.WaitAsync();
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var transfer = await FindRelayTransferAsync(db, id, userId);
            var (endpoints, relay) = FindLiveRelay(id);
            if (userId != endpoints.ReceiverId) throw new FileRelayException(403, "Phiên truyền thuộc người nhận.");
            if (transfer.Status != "offered" || Convert.ToBase64String(transfer.RowVersion) != request.ExpectedVersion)
                throw new FileRelayException(409, RelayConflict);
            await CheckRelayAccountsAsync(db, endpoints);
            relay.MarkAccountsChecked();
            transfer.AcceptedAt = DateTime.UtcNow;
            var autoTransferringZero = relay.IsMultipart && transfer.FileSizeBytes == 0 && transfer.Sha256 is not null;
            transfer.Status = autoTransferringZero ? "transferring" : "accepted";
            await db.SaveChangesAsync();
            relay.ReceiverSession = sessionId;
            relay.Key = Convert.ToHexString(RandomNumberGenerator.GetBytes(24));
            if (relay.IsMultipart)
            {
                relay.PartStore = new FileRelayPartStore(transfer.FileSizeBytes,
                    relay.PartBytes ?? FileRelayPartStore.DefaultPartBytes);
                relay.ReceiverReady = true;
                if (autoTransferringZero) relay.MultipartStarted = true;
                if (transfer.Sha256 is not null)
                    relay.HashReady.TrySetResult(Convert.ToHexString(transfer.Sha256).ToLowerInvariant());
            }
            relay.Touch();
            return new FileRelayAcceptanceDto(await PublishAsync(transfer, endpoints), relay.Key);
        }
        finally { gate.Release(); }
    }

    public async Task DownloadRelayAsync(long id, int userId, string sessionId, string key,
        Func<FileRelayContent, Stream> openDestination, CancellationToken requestAborted)
    {
        RelaySession relay;
        await gate.WaitAsync(requestAborted);
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var transfer = await FindRelayTransferAsync(db, id, userId);
            var (endpoints, found) = FindLiveRelay(id);
            relay = found;
            if (userId != endpoints.ReceiverId || sessionId != relay.ReceiverSession || !MatchesRelayKey(relay, key))
                throw new FileRelayException(403, "Phiên truyền thuộc tab khác.");
            if (relay.IsMultipart || relay.ReceiverReady || transfer.Status != "accepted")
                throw new FileRelayException(409, RelayConflict);
            await CheckRelayAccountsAsync(db, endpoints);
            relay.ReceiverReady = true;
            relay.Touch();
            await PublishAsync(transfer, endpoints);
        }
        finally { gate.Release(); }

        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(requestAborted, relay.Ended.Token);
        try
        {
            var body = await relay.Started.Task.WaitAsync(cancellation.Token);
            await body.Pipe.WriteAsync(openDestination(body.Content), relay.Forward, cancellation.Token);
            relay.Touch();
            relay.Drained.TrySetResult();
        }
        catch
        {
            await FailRelayAsync(id, relay);
            throw;
        }
    }

    public async Task<FileTransferDto> PrepareRelayAsync(long id, int userId, string sessionId,
        PrepareFileRelayDto request, CancellationToken ct)
    {
        if (request.ConnectionCount is not (2 or 4))
            throw new FileRelayException(400, "Chế độ song song cần 2 hoặc 4 kết nối.");
        await BeginRelayAsync(id, userId, sessionId, request.Sha256Hex, null,
            request.ConnectionCount, ct);
        return await GetFileAsync(id, userId);
    }

    public async Task<FileTransferDto> UploadRelayAsync(long id, int userId, string sessionId, string? hash, long? contentLength,
        Stream source, CancellationToken requestAborted, int? channelIndex = null)
    {
        var (relay, body) = channelIndex.HasValue
            ? await ClaimRelayChannelAsync(id, userId, sessionId, hash, contentLength, channelIndex.Value, requestAborted)
            : await BeginRelayAsync(id, userId, sessionId, hash, contentLength, 1, requestAborted);
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(requestAborted, relay.Ended.Token);
        try
        {
            var channel = channelIndex ?? 0;
            var length = FileRelayPipe.ChannelLength(body.Content.Size, relay.ConnectionCount, channel);
            await body.Pipe.ReadAsync(source, length, cancellation.Token, channel);
            return await relay.Finished.Task.WaitAsync(cancellation.Token);
        }
        catch
        {
            await FailRelayAsync(id, relay);
            throw;
        }
    }

    public async Task<long> PutRelayPartAsync(long id, int partIndex, string senderKey, string? partSha256Hex,
        long? contentLength, Stream source, CancellationToken requestAborted)
    {
        RelaySession relay;
        FileRelayPartStore store;
        await gate.WaitAsync(requestAborted);
        try
        {
            var (endpoints, found) = FindLiveRelay(id);
            relay = found;
            if (!relay.IsMultipart || relay.PartStore is null || !relay.ReceiverReady)
                throw new FileRelayException(409, RelayConflict);
            if (!MatchesSenderKey(relay, senderKey))
                throw new FileRelayException(403, "Khóa gửi mảnh không hợp lệ.");
            store = relay.PartStore;
            if (partIndex < 0 || partIndex >= store.TotalParts)
                throw new FileRelayException(400, "Chỉ số mảnh tệp không hợp lệ.");
            var expectedLength = FileRelayPartStore.PartLength(store.FileSize, store.PartBytes, partIndex);
            if (contentLength != expectedLength)
                throw new FileRelayException(400, "Dung lượng mảnh tệp không khớp.");
            if (string.IsNullOrEmpty(partSha256Hex) || partSha256Hex.Length != 64 || !partSha256Hex.All(Uri.IsHexDigit))
                throw new FileRelayException(400, "SHA-256 của mảnh tệp không hợp lệ.");

            if (!relay.MultipartStarted || relay.NeedsAccountCheck)
            {
                using var scope = scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                await CheckRelayAccountsAsync(db, endpoints);
                relay.MarkAccountsChecked();
                if (!relay.MultipartStarted)
                {
                    var transfer = await FindRelayTransferAsync(db, id, endpoints.SenderId);
                    if (transfer.Status is not ("accepted" or "transferring"))
                        throw new FileRelayException(409, RelayConflict);
                    if (transfer.Status == "accepted")
                    {
                        if (active.Values.Count(item => item.Relay?.IsTransferring == true) >= MaximumLiveRelays)
                            throw new FileRelayException(503, "Máy chủ đang chuyển nhiều tệp. Vui lòng thử lại.");
                        transfer.Status = "transferring";
                        relay.MultipartStarted = true;
                        await db.SaveChangesAsync(requestAborted);
                        await PublishAsync(transfer, endpoints);
                    }
                    else
                    {
                        relay.MultipartStarted = true;
                    }
                }
            }
            relay.Touch();
        }
        finally { gate.Release(); }

        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(requestAborted, relay.Ended.Token);
        try
        {
            await store.PutPartAsync(partIndex, source, partSha256Hex, cancellation.Token);
            relay.Touch();
            return relay.ForwardedBytes;
        }
        catch (InvalidDataException)
        {
            throw new FileRelayException(400, "SHA-256 của mảnh tệp không khớp.");
        }
        catch (InvalidOperationException error) when (error.Message == "PART_HASH_CONFLICT")
        {
            throw new FileRelayException(409, RelayConflict);
        }
    }

    public async Task GetRelayPartAsync(long id, int partIndex, int? ackPartIndex, string receiverKey,
        Func<int, string, Stream> openDestination, CancellationToken requestAborted)
    {
        RelaySession relay;
        FileRelayPartStore store;
        await gate.WaitAsync(requestAborted);
        try
        {
            var (endpoints, found) = FindLiveRelay(id);
            relay = found;
            if (!relay.IsMultipart || relay.PartStore is null || !relay.ReceiverReady)
                throw new FileRelayException(409, RelayConflict);
            if (!MatchesRelayKey(relay, receiverKey))
                throw new FileRelayException(403, "Khóa nhận mảnh không hợp lệ.");
            store = relay.PartStore;
            if (partIndex < 0 || partIndex >= store.TotalParts ||
                (ackPartIndex.HasValue && (ackPartIndex.Value < 0 || ackPartIndex.Value >= store.TotalParts)))
                throw new FileRelayException(400, "Chỉ số mảnh tệp không hợp lệ.");
            if (relay.NeedsAccountCheck)
            {
                using var scope = scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                await CheckRelayAccountsAsync(db, endpoints);
                relay.MarkAccountsChecked();
            }
            relay.Touch();
        }
        finally { gate.Release(); }

        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(requestAborted, relay.Ended.Token);
        try
        {
            using var lease = await store.RentPartAsync(partIndex, ackPartIndex, relay.Forward, cancellation.Token);
            var destination = openDestination(lease.Payload.Length, lease.Sha256Hex);
            await destination.WriteAsync(lease.Payload, cancellation.Token);
            relay.Touch();
        }
        catch (InvalidOperationException error) when (error.Message == "PART_ALREADY_ACKED")
        {
            throw new FileRelayException(409, "Mảnh tệp đã được xác nhận trước đó.");
        }
    }

    public async Task<(long RelayedBytes, string? Sha256Hex)> AckRelayPartsAsync(long id, string receiverKey,
        int[] partIndices, CancellationToken ct)
    {
        if (partIndices is null || partIndices.Length == 0 || partIndices.Length > 16)
            throw new FileRelayException(400, "Danh sách xác nhận mảnh không hợp lệ.");
        await gate.WaitAsync(ct);
        try
        {
            var (endpoints, relay) = FindLiveRelay(id);
            if (!relay.IsMultipart || relay.PartStore is null || !MatchesRelayKey(relay, receiverKey))
                throw new FileRelayException(403, "Khóa nhận mảnh không hợp lệ.");
            if (relay.NeedsAccountCheck)
            {
                using var scope = scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                await CheckRelayAccountsAsync(db, endpoints);
                relay.MarkAccountsChecked();
            }
            relay.PartStore.AckParts(partIndices, relay.Forward);
            relay.Touch();
            var hash = relay.HashReady.Task.IsCompletedSuccessfully ? relay.HashReady.Task.Result : null;
            return (relay.ForwardedBytes, hash);
        }
        finally { gate.Release(); }
    }

    public async Task<string> GetRelayHashAsync(long id, string receiverKey, CancellationToken ct)
    {
        RelaySession relay;
        await gate.WaitAsync(ct);
        try
        {
            var (endpoints, found) = FindLiveRelay(id);
            relay = found;
            if (!relay.IsMultipart || !MatchesRelayKey(relay, receiverKey))
                throw new FileRelayException(403, "Khóa nhận tệp không hợp lệ.");
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await CheckRelayAccountsAsync(db, endpoints);
            relay.Touch();
        }
        finally { gate.Release(); }

        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(ct, relay.Ended.Token);
        return await relay.HashReady.Task.WaitAsync(cancellation.Token);
    }

    public async Task<FileTransferDto> FinalizeRelayHashAsync(long id, string senderKey, string sha256Hex, CancellationToken ct)
    {
        var digest = ParseHash(sha256Hex);
        await gate.WaitAsync(ct);
        try
        {
            var (endpoints, relay) = FindLiveRelay(id);
            if (!relay.IsMultipart || !MatchesSenderKey(relay, senderKey))
                throw new FileRelayException(403, "Khóa chốt SHA-256 không hợp lệ.");
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var transfer = await FindRelayTransferAsync(db, id, endpoints.SenderId);
            if (transfer.Status is not ("accepted" or "transferring"))
                throw new FileRelayException(409, RelayConflict);
            await CheckRelayAccountsAsync(db, endpoints);
            if (transfer.Sha256 is not null)
            {
                if (!transfer.Sha256.SequenceEqual(digest))
                    throw new FileRelayException(409, "SHA-256 của tệp nguồn đã được chốt.");
                var existingHex = Convert.ToHexString(transfer.Sha256).ToLowerInvariant();
                relay.HashReady.TrySetResult(existingHex);
                return ToDto(transfer, endpoints.ReceiverId, endpoints);
            }
            transfer.Sha256 = digest;
            if (transfer.FileSizeBytes == 0 && transfer.Status == "accepted")
            {
                transfer.Status = "transferring";
                relay.MultipartStarted = true;
            }
            await db.SaveChangesAsync(ct);
            var normalized = Convert.ToHexString(digest).ToLowerInvariant();
            relay.HashReady.TrySetResult(normalized);
            relay.Touch();
            return await PublishAsync(transfer, endpoints);
        }
        finally { gate.Release(); }
    }

    private async Task<(RelaySession Relay, RelayBody Body)> BeginRelayAsync(long id, int userId,
        string sessionId, string? hash, long? contentLength, int connections, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var transfer = await FindRelayTransferAsync(db, id, userId);
            var (endpoints, found) = FindLiveRelay(id);
            var relay = found;
            if (userId != endpoints.SenderId || sessionId != relay.SenderSession)
                throw new FileRelayException(403, "Phiên truyền thuộc tab khác.");
            if (relay.IsMultipart || !relay.ReceiverReady || transfer.Status != "accepted" || relay.Started.Task.IsCompleted)
                throw new FileRelayException(409, RelayConflict);
            await CheckRelayAccountsAsync(db, endpoints);
            if (connections == 1 && contentLength != transfer.FileSizeBytes)
                throw new FileRelayException(400, "Dung lượng tải lên khác với lời mời.");
            var digest = ParseHash(hash);
            if (transfer.Sha256 is not null && !transfer.Sha256.SequenceEqual(digest))
                throw new FileRelayException(400, "SHA-256 của tệp nguồn đã thay đổi.");
            if (active.Values.Count(item => item.Relay?.IsTransferring == true) >= MaximumLiveRelays)
                throw new FileRelayException(503, "Máy chủ đang chuyển nhiều tệp. Vui lòng thử lại.");
            transfer.Sha256 = digest;
            transfer.Status = "transferring";
            await db.SaveChangesAsync();
            var body = new RelayBody(new FileRelayPipe(connections), new FileRelayContent(transfer.FileSizeBytes,
                Convert.ToHexString(digest).ToLowerInvariant()));
            relay.ConnectionCount = connections;
            relay.UploadClaimed = new bool[connections];
            relay.Touch();
            relay.Started.SetResult(body);
            await PublishAsync(transfer, endpoints);
            return (relay, body);
        }
        finally { gate.Release(); }
    }

    private async Task<(RelaySession Relay, RelayBody Body)> ClaimRelayChannelAsync(long id, int userId,
        string sessionId, string? hash, long? contentLength, int channel, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var transfer = await FindRelayTransferAsync(db, id, userId);
            var (endpoints, relay) = FindLiveRelay(id);
            if (userId != endpoints.SenderId || sessionId != relay.SenderSession)
                throw new FileRelayException(403, "Phiên truyền thuộc tab khác.");
            if (relay.IsMultipart || !relay.Started.Task.IsCompletedSuccessfully || transfer.Status != "transferring" ||
                relay.ConnectionCount == 1 || channel < 0 || channel >= relay.ConnectionCount || relay.UploadClaimed[channel])
                throw new FileRelayException(409, RelayConflict);
            await CheckRelayAccountsAsync(db, endpoints);
            var body = relay.Started.Task.Result;
            if (contentLength != FileRelayPipe.ChannelLength(body.Content.Size, relay.ConnectionCount, channel) ||
                !ParseHash(hash).SequenceEqual(transfer.Sha256!))
                throw new FileRelayException(400, "Dung lượng hoặc SHA-256 của kết nối không khớp.");
            relay.UploadClaimed[channel] = true;
            relay.Touch();
            return (relay, body);
        }
        finally { gate.Release(); }
    }

    // Biên nhận có quyền trên đúng phiên và đúng vai trò đã được xác thực khi mở luồng tải.
    public async Task<FileTransferDto> CompleteRelayAsync(long id, string key, CompleteFileDto receipt, CancellationToken ct)
    {
        RelaySession relay;
        await gate.WaitAsync(ct);
        try
        {
            if (active.GetValueOrDefault(id)?.Relay is not { } found || !MatchesRelayKey(found, key) ||
                (!found.IsMultipart && !found.Started.Task.IsCompletedSuccessfully) ||
                (found.IsMultipart && !found.ReceiverReady) || found.IsIdle)
                throw new FileRelayException(403, "Biên nhận không hợp lệ.");
            relay = found;
        }
        finally { gate.Release(); }
        using (var cancellation = CancellationTokenSource.CreateLinkedTokenSource(ct, relay.Ended.Token))
        {
            if (relay.IsMultipart)
            {
                await relay.PartStore!.AllAckedTask.WaitAsync(cancellation.Token);
                await relay.HashReady.Task.WaitAsync(cancellation.Token);
            }
            else
            {
                await relay.Drained.Task.WaitAsync(cancellation.Token);
            }
        }

        await gate.WaitAsync(ct);
        try
        {
            var (endpoints, _) = FindLiveRelay(id);
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var transfer = await FindRelayTransferAsync(db, id, endpoints.ReceiverId);
            await CheckRelayAccountsAsync(db, endpoints);
            var hash = ParseHash(receipt.VerifiedSha256Hex);
            if (receipt.TransferId != id.ToString(CultureInfo.InvariantCulture) ||
                !(transfer.Status == "transferring" || (transfer.FileSizeBytes == 0 && transfer.Status == "accepted")) ||
                receipt.ReceivedBytes != transfer.FileSizeBytes ||
                transfer.Sha256 is null || !hash.SequenceEqual(transfer.Sha256))
                throw new FileRelayException(400, "Số byte hoặc SHA-256 không khớp.");
            transfer.VerifiedSha256 = hash;
            return await FinishRelayAsync(db, transfer, endpoints, "completed");
        }
        finally { gate.Release(); }
    }

    public async Task<FileTransferDto> EndRelayAsync(long id, int userId, string sessionId, string action)
    {
        await gate.WaitAsync();
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var transfer = await FindRelayTransferAsync(db, id, userId);
            var (endpoints, relay) = FindLiveRelay(id);
            var sender = userId == endpoints.SenderId && sessionId == relay.SenderSession;
            var receiver = userId == endpoints.ReceiverId &&
                (relay.ReceiverSession is null || sessionId == relay.ReceiverSession);
            if (!sender && !receiver) throw new FileRelayException(403, "Phiên truyền thuộc tab khác.");
            var status = action switch
            {
                "reject" when receiver && transfer.Status == "offered" => "rejected",
                "cancel" => "cancelled",
                "fail" => "failed",
                _ => throw new FileRelayException(409, RelayConflict)
            };
            return await FinishRelayAsync(db, transfer, endpoints, status);
        }
        finally { gate.Release(); }
    }

    public async Task RevokeRelaySessionAsync(string sessionId)
    {
        await gate.WaitAsync();
        try
        {
            var affected = active.Where(pair => pair.Value.Relay is { } relay &&
                (relay.SenderSession == sessionId || relay.ReceiverSession == sessionId)).ToArray();
            if (affected.Length == 0) return;
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            foreach (var (id, endpoints) in affected)
            {
                var transfer = await FindRelayTransferAsync(db, id, endpoints.SenderId);
                await FinishRelayAsync(db, transfer, endpoints, "failed");
            }
        }
        finally { gate.Release(); }
    }

    private async Task FailRelayAsync(long id, RelaySession relay)
    {
        await gate.WaitAsync();
        try
        {
            if (!active.TryGetValue(id, out var endpoints) || endpoints.Relay != relay) return;
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var transfer = await FindRelayTransferAsync(db, id, endpoints.SenderId);
            await FinishRelayAsync(db, transfer, endpoints, "failed");
        }
        finally { gate.Release(); }
    }

    private async Task<FileTransferDto> FinishRelayAsync(AppDbContext db, FileTransfer transfer,
        EndpointPair endpoints, string status)
    {
        transfer.Status = status;
        transfer.FinishedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();
        active.Remove(transfer.Id);
        endpoints.Relay!.Finished.TrySetResult(ToDto(transfer, endpoints.ReceiverId, endpoints));
        if (status != "completed") endpoints.Relay!.Ended.Cancel();
        endpoints.Relay!.PartStore?.Dispose();
        return await PublishAsync(transfer, endpoints);
    }

    private (EndpointPair Endpoints, RelaySession Relay) FindLiveRelay(long id)
    {
        if (!active.TryGetValue(id, out var endpoints) || endpoints.Relay is not { } relay || relay.IsIdle)
            throw new FileRelayException(409, RelayConflict);
        return (endpoints, relay);
    }

    private static async Task<FileTransfer> FindRelayTransferAsync(AppDbContext db, long id, int userId) =>
        await db.FileTransfers.Include(item => item.Conversation).SingleOrDefaultAsync(item => item.Id == id &&
            (item.Conversation.UserAID == userId || item.Conversation.UserBID == userId))
        ?? throw new FileRelayException(404, "Không tìm thấy phiên truyền.");

    private static async Task CheckRelayAccountsAsync(AppDbContext db, EndpointPair endpoints)
    {
        if (await db.Users.AnyAsync(item => (item.Id == endpoints.SenderId || item.Id == endpoints.ReceiverId) &&
                item.IsDisabled))
            throw new FileRelayException(403, "Tài khoản không khả dụng.");
    }

    private static bool MatchesRelayKey(RelaySession relay, string key) => MatchesKey(relay.Key, key);
    private static bool MatchesSenderKey(RelaySession relay, string key) => MatchesKey(relay.SenderKey, key);

    private static bool MatchesKey(string? expected, string key) =>
        expected is not null && key.Length == expected.Length &&
        CryptographicOperations.FixedTimeEquals(System.Text.Encoding.ASCII.GetBytes(expected),
            System.Text.Encoding.ASCII.GetBytes(key));
}

internal sealed class FileRelayException(int statusCode, string message) : Exception(message)
{
    public int StatusCode { get; } = statusCode;
}

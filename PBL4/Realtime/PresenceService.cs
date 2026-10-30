using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using PBL4.Contracts;
using PBL4.Data;

namespace PBL4.Realtime;

public sealed class PresenceService(IServiceScopeFactory scopes, PresenceTracker tracker,
    IHubContext<ChatHub, IChatClient> hub)
{
    private readonly SemaphoreSlim transitions = new(1, 1);
    private readonly Dictionary<int, PresenceDto> pendingChanges = [];

    public async Task RecordHeartbeatAsync(int userId, string connectionId, CancellationToken ct)
    {
        await transitions.WaitAsync(ct);
        try
        {
            if (tracker.RecordHeartbeat(userId, connectionId))
                pendingChanges[userId] = new PresenceDto(userId, true, null);
            await PublishPendingAsync(CancellationToken.None);
        }
        finally { transitions.Release(); }
    }

    public async Task CheckTimeoutsAsync(CancellationToken ct)
    {
        await transitions.WaitAsync(ct);
        try
        {
            foreach (var userId in tracker.CheckTimeouts())
                pendingChanges[userId] = new PresenceDto(userId, false, DateTime.UtcNow);
            await PublishPendingAsync(ct);
        }
        finally { transitions.Release(); }
    }

    public async Task RevokeSessionAsync(int userId, string sessionId, CancellationToken ct)
    {
        await transitions.WaitAsync(ct);
        try
        {
            if (tracker.RevokeSession(userId, sessionId))
                pendingChanges[userId] = new PresenceDto(userId, false, DateTime.UtcNow);
            await PublishPendingAsync(CancellationToken.None);
        }
        finally { transitions.Release(); }
    }

    private async Task PublishPendingAsync(CancellationToken ct)
    {
        foreach (var (userId, change) in pendingChanges.ToArray())
        {
            await NotifyAsync(userId, change.IsOnline, change.LastSeenAt, ct);
            pendingChanges.Remove(userId);
        }
    }

    private async Task NotifyAsync(int userId, bool isOnline, DateTime? lastSeenAt,
        CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope(); //Tạo scpoe để tạo đối tượng db truy vấn (dùng using tự giải phóng sau khi kết thúc)
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        if (!isOnline) //nếu offline thì ghi lần hoạt động cuối
            await db.Users.Where(user => user.Id == userId)
                .ExecuteUpdateAsync(setters => setters.SetProperty(user => user.LastSeenAt, lastSeenAt), ct);

        //nếu online thì tìm các người dùng có liên hệ với A theo 3 nhóm
        var peers = await db.DirectConversations.AsNoTracking()
            .Where(c => c.UserAID == userId || c.UserBID == userId)
            .Select(c => c.UserAID == userId ? c.UserBID : c.UserAID) //nhóm 1: có cuộc hội thoại trực tiếp với A
            .Concat(db.Contacts.AsNoTracking().Where(c => c.UserId == userId)
                .Select(c => c.ContactUserId)) //nhóm 2: có trong danh bạ của A
            .Concat(db.Contacts.AsNoTracking().Where(c => c.ContactUserId == userId)
                .Select(c => c.UserId)) // Nhóm 3: có A trong danh bạ
            .Distinct().ToListAsync(ct); //thực hiện loại bỏ ID trùng 
        peers.Add(userId);
        var connectionIds = tracker.GetValidConnectionIds(peers);
        if (connectionIds.Count == 0) return;
        await hub.Clients.Clients(connectionIds)
            .PresenceChanged(new PresenceDto(userId, isOnline, lastSeenAt)); //phát thông báo cho các người dùng có liên quan ở trên
    }
}

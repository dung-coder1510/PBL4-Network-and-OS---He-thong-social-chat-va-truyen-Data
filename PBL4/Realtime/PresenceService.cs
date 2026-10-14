using System.Globalization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using PBL4.Contracts;
using PBL4.Data;

namespace PBL4.Realtime;

public sealed class PresenceService(AppDbContext db, PresenceTracker tracker,
    IHubContext<ChatHub, IChatClient> hub)
{
    public Task NotifyOnlineAsync(int userId, CancellationToken ct) =>
        NotifyAsync(userId, true, null, ct);

    public async Task NotifyDisconnectedAsync(int userId, CancellationToken ct)
    {
        var lastSeenAt = DateTime.UtcNow;
        await db.Users.Where(u => u.Id == userId)
            .ExecuteUpdateAsync(setters => setters.SetProperty(u => u.LastSeenAt, lastSeenAt), ct);
        await NotifyAsync(userId, false, lastSeenAt, ct);
    }

    public async Task RevokeSessionAsync(int userId, string sessionId, CancellationToken ct)
    {
        if (tracker.RevokeSession(userId, sessionId))
            await NotifyDisconnectedAsync(userId, ct);
    }

    private async Task NotifyAsync(int userId, bool isOnline, DateTime? lastSeenAt,
        CancellationToken ct)
    {
        var peers = await db.DirectConversations.AsNoTracking()
            .Where(c => c.UserAID == userId || c.UserBID == userId)
            .Select(c => c.UserAID == userId ? c.UserBID : c.UserAID)
            .Concat(db.Contacts.AsNoTracking().Where(c => c.UserId == userId)
                .Select(c => c.ContactUserId))
            .Concat(db.Contacts.AsNoTracking().Where(c => c.ContactUserId == userId)
                .Select(c => c.UserId))
            .Distinct().ToListAsync(ct);
        peers.Add(userId);
        var connectionIds = tracker.GetValidConnectionIds(peers);
        if (connectionIds.Count == 0) return;
        await hub.Clients.Clients(connectionIds)
            .PresenceChanged(new PresenceDto(userId, isOnline, lastSeenAt));
    }
}

using Microsoft.Extensions.Caching.Memory;

namespace PBL4.Auth;

// MVP một instance: restart server thu hồi mọi phiên, không có refresh token.
public sealed class SessionRegistry : IDisposable
{
    private readonly MemoryCache sessions = new(new MemoryCacheOptions { SizeLimit = 10000 });
    private sealed record Entry(int UserId, DateTimeOffset ExpiresAt);

    public string Create(int userId, DateTimeOffset expiresAt)
    {
        var id = Guid.NewGuid().ToString("N");
        sessions.Set(id, new Entry(userId, expiresAt),
            new MemoryCacheEntryOptions { AbsoluteExpiration = expiresAt, Size = 1 });
        if (!IsValid(id, userId)) throw new InvalidOperationException("Session capacity reached.");
        return id;
    }

    public bool IsValid(string id, int userId) =>
        sessions.TryGetValue<Entry>(id, out var entry) &&
        entry is not null && entry.UserId == userId && entry.ExpiresAt > DateTimeOffset.UtcNow;

    public void Revoke(string id) => sessions.Remove(id);
    public void Dispose() => sessions.Dispose();
}


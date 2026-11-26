using System.Security.Cryptography;
using System.Text;

namespace PBL4.Auth;

// MVP một instance: giữ phiên và refresh token trong RAM (hạn trượt tối đa 30 ngày khi server còn chạy).
public sealed class SessionRegistry : IDisposable
{
    public const int Capacity = 10_000;
    private static readonly TimeSpan RefreshGraceWindow = TimeSpan.FromSeconds(30);

    private readonly object gate = new();
    private readonly Dictionary<string, Entry> bySessionId = [];
    private readonly Dictionary<string, string> sessionIdByRefreshHash = [];

    public sealed record RefreshLookup(string SessionId, int UserId, int SessionVersion);
    public sealed record RefreshResult(string SessionId, int UserId, string? NewRefreshToken);

    private sealed class Entry(string sessionId, int userId, int sessionVersion,
        DateTimeOffset accessExpiresAt, DateTimeOffset refreshExpiresAt, string refreshTokenHash)
    {
        public string SessionId { get; } = sessionId;
        public int UserId { get; } = userId;
        public int SessionVersion { get; } = sessionVersion;
        public DateTimeOffset AccessExpiresAt { get; set; } = accessExpiresAt;
        public DateTimeOffset RefreshExpiresAt { get; set; } = refreshExpiresAt;
        public string RefreshTokenHash { get; set; } = refreshTokenHash;
        public string? PreviousRefreshTokenHash { get; set; }
        public DateTimeOffset PreviousGraceUntil { get; set; }
    }

    public (string SessionId, string RefreshToken) Create(int userId, int sessionVersion,
        DateTimeOffset accessExpiresAt, DateTimeOffset refreshExpiresAt)
    {
        var now = DateTimeOffset.UtcNow;
        var sessionId = Guid.NewGuid().ToString("N");
        var refreshToken = GenerateToken();
        var refreshHash = HashToken(refreshToken);

        lock (gate)
        {
            if (bySessionId.Count >= Capacity) PurgeExpiredLocked(now);
            if (bySessionId.Count >= Capacity) throw new InvalidOperationException("Session capacity reached.");

            var entry = new Entry(sessionId, userId, sessionVersion, accessExpiresAt, refreshExpiresAt, refreshHash);
            bySessionId[sessionId] = entry;
            sessionIdByRefreshHash[refreshHash] = sessionId;
        }

        return (sessionId, refreshToken);
    }

    public string Create(int userId, DateTimeOffset expiresAt) =>
        Create(userId, 0, expiresAt, expiresAt).SessionId;

    public bool IsValid(string id, int userId)
    {
        var now = DateTimeOffset.UtcNow;
        lock (gate)
        {
            return bySessionId.TryGetValue(id, out var entry) &&
                   entry.UserId == userId &&
                   entry.AccessExpiresAt > now;
        }
    }

    public RefreshLookup? PeekRefresh(string refreshToken)
    {
        if (string.IsNullOrEmpty(refreshToken)) return null;
        var now = DateTimeOffset.UtcNow;
        var hash = HashToken(refreshToken);

        lock (gate)
        {
            if (!sessionIdByRefreshHash.TryGetValue(hash, out var sid) ||
                !bySessionId.TryGetValue(sid, out var entry) ||
                entry.RefreshExpiresAt <= now)
                return null;

            var isCurrent = entry.RefreshTokenHash == hash;
            var isWithinGrace = entry.PreviousRefreshTokenHash == hash && entry.PreviousGraceUntil > now;
            if (!isCurrent && !isWithinGrace) return null;

            return new RefreshLookup(entry.SessionId, entry.UserId, entry.SessionVersion);
        }
    }

    public RefreshResult? TryRefresh(string refreshToken, DateTimeOffset newAccessExpiresAt, DateTimeOffset newRefreshExpiresAt)
    {
        if (string.IsNullOrEmpty(refreshToken)) return null;
        var now = DateTimeOffset.UtcNow;
        var hash = HashToken(refreshToken);

        lock (gate)
        {
            if (!sessionIdByRefreshHash.TryGetValue(hash, out var sid) ||
                !bySessionId.TryGetValue(sid, out var entry) ||
                entry.RefreshExpiresAt <= now)
                return null;

            if (entry.RefreshTokenHash == hash)
            {
                if (entry.PreviousRefreshTokenHash is not null)
                    sessionIdByRefreshHash.Remove(entry.PreviousRefreshTokenHash);

                entry.PreviousRefreshTokenHash = entry.RefreshTokenHash;
                entry.PreviousGraceUntil = now.Add(RefreshGraceWindow);

                var nextToken = GenerateToken();
                var nextHash = HashToken(nextToken);
                entry.RefreshTokenHash = nextHash;
                sessionIdByRefreshHash[nextHash] = entry.SessionId;

                if (newAccessExpiresAt > entry.AccessExpiresAt) entry.AccessExpiresAt = newAccessExpiresAt;
                if (newRefreshExpiresAt > entry.RefreshExpiresAt) entry.RefreshExpiresAt = newRefreshExpiresAt;

                return new RefreshResult(entry.SessionId, entry.UserId, nextToken);
            }

            if (entry.PreviousRefreshTokenHash == hash && entry.PreviousGraceUntil > now)
            {
                if (newAccessExpiresAt > entry.AccessExpiresAt) entry.AccessExpiresAt = newAccessExpiresAt;
                if (newRefreshExpiresAt > entry.RefreshExpiresAt) entry.RefreshExpiresAt = newRefreshExpiresAt;
                return new RefreshResult(entry.SessionId, entry.UserId, null);
            }

            return null;
        }
    }

    public void Revoke(string id)
    {
        lock (gate) RemoveLocked(id);
    }

    public void RevokeAll(int userId)
    {
        lock (gate)
        {
            var matches = bySessionId.Values
                .Where(entry => entry.UserId == userId)
                .Select(entry => entry.SessionId)
                .ToArray();
            foreach (var id in matches) RemoveLocked(id);
        }
    }

    public void Dispose() { }

    private void RemoveLocked(string id)
    {
        if (!bySessionId.Remove(id, out var entry)) return;
        sessionIdByRefreshHash.Remove(entry.RefreshTokenHash);
        if (entry.PreviousRefreshTokenHash is not null)
            sessionIdByRefreshHash.Remove(entry.PreviousRefreshTokenHash);
    }

    private void PurgeExpiredLocked(DateTimeOffset now)
    {
        var expired = bySessionId.Values
            .Where(entry => entry.RefreshExpiresAt <= now)
            .Select(entry => entry.SessionId)
            .ToArray();
        foreach (var id in expired) RemoveLocked(id);
    }

    private static string GenerateToken() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static string HashToken(string token) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
}

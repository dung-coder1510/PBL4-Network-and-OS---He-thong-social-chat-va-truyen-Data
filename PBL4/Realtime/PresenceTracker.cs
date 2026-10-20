using PBL4.Auth;
using Microsoft.Extensions.Options;

namespace PBL4.Realtime;

public sealed class PresenceTracker(SessionRegistry sessions, TimeProvider clock,
    IOptions<HeartbeatOptions> options)
{
    private readonly Lock gate = new();
    private readonly Dictionary<int, Dictionary<string, ConnectionEntry>> connections = [];
    private readonly HashSet<int> onlineUsers = [];
    private readonly TimeSpan timeout = TimeSpan.FromSeconds(options.Value.TimeoutSeconds);

    private sealed class ConnectionEntry(string sessionId)
    {
        public string SessionId { get; } = sessionId;
        public bool IsConnected { get; set; } = true;
        public long? LastHeartbeatTimestamp { get; set; }
    }

    public void Connect(int userId, string sessionId, string connectionId)
    {
        lock (gate)
        {
            if (!connections.TryGetValue(userId, out var userConnections))
            {
                userConnections = [];
                connections[userId] = userConnections;
            }
            userConnections[connectionId] = new ConnectionEntry(sessionId);
        }
    }

    public bool RecordHeartbeat(int userId, string connectionId)
    {
        lock (gate)
        {
            if (!connections.TryGetValue(userId, out var userConnections) ||
                !userConnections.TryGetValue(connectionId, out var connection) ||
                !connection.IsConnected || !sessions.IsValid(connection.SessionId, userId))
                throw new InvalidOperationException("Heartbeat connection is unavailable.");
            connection.LastHeartbeatTimestamp = clock.GetTimestamp();
            return onlineUsers.Add(userId);
        }
    }

    public void Disconnect(int userId, string connectionId)
    {
        lock (gate)
        {
            if (!connections.TryGetValue(userId, out var userConnections) ||
                !userConnections.TryGetValue(connectionId, out var connection)) return;
            connection.IsConnected = false;
            if (connection.LastHeartbeatTimestamp is null) userConnections.Remove(connectionId);
            if (userConnections.Count == 0) connections.Remove(userId);
        }
    }

    public bool RevokeSession(int userId, string sessionId)
    {
        lock (gate)
        {
            if (!connections.TryGetValue(userId, out var userConnections)) return false;
            foreach (var connectionId in userConnections
                .Where(pair => pair.Value.SessionId == sessionId).Select(pair => pair.Key).ToArray())
                userConnections.Remove(connectionId);
            if (userConnections.Count == 0) connections.Remove(userId);
            return !HasRecentHeartbeat(userId, userConnections) && onlineUsers.Remove(userId);
        }
    }

    public bool IsOnline(int userId)
    {
        lock (gate)
        {
            return connections.TryGetValue(userId, out var userConnections) &&
                HasRecentHeartbeat(userId, userConnections);
        }
    }

    public IReadOnlyList<string> GetValidConnectionIds(IEnumerable<int> userIds)
    {
        lock (gate)
        {
            var result = new List<string>();
            foreach (var userId in userIds.Distinct())
            {
                if (!connections.TryGetValue(userId, out var userConnections)) continue;
                result.AddRange(userConnections
                    .Where(pair => pair.Value.IsConnected &&
                        sessions.IsValid(pair.Value.SessionId, userId))
                    .Select(pair => pair.Key));
            }
            return result;
        }
    }

    public IReadOnlyList<int> CheckTimeouts()
    {
        lock (gate)
        {
            var offlineUsers = new List<int>();
            foreach (var (userId, userConnections) in connections.ToArray())
            {
                if (!HasRecentHeartbeat(userId, userConnections) && onlineUsers.Remove(userId))
                    offlineUsers.Add(userId);
                foreach (var connectionId in userConnections.Where(pair =>
                    !sessions.IsValid(pair.Value.SessionId, userId) ||
                    (!pair.Value.IsConnected && !IsRecent(pair.Value)))
                    .Select(pair => pair.Key).ToArray())
                    userConnections.Remove(connectionId);
                if (userConnections.Count == 0) connections.Remove(userId);
            }
            return offlineUsers;
        }
    }

    private bool HasRecentHeartbeat(int userId, Dictionary<string, ConnectionEntry> userConnections) =>
        userConnections.Values.Any(connection => IsRecent(connection) &&
            sessions.IsValid(connection.SessionId, userId));

    private bool IsRecent(ConnectionEntry connection) =>
        connection.LastHeartbeatTimestamp is long timestamp &&
        clock.GetElapsedTime(timestamp) < timeout;
}

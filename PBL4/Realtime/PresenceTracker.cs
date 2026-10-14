using PBL4.Auth;

namespace PBL4.Realtime;

public sealed class PresenceTracker(SessionRegistry sessions)
{
    private readonly Lock gate = new();
    private readonly Dictionary<int, Dictionary<string, string>> connections = [];

    public bool Connect(int userId, string sessionId, string connectionId)
    {
        lock (gate)
        {
            if (!connections.TryGetValue(userId, out var userConnections))
            {
                userConnections = [];
                connections[userId] = userConnections;
            }
            RemoveInvalid(userId, userConnections);
            userConnections[connectionId] = sessionId;
            return userConnections.Count == 1;
        }
    }

    public bool Disconnect(int userId, string connectionId)
    {
        lock (gate)
        {
            if (!connections.TryGetValue(userId, out var userConnections)) return false;
            userConnections.Remove(connectionId);
            RemoveInvalid(userId, userConnections);
            if (userConnections.Count > 0) return false;
            connections.Remove(userId);
            return true;
        }
    }

    public bool RevokeSession(int userId, string sessionId)
    {
        lock (gate)
        {
            if (!connections.TryGetValue(userId, out var userConnections)) return false;
            foreach (var connectionId in userConnections
                .Where(pair => pair.Value == sessionId).Select(pair => pair.Key).ToArray())
                userConnections.Remove(connectionId);
            RemoveInvalid(userId, userConnections);
            if (userConnections.Count > 0) return false;
            connections.Remove(userId);
            return true;
        }
    }

    public bool IsOnline(int userId)
    {
        lock (gate)
        {
            if (!connections.TryGetValue(userId, out var userConnections)) return false;
            RemoveInvalid(userId, userConnections);
            if (userConnections.Count > 0) return true;
            connections.Remove(userId);
            return false;
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
                RemoveInvalid(userId, userConnections);
                if (userConnections.Count == 0)
                {
                    connections.Remove(userId);
                    continue;
                }
                result.AddRange(userConnections.Keys);
            }
            return result;
        }
    }

    private void RemoveInvalid(int userId, Dictionary<string, string> userConnections)
    {
        foreach (var connectionId in userConnections
            .Where(pair => !sessions.IsValid(pair.Value, userId))
            .Select(pair => pair.Key).ToArray())
            userConnections.Remove(connectionId);
    }
}

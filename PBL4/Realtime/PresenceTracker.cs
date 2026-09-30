namespace PBL4.Realtime;

public sealed class PresenceTracker
{
    private readonly Lock gate = new();
    private readonly Dictionary<int, HashSet<string>> connections = [];

    public bool Connect(int userId, string connectionId)
    {
        lock (gate)
        {
            if (!connections.TryGetValue(userId, out var userConnections))
            {
                userConnections = [];
                connections[userId] = userConnections;
            }
            userConnections.Add(connectionId);
            return userConnections.Count == 1;
        }
    }

    public bool Disconnect(int userId, string connectionId)
    {
        lock (gate)
        {
            if (!connections.TryGetValue(userId, out var userConnections)) return false;
            userConnections.Remove(connectionId);
            if (userConnections.Count > 0) return false;
            connections.Remove(userId);
            return true;
        }
    }

    public bool IsOnline(int userId)
    {
        lock (gate) return connections.ContainsKey(userId);
    }
}

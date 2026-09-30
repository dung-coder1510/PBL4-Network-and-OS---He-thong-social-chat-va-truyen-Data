namespace PBL4.Realtime;

public sealed class TypingRateLimiter
{
    private static readonly TimeSpan MinimumInterval = TimeSpan.FromSeconds(1);
    private readonly Lock gate = new();
    private readonly Dictionary<(int UserId, long ConversationId), DateTime> lastStarts = [];

    public bool AllowStart(int userId, long conversationId)
    {
        var key = (userId, conversationId);
        var now = DateTime.UtcNow;
        lock (gate)
        {
            if (lastStarts.TryGetValue(key, out var previous) && now - previous < MinimumInterval)
                return false;
            lastStarts[key] = now;
            return true;
        }
    }

    public void Stop(int userId, long conversationId)
    {
        lock (gate) lastStarts.Remove((userId, conversationId));
    }
}

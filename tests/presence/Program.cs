using Microsoft.Extensions.Options;
using PBL4.Auth;
using PBL4.Realtime;

var checks = 0;

void Check(string label, Action action)
{
    action();
    checks++;
    Console.WriteLine($"PASS {label}");
}

void Expect(bool condition)
{
    if (!condition) throw new InvalidOperationException("Presence assertion failed.");
}

(PresenceTracker Tracker, ManualClock Clock, SessionRegistry Sessions, string Session) CreateTracker()
{
    var clock = new ManualClock();
    var sessions = new SessionRegistry();
    var session = sessions.Create(1, DateTimeOffset.UtcNow.AddMinutes(30));
    var tracker = new PresenceTracker(sessions, clock, Options.Create(new HeartbeatOptions()));
    return (tracker, clock, sessions, session);
}

Check("Opening a connection is not enough; the first heartbeat announces online once", () =>
{
    var (tracker, _, sessions, session) = CreateTracker();
    using (sessions)
    {
        tracker.Connect(1, session, "tab-a");
        Expect(!tracker.IsOnline(1));
        Expect(tracker.RecordHeartbeat(1, "tab-a"));
        Expect(tracker.IsOnline(1));
        Expect(!tracker.RecordHeartbeat(1, "tab-a"));
    }
});

Check("Presence lasts 59 seconds and expires at 60 seconds even with a live socket", () =>
{
    var (tracker, clock, sessions, session) = CreateTracker();
    using (sessions)
    {
        tracker.Connect(1, session, "tab-a");
        tracker.RecordHeartbeat(1, "tab-a");
        clock.Advance(59);
        Expect(tracker.IsOnline(1));
        Expect(tracker.CheckTimeouts().Count == 0);
        clock.Advance(1);
        Expect(!tracker.IsOnline(1));
        Expect(tracker.GetValidConnectionIds([1]).SequenceEqual(["tab-a"]));
        Expect(tracker.CheckTimeouts().SequenceEqual([1]));
        Expect(tracker.CheckTimeouts().Count == 0);
        Expect(tracker.RecordHeartbeat(1, "tab-a"));
        Expect(tracker.IsOnline(1));
    }
});

Check("A dropped socket retains presence until 60 seconds after its last heartbeat", () =>
{
    var (tracker, clock, sessions, session) = CreateTracker();
    using (sessions)
    {
        tracker.Connect(1, session, "tab-a");
        tracker.RecordHeartbeat(1, "tab-a");
        clock.Advance(20);
        tracker.Disconnect(1, "tab-a");
        Expect(tracker.GetValidConnectionIds([1]).Count == 0);
        clock.Advance(39);
        Expect(tracker.IsOnline(1));
        clock.Advance(1);
        Expect(tracker.CheckTimeouts().SequenceEqual([1]));
        Expect(!tracker.IsOnline(1));
    }
});

Check("Heartbeats every 15 seconds keep the user online for multiple timeout periods", () =>
{
    var (tracker, clock, sessions, session) = CreateTracker();
    using (sessions)
    {
        tracker.Connect(1, session, "tab-a");
        tracker.RecordHeartbeat(1, "tab-a");
        for (var heartbeat = 0; heartbeat < 12; heartbeat++)
        {
            clock.Advance(15);
            Expect(!tracker.RecordHeartbeat(1, "tab-a"));
            Expect(tracker.CheckTimeouts().Count == 0);
            Expect(tracker.IsOnline(1));
        }
    }
});

Check("Another tab's heartbeat keeps the account online when the first tab expires", () =>
{
    var (tracker, clock, sessions, session) = CreateTracker();
    using (sessions)
    {
        tracker.Connect(1, session, "tab-a");
        tracker.RecordHeartbeat(1, "tab-a");
        tracker.Connect(1, session, "tab-b");
        clock.Advance(45);
        Expect(!tracker.RecordHeartbeat(1, "tab-b"));
        tracker.Disconnect(1, "tab-a");
        clock.Advance(15);
        Expect(tracker.CheckTimeouts().Count == 0);
        Expect(tracker.IsOnline(1));
        clock.Advance(45);
        Expect(tracker.CheckTimeouts().SequenceEqual([1]));
    }
});

Check("Reconnecting during the timeout avoids an offline/online notification pair", () =>
{
    var (tracker, clock, sessions, session) = CreateTracker();
    using (sessions)
    {
        tracker.Connect(1, session, "old-tab");
        tracker.RecordHeartbeat(1, "old-tab");
        tracker.Disconnect(1, "old-tab");
        clock.Advance(50);
        tracker.Connect(1, session, "new-tab");
        Expect(!tracker.RecordHeartbeat(1, "new-tab"));
        clock.Advance(10);
        Expect(tracker.CheckTimeouts().Count == 0);
        Expect(tracker.GetValidConnectionIds([1]).SequenceEqual(["new-tab"]));
    }
});

Check("Revoking the final session marks offline immediately and prevents future heartbeats", () =>
{
    var (tracker, _, sessions, session) = CreateTracker();
    using (sessions)
    {
        tracker.Connect(1, session, "tab-a");
        tracker.RecordHeartbeat(1, "tab-a");
        sessions.Revoke(session);
        Expect(tracker.RevokeSession(1, session));
        Expect(!tracker.IsOnline(1));
        Expect(tracker.GetValidConnectionIds([1]).Count == 0);
        Expect(tracker.CheckTimeouts().Count == 0);
        try
        {
            tracker.RecordHeartbeat(1, "tab-a");
            throw new Exception("A revoked heartbeat was accepted.");
        }
        catch (InvalidOperationException) { }
    }
});

Check("Revoking one session leaves another session's heartbeat online", () =>
{
    var (tracker, _, sessions, session) = CreateTracker();
    using (sessions)
    {
        var otherSession = sessions.Create(1, DateTimeOffset.UtcNow.AddMinutes(30));
        tracker.Connect(1, session, "tab-a");
        tracker.Connect(1, otherSession, "tab-b");
        tracker.RecordHeartbeat(1, "tab-a");
        tracker.RecordHeartbeat(1, "tab-b");
        sessions.Revoke(session);
        Expect(!tracker.RevokeSession(1, session));
        Expect(tracker.IsOnline(1));
        Expect(tracker.GetValidConnectionIds([1]).SequenceEqual(["tab-b"]));
    }
});

Check("Invalid sessions are swept without a snapshot read swallowing the offline event", () =>
{
    var (tracker, _, sessions, session) = CreateTracker();
    using (sessions)
    {
        tracker.Connect(1, session, "tab-a");
        tracker.RecordHeartbeat(1, "tab-a");
        sessions.Revoke(session);
        Expect(!tracker.IsOnline(1));
        Expect(tracker.GetValidConnectionIds([1]).Count == 0);
        Expect(tracker.CheckTimeouts().SequenceEqual([1]));
    }
});

Console.WriteLine($"{checks} presence checks passed.");

sealed class ManualClock : TimeProvider
{
    private long timestamp;
    public override long TimestampFrequency => TimeSpan.TicksPerSecond;
    public override long GetTimestamp() => timestamp;
    public void Advance(int seconds) => timestamp += TimeSpan.FromSeconds(seconds).Ticks;
}

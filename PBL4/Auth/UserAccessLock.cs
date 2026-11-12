namespace PBL4.Auth;

// Serialize login/account changes per user; release unused lock entries.
public sealed class UserAccessLock
{
    private readonly Lock gate = new();
    private readonly Dictionary<int, Entry> entries = [];
    private sealed class Entry { public readonly SemaphoreSlim Mutex = new(1, 1); public int References; }
    public async Task<IDisposable> AcquireAsync(int userId, CancellationToken ct)
    {
        Entry entry;
        lock (gate)
        {
            if (!entries.TryGetValue(userId, out entry!)) entries[userId] = entry = new();
            entry.References++;
        }
        try { await entry.Mutex.WaitAsync(ct); }
        catch { Dereference(userId, entry); throw; }
        return new Lease(() => { entry.Mutex.Release(); Dereference(userId, entry); });
    }
    private void Dereference(int userId, Entry entry)
    {
        lock (gate)
            if (--entry.References == 0) { entries.Remove(userId); entry.Mutex.Dispose(); }
    }
    private sealed class Lease(Action release) : IDisposable
    {
        private Action? action = release;
        public void Dispose() => Interlocked.Exchange(ref action, null)?.Invoke();
    }
}

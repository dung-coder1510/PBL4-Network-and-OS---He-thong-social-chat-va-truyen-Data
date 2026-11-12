using System.Diagnostics;
using Microsoft.AspNetCore.SignalR;
using System.Text.Json;

namespace PBL4.Services;

// Bộ đệm hữu hạn cho một backend instance. Không giữ nội dung request, JWT hay SDP.
// Snapshot chỉ phục vụ chẩn đoán; không được sử dụng để quyết định quyền/nghiệp vụ.
public sealed class MonitoringService : IHubFilter
{
    private readonly object gate = new();
    private readonly Queue<Sample> samples = new();
    private readonly Dictionary<string, Link> links = new();
    private long activeHttp;
    private long activeHub;
    private long droppedSamples;
    public void EnterHttp() => Interlocked.Increment(ref activeHttp);
    public void LeaveHttp() => Interlocked.Decrement(ref activeHttp);
    private readonly Queue<FileEvent> events = new();
    public record FileEvent(string TransferId, string Source, string Stage, long? Bytes, string? Reason, DateTime At);
    public record Archive(Sample[] Samples, FileEvent[] Events);
    // Chụp bản lưu dưới khóa ngắn; I/O do worker thực hiện ngoài khóa, không chặn request.
    public Archive Export()
    {
        lock (gate) { Trim(); return new(samples.ToArray(), events.Where(x => x.At >= DateTime.UtcNow.AddHours(-24)).ToArray()); }
    }
    public void Restore(Archive archive)
    {
        lock (gate)
        {
            foreach (var item in archive.Samples.TakeLast(20000).Where(x => x.At <= DateTime.UtcNow)) samples.Enqueue(item);
            foreach (var item in archive.Events.TakeLast(5000).Where(x => x.At >= DateTime.UtcNow.AddHours(-24) && x.At <= DateTime.UtcNow)) events.Enqueue(item);
            Trim();
        }
    }
    // Nhật ký giới hạn, timestamp do server cấp; không tin thời gian client hoặc lưu exception thô.
    public void File(string id, string source, string stage, long? bytes = null, string? reason = null)
    {
        lock (gate)
        {
            events.Enqueue(new(id, source, stage, bytes, reason, DateTime.UtcNow));
            while (events.Count > 5000 || events.TryPeek(out var old) && old.At < DateTime.UtcNow.AddHours(-24)) events.Dequeue();
        }
    }
    public record Sample(DateTime At, string Kind, string Operation, double Milliseconds, string Outcome, long? InBytes, long? OutBytes);
    public record Link(string Id, string? UserId, DateTime ConnectedAt, DateTime LastSeenAt,
        DateTime? LastHeartbeatAt = null, long LastReportTimestamp = 0, int ReportCount = 0);
    public record UserConnections(int UserId, Link[] Connections, int Total, DateTime UpdatedAt);

    public UserConnections ConnectionsFor(int userId)
    {
        lock (gate)
        {
            var matches = links.Values.Where(link => link.UserId == userId.ToString())
                .OrderByDescending(link => link.ConnectedAt).ToArray();
            return new(userId, matches.Take(500).ToArray(), matches.Length, DateTime.UtcNow);
        }
    }

    // Giới hạn cả tuổi mẫu và số mẫu để lưu lượng tăng không làm bộ nhớ tăng vô hạn.
    public void Record(string kind, string operation, double milliseconds, string outcome, long? inBytes = null, long? outBytes = null)
    {
        lock (gate)
        {
            samples.Enqueue(new(DateTime.UtcNow, kind, operation, milliseconds, outcome, inBytes, outBytes));
            Trim();
        }
    }
    private void Trim()
    {
        var cutoff = DateTime.UtcNow.AddMinutes(-15);
        while (samples.Count > 20000 || samples.TryPeek(out var sample) && sample.At < cutoff)
        {
            if (samples.Count > 20000 && samples.Peek().At >= cutoff) droppedSamples++;
            samples.Dequeue();
        }
        while (events.TryPeek(out var item) && item.At < DateTime.UtcNow.AddHours(-24)) events.Dequeue();
    }
    public object Snapshot(IEnumerable<int>? userIds = null, IEnumerable<string>? fileIds = null)
    {
        var users = userIds?.Select(id => id.ToString()).ToHashSet();
        var files = fileIds?.ToHashSet();
        lock (gate)
        {
            Trim();
            return new { generatedAt = DateTime.UtcNow, scope = "single-instance; memory; last 15 minutes; max 20000 samples",
                activeHttp = Interlocked.Read(ref activeHttp), activeHub = Interlocked.Read(ref activeHub),
                droppedSamples, sampleWindowStart = samples.TryPeek(out var oldest) ? (DateTime?)oldest.At : null,
                totalConnections = links.Count, connectedUsers = links.Values.Select(x => x.UserId).Distinct().Count(),
                connections = links.Values.Where(x => users == null || users.Contains(x.UserId ?? "")).Take(500).ToArray(),
                connectionLimit = 500,
                fileEvents = files == null ? events.ToArray() : events.Where(x => files.Contains(x.TransferId)).TakeLast(500).ToArray(),
                operations = samples.GroupBy(x => new { x.Kind, x.Operation }).Select(g => {
                    var sorted = g.Select(x => x.Milliseconds).Order().ToArray();
                    return new { g.Key.Kind, g.Key.Operation, count = sorted.Length,
                        errors = g.Count(x => x.Outcome == "error"), cancelled = g.Count(x => x.Outcome == "cancelled"),
                        rejected = g.Count(x => x.Outcome == "rejected"),
                        inBytes = g.Any(x => x.InBytes.HasValue) ? g.Sum(x => x.InBytes) : null,
                        outBytes = g.Any(x => x.OutBytes.HasValue) ? g.Sum(x => x.OutBytes) : null,
                        averageMs = sorted.Average(), p95Ms = sorted[(int)Math.Ceiling(sorted.Length * .95) - 1] };
                }).ToArray(),
                series = samples.GroupBy(x => new { x.Kind, Bucket = x.At.Ticks / TimeSpan.TicksPerSecond / 5 })
                    .Select(g => new { g.Key.Kind, at = new DateTime(g.Key.Bucket * 5 * TimeSpan.TicksPerSecond, DateTimeKind.Utc),
                        requestsPerSecond = g.Count() / 5.0 }).ToArray() };
        }
    }
    // Đo từng invocation thay vì coi mỗi frame WebSocket là một HTTP request.
    public async ValueTask<object?> InvokeMethodAsync(HubInvocationContext context,
        Func<HubInvocationContext, ValueTask<object?>> next)
    {
        var start = Stopwatch.GetTimestamp();
        var outcome = "ok";
        long? input = null, output = null;
        Interlocked.Increment(ref activeHub);
        try
        {
            lock (gate)
                if (links.TryGetValue(context.Context.ConnectionId, out var link))
                {
                    // Chặn báo cáo liên tục trước khi chạm semaphore của dịch vụ file.
                    var reporting = context.HubMethodName == "ReportFileObservation";
                    var sameWindow = link.LastReportTimestamp != 0 && Stopwatch.GetElapsedTime(link.LastReportTimestamp).TotalSeconds < 5;
                    if (reporting && sameWindow && link.ReportCount >= 8) throw new HubException("Báo cáo quá thường xuyên.");
                    links[link.Id] = link with { LastSeenAt = DateTime.UtcNow,
                        LastReportTimestamp = reporting && !sameWindow ? start : link.LastReportTimestamp,
                        ReportCount = reporting ? (sameWindow ? link.ReportCount + 1 : 1) : link.ReportCount };
                }
            input = Estimate(context.HubMethodArguments);
            var result = await next(context);
            output = Estimate(result);
            if (context.HubMethodName == "Heartbeat") lock (gate)
                if (links.TryGetValue(context.Context.ConnectionId, out var link))
                    links[link.Id] = link with { LastHeartbeatAt = DateTime.UtcNow };
            return result;
        }
        catch (OperationCanceledException) { outcome = "cancelled"; throw; }
        catch (HubException) { outcome = "rejected"; throw; }
        catch { outcome = "error"; throw; }
        finally
        {
            Interlocked.Decrement(ref activeHub);
            Record("SignalR", context.HubMethodName, Stopwatch.GetElapsedTime(start).TotalMilliseconds, outcome, input, output);
        }
    }
    // Ước tính JSON arguments/result, không bao gồm envelope, broadcast, TLS hoặc chunk P2P.
    // Không giữ bytes, không để lỗi bộ đo làm hỏng invocation nghiệp vụ.
    private static long? Estimate(object? value)
    {
        try { return value is null ? 0 : JsonSerializer.SerializeToUtf8Bytes(value).LongLength; }
        catch { return null; }
    }
    public async Task OnConnectedAsync(HubLifetimeContext context, Func<HubLifetimeContext, Task> next)
    {
        await next(context);
        lock (gate) links[context.Context.ConnectionId] = new(context.Context.ConnectionId,
            context.Context.User?.FindFirst("sub")?.Value, DateTime.UtcNow, DateTime.UtcNow);
    }
    public async Task OnDisconnectedAsync(HubLifetimeContext context, Exception? exception,
        Func<HubLifetimeContext, Exception?, Task> next)
    {
        try { await next(context, exception); }
        finally { lock (gate) links.Remove(context.Context.ConnectionId); }
    }
}

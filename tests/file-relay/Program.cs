using PBL4.Services;

var payload = new byte[12_000_137];
new Random(2026).NextBytes(payload);
using var source = new CountedInput(payload);
using var destination = new PausedOutput();
using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
var pipe = new FileRelayPipe();
var produce = pipe.ReadAsync(source, payload.Length, timeout.Token);
var consume = pipe.WriteAsync(destination, _ => { }, timeout.Token);
await destination.FirstWrite.Task.WaitAsync(timeout.Token);
while (source.Count < 3_968_000) await Task.Delay(5, timeout.Token);
if (source.Count > 4_000_000 || produce.IsCompleted)
    throw new Exception("Uploader exceeded the bounded payload buffer.");
if (destination.Length != 0) throw new Exception("The paused writer was bypassed.");
destination.Unpause.SetResult();
await Task.WhenAll(produce, consume).WaitAsync(timeout.Token);
if (!payload.AsSpan().SequenceEqual(destination.ToArray()))
    throw new Exception("The relay changed or reordered bytes.");
Console.WriteLine("PASS receiver starts before upload ends, queue stays within 4 MB, and bytes remain ordered.");

using var failingSource = new CountedInput(payload);
using var failingTarget = new PausedOutput();
using var stop = new CancellationTokenSource();
pipe = new FileRelayPipe();
produce = pipe.ReadAsync(failingSource, payload.Length, stop.Token);
consume = pipe.WriteAsync(failingTarget, _ => { }, stop.Token);
await failingTarget.FirstWrite.Task.WaitAsync(timeout.Token);
stop.Cancel();
try
{
    await Task.WhenAll(produce, consume).WaitAsync(timeout.Token);
    throw new Exception("The cancelled pipe continued transferring.");
}
catch (OperationCanceledException) when (produce.IsCanceled && consume.IsCanceled) { }
Console.WriteLine("PASS cancelling a stalled relay releases both ends.");

sealed class CountedInput(byte[] payload) : MemoryStream(payload)
{
    private int count;
    public int Count => Volatile.Read(ref count);
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
    {
        var bytes = await base.ReadAsync(buffer, ct);
        Interlocked.Add(ref count, bytes);
        return bytes;
    }
}

sealed class PausedOutput : MemoryStream
{
    public TaskCompletionSource FirstWrite { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource Unpause { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default)
    {
        FirstWrite.TrySetResult();
        await Unpause.Task.WaitAsync(ct);
        await base.WriteAsync(buffer, ct);
    }
}

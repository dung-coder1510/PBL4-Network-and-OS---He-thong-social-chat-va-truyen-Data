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

foreach (var channels in new[] { 2, 4 })
{
    var stripedInputs = Enumerable.Range(0, channels).Select(channel =>
    {
        using var stripes = new MemoryStream();
        for (var offset = channel * FileRelayPipe.BlockBytes; offset < payload.Length;
             offset += channels * FileRelayPipe.BlockBytes)
            stripes.Write(payload, offset, Math.Min(FileRelayPipe.BlockBytes, payload.Length - offset));
        return new CountedInput(stripes.ToArray());
    }).ToArray();
    using var stripedOutput = new PausedOutput();
    using var stripedTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
    var stripedPipe = new FileRelayPipe(channels);
    var readers = stripedInputs.Select((input, channel) =>
        stripedPipe.ReadAsync(input, input.Length, stripedTimeout.Token, channel)).ToArray();
    var writer = stripedPipe.WriteAsync(stripedOutput, _ => { }, stripedTimeout.Token);
    await stripedOutput.FirstWrite.Task.WaitAsync(stripedTimeout.Token);
    var expectedBuffered = (FileRelayPipe.MaximumBufferBytes / FileRelayPipe.BlockBytes / channels) *
        channels * FileRelayPipe.BlockBytes;
    while (stripedInputs.Sum(input => input.Count) < expectedBuffered)
        await Task.Delay(5, stripedTimeout.Token);
    if (stripedInputs.Sum(input => input.Count) > FileRelayPipe.MaximumBufferBytes || readers.Any(task => task.IsCompleted))
        throw new Exception("Parallel inputs exceeded the shared 4 MB window.");
    stripedOutput.Unpause.SetResult();
    await Task.WhenAll(readers.Append(writer)).WaitAsync(stripedTimeout.Token);
    if (!payload.AsSpan().SequenceEqual(stripedOutput.ToArray()))
        throw new Exception("Parallel inputs reordered or changed the output file.");
    foreach (var input in stripedInputs) input.Dispose();
    Console.WriteLine($"PASS {channels} parallel inputs share 4 MB, stream in order and preserve every byte.");

    using var cancelParallel = new CancellationTokenSource();
    using var blockedOutput = new PausedOutput();
    var blockedPipe = new FileRelayPipe(channels);
    var blockedInputs = Enumerable.Range(0, channels).Select(_ => new MemoryStream(payload)).ToArray();
    var blockedReaders = blockedInputs.Select((input, channel) =>
        blockedPipe.ReadAsync(input, input.Length, cancelParallel.Token, channel)).ToArray();
    var blockedWriter = blockedPipe.WriteAsync(blockedOutput, _ => { }, cancelParallel.Token);
    await blockedOutput.FirstWrite.Task.WaitAsync(stripedTimeout.Token);
    cancelParallel.Cancel();
    try
    {
        await Task.WhenAll(blockedReaders.Append(blockedWriter)).WaitAsync(stripedTimeout.Token);
        throw new Exception("A cancelled parallel relay remained active.");
    }
    catch (OperationCanceledException) when (blockedReaders.All(task => task.IsCanceled) && blockedWriter.IsCanceled) { }
    foreach (var input in blockedInputs) input.Dispose();
    Console.WriteLine($"PASS cancellation releases all {channels} parallel inputs and the stalled output.");
}

for (var channels = 1; channels <= 4; channels *= 2)
    foreach (var size in new long[] { 0, 1, 63_999, 64_000, 64_001, 128_001, 110_000_000, 10_737_418_240 })
        if (Enumerable.Range(0, channels).Sum(channel => FileRelayPipe.ChannelLength(size, channels, channel)) != size)
            throw new Exception("Parallel content lengths do not cover the original file.");
Console.WriteLine("PASS striped lengths cover empty, partial-block and 10 GB files.");

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

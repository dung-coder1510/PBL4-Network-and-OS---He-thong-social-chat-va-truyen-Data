using System.Security.Cryptography;
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

// === FileRelayPartStore checks (Phase 2) ===
static string HexSha256(ReadOnlySpan<byte> data) => Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();

foreach (var size in new long[] { 0, 1, FileRelayPartStore.DefaultPartBytes, FileRelayPartStore.DefaultPartBytes + 1, 10L * 1024 * 1024 * 1024 })
{
    var storeCheck = new FileRelayPartStore(size);
    long sum = 0;
    for (var idx = 0; idx < storeCheck.TotalParts; idx++)
        sum += FileRelayPartStore.PartLength(size, FileRelayPartStore.DefaultPartBytes, idx);
    if (sum != size) throw new Exception($"PartLength sum mismatch for {size}: {sum}");
    if (size == 0 && !storeCheck.AllAckedTask.IsCompleted)
        throw new Exception("Empty multipart store must be immediately acked.");
    storeCheck.Dispose();
}
Console.WriteLine("PASS multipart sizes cover 0 B, 1 B, 4 MiB boundaries and 10 GiB.");

using (var global = new SemaphoreSlim(8, 8))
{
    var partBytes = 65_536;
    var totalSize = partBytes * 8 + 123;
    var store = new FileRelayPartStore(totalSize, partBytes, global, maxBufferedParts: 6);
    var data = new byte[totalSize];
    new Random(42).NextBytes(data);
    using var partTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));

    // Fill window 0..5 (6 parts)
    for (var i = 0; i < 6; i++)
    {
        var len = FileRelayPartStore.PartLength(totalSize, partBytes, i);
        using var ms = new MemoryStream(data, i * partBytes, len);
        var stored = await store.PutPartAsync(i, ms, HexSha256(data.AsSpan(i * partBytes, len)), partTimeout.Token);
        if (!stored) throw new Exception("Expected new slot stored.");
    }
    if (global.CurrentCount != 2) throw new Exception($"Expected 6 slots consumed, remaining={global.CurrentCount}");

    // Part 6 must block on sliding window until part 0 is acked
    var len6 = FileRelayPartStore.PartLength(totalSize, partBytes, 6);
    var put6 = store.PutPartAsync(6, new MemoryStream(data, 6 * partBytes, len6), HexSha256(data.AsSpan(6 * partBytes, len6)), partTimeout.Token);
    await Task.Delay(30, partTimeout.Token);
    if (put6.IsCompleted) throw new Exception("Window cap of 6 parts was bypassed.");

    // Hold lease on part 0 while acking it; slot must stay reserved until lease disposes
    var lease0 = await store.RentPartAsync(0, null, null, partTimeout.Token);
    if (!lease0.Payload.Span.SequenceEqual(data.AsSpan(0, partBytes)))
        throw new Exception("Part 0 bytes mismatch.");
    store.AckParts([0]);
    store.AckParts([0]); // duplicate ACK must be idempotent
    if (global.CurrentCount != 2) throw new Exception("Global slot released while lease still active.");
    lease0.Dispose();
    await put6.WaitAsync(partTimeout.Token);
    if (global.CurrentCount != 2) throw new Exception("Window slide + lease dispose leaked global slots.");

    // Idempotent retry of part 1 returns false; conflicting hash throws
    using (var retry1 = new MemoryStream(data, partBytes, partBytes))
    {
        if (await store.PutPartAsync(1, retry1, HexSha256(data.AsSpan(partBytes, partBytes)), partTimeout.Token))
            throw new Exception("Duplicate identical part should be idempotent.");
    }
    var conflictCaught = false;
    try
    {
        await store.PutPartAsync(1, new MemoryStream(data, partBytes, partBytes), new string('b', 64), partTimeout.Token);
    }
    catch (InvalidOperationException ex) when (ex.Message == "PART_HASH_CONFLICT") { conflictCaught = true; }
    if (!conflictCaught) throw new Exception("Conflicting part hash was not rejected.");

    // Ack part 1 so window advances to [2..7], then test corrupt hash on part 7
    using (var lease1 = await store.RentPartAsync(1, null, null, partTimeout.Token))
    {
        if (!lease1.Payload.Span.SequenceEqual(data.AsSpan(partBytes, partBytes)))
            throw new Exception("Part 1 bytes mismatch.");
        store.AckParts([1]);
    }
    var badCaught = false;
    try
    {
        var len7 = FileRelayPartStore.PartLength(totalSize, partBytes, 7);
        await store.PutPartAsync(7, new MemoryStream(data, 7 * partBytes, len7), new string('a', 64), partTimeout.Token);
    }
    catch (InvalidDataException) { badCaught = true; }
    if (!badCaught || global.CurrentCount != 3) throw new Exception("Corrupt part hash check or slot release failed.");

    // Upload part 7 and ack part 2 so window advances to [3..8], then upload part 8
    var len7Valid = FileRelayPartStore.PartLength(totalSize, partBytes, 7);
    await store.PutPartAsync(7, new MemoryStream(data, 7 * partBytes, len7Valid), HexSha256(data.AsSpan(7 * partBytes, len7Valid)), partTimeout.Token);
    using (var lease2 = await store.RentPartAsync(2, null, null, partTimeout.Token))
    {
        if (!lease2.Payload.Span.SequenceEqual(data.AsSpan(2 * partBytes, partBytes)))
            throw new Exception("Part 2 bytes mismatch.");
        store.AckParts([2]);
    }
    var len8Valid = FileRelayPartStore.PartLength(totalSize, partBytes, 8);
    await store.PutPartAsync(8, new MemoryStream(data, 8 * partBytes, len8Valid), HexSha256(data.AsSpan(8 * partBytes, len8Valid)), partTimeout.Token);

    for (var i = 3; i < store.TotalParts; i++)
    {
        var len = FileRelayPartStore.PartLength(totalSize, partBytes, i);
        using var lease = await store.RentPartAsync(i, i > 3 ? i - 1 : null, null, partTimeout.Token);
        if (!lease.Payload.Span.SequenceEqual(data.AsSpan(i * partBytes, len)))
            throw new Exception($"Part {i} bytes mismatch.");
    }
    store.AckParts([store.TotalParts - 1]);
    await store.AllAckedTask.WaitAsync(partTimeout.Token);
    store.Dispose();
    if (global.CurrentCount != 8) throw new Exception($"Expected all 8 global slots released, got {global.CurrentCount}");
}
Console.WriteLine("PASS multipart sliding window, active read lease safety, idempotent retry, hash guard and clean slot release.");

using (var tinyGlobal = new SemaphoreSlim(2, 2))
{
    var storeA = new FileRelayPartStore(65_536 * 4, 65_536, tinyGlobal);
    var storeB = new FileRelayPartStore(65_536 * 4, 65_536, tinyGlobal);
    var buf = new byte[65_536];
    var h = HexSha256(buf);
    await storeA.PutPartAsync(0, new MemoryStream(buf), h, CancellationToken.None);
    await storeB.PutPartAsync(0, new MemoryStream(buf), h, CancellationToken.None);
    var blockedPut = storeA.PutPartAsync(1, new MemoryStream(buf), h, CancellationToken.None);
    var waitingGet = storeB.RentPartAsync(2, null, null, CancellationToken.None);
    await Task.Delay(30);
    if (blockedPut.IsCompleted || waitingGet.IsCompleted)
        throw new Exception("Global slot limit or missing part waiter failed to block.");
    storeB.Dispose();
    var bCancelled = false;
    try { await waitingGet; } catch (OperationCanceledException) { bCancelled = true; }
    if (!bCancelled) throw new Exception("Dispose did not cancel pending reader.");
    await blockedPut;
    storeA.Dispose();
    if (tinyGlobal.CurrentCount != 2) throw new Exception($"Global slot leak after Dispose: {tinyGlobal.CurrentCount}");
}
Console.WriteLine("PASS global slot cap and Dispose cancellation release every slot.");

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

using System.Buffers;
using System.Security.Cryptography;

namespace PBL4.Services;

internal sealed class FileRelayPartStore : IDisposable
{
    public const int MaxPartBytes = 4 * 1024 * 1024;
    public const int DefaultPartBytes = 4 * 1024 * 1024;
    public const int MaxBufferedPartsPerTransfer = 16;
    public const int MaxGlobalBufferedParts = 64;
    private static readonly SemaphoreSlim DefaultGlobalSlots = new(MaxGlobalBufferedParts, MaxGlobalBufferedParts);

    private readonly object sync = new();
    private readonly SemaphoreSlim globalSlots;
    private readonly int maxBufferedParts;
    private readonly Dictionary<int, PartSlot> slots = [];
    private readonly Dictionary<int, List<TaskCompletionSource>> partWaiters = [];
    private readonly List<TaskCompletionSource> windowWaiters = [];
    private readonly TaskCompletionSource allAcked = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly bool[] acked;
    private readonly string?[] partHashes;
    private int windowBase;
    private int ackedCount;
    private bool disposed;

    public long FileSize { get; }
    public int PartBytes { get; }
    public int TotalParts { get; }
    public Task AllAckedTask => allAcked.Task;

    public FileRelayPartStore(long fileSize, int partBytes = DefaultPartBytes, SemaphoreSlim? globalSlots = null,
        int maxBufferedParts = MaxBufferedPartsPerTransfer)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(fileSize);
        if (partBytes <= 0 || partBytes > MaxPartBytes)
            throw new ArgumentOutOfRangeException(nameof(partBytes));
        if (maxBufferedParts <= 0)
            throw new ArgumentOutOfRangeException(nameof(maxBufferedParts));
        FileSize = fileSize;
        PartBytes = partBytes;
        TotalParts = fileSize == 0 ? 0 : (int)((fileSize + partBytes - 1) / partBytes);
        acked = new bool[TotalParts];
        partHashes = new string?[TotalParts];
        this.globalSlots = globalSlots ?? DefaultGlobalSlots;
        this.maxBufferedParts = maxBufferedParts;
        if (TotalParts == 0) allAcked.TrySetResult();
    }

    public static int PartLength(long fileSize, int partBytes, int partIndex)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(fileSize);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(partBytes);
        if (partIndex < 0) throw new ArgumentOutOfRangeException(nameof(partIndex));
        var offset = (long)partIndex * partBytes;
        if (offset >= fileSize) throw new ArgumentOutOfRangeException(nameof(partIndex));
        return (int)Math.Min(partBytes, fileSize - offset);
    }

    public async Task<bool> PutPartAsync(int partIndex, Stream source, string partSha256Hex, CancellationToken ct)
    {
        if (partIndex < 0 || partIndex >= TotalParts)
            throw new ArgumentOutOfRangeException(nameof(partIndex));
        var expectedBytes = ParseSha256(partSha256Hex);
        var normalizedHash = Convert.ToHexString(expectedBytes).ToLowerInvariant();
        var expectedLength = PartLength(FileSize, PartBytes, partIndex);

        while (true)
        {
            Task waitWindow;
            lock (sync)
            {
                if (disposed) throw new OperationCanceledException(ct);
                if (acked[partIndex] || slots.ContainsKey(partIndex))
                {
                    if (!string.Equals(partHashes[partIndex], normalizedHash, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("PART_HASH_CONFLICT");
                    return false;
                }
                if (partIndex < windowBase + maxBufferedParts) break;
                var waiter = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                windowWaiters.Add(waiter);
                waitWindow = waiter.Task;
            }
            try { await waitWindow.WaitAsync(ct); }
            catch
            {
                lock (sync) windowWaiters.RemoveAll(item => ReferenceEquals(item.Task, waitWindow));
                throw;
            }
        }

        await globalSlots.WaitAsync(ct);
        byte[]? buffer = null;
        var slotAcquired = true;
        try
        {
            lock (sync)
            {
                if (disposed) throw new OperationCanceledException(ct);
                if (acked[partIndex] || slots.ContainsKey(partIndex))
                {
                    if (!string.Equals(partHashes[partIndex], normalizedHash, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("PART_HASH_CONFLICT");
                    slotAcquired = false;
                    globalSlots.Release();
                    return false;
                }
            }

            buffer = ArrayPool<byte>.Shared.Rent(expectedLength);
            await source.ReadExactlyAsync(buffer.AsMemory(0, expectedLength), ct);
            var actualBytes = SHA256.HashData(buffer.AsSpan(0, expectedLength));
            if (!actualBytes.AsSpan().SequenceEqual(expectedBytes))
                throw new InvalidDataException("PART_SHA256_MISMATCH");

            var slot = new PartSlot(buffer, expectedLength, normalizedHash);
            lock (sync)
            {
                if (disposed) throw new OperationCanceledException(ct);
                if (acked[partIndex] || slots.ContainsKey(partIndex))
                {
                    if (!string.Equals(partHashes[partIndex], normalizedHash, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("PART_HASH_CONFLICT");
                    ArrayPool<byte>.Shared.Return(buffer);
                    buffer = null;
                    slotAcquired = false;
                    globalSlots.Release();
                    return false;
                }
                partHashes[partIndex] = normalizedHash;
                slots[partIndex] = slot;
                buffer = null;
                slotAcquired = false;
                if (partWaiters.Remove(partIndex, out var waiters))
                    foreach (var waiter in waiters) waiter.TrySetResult();
                return true;
            }
        }
        catch
        {
            if (buffer is not null) ArrayPool<byte>.Shared.Return(buffer);
            if (slotAcquired) globalSlots.Release();
            throw;
        }
    }

    public async Task<PartLease> RentPartAsync(int partIndex, int? ackPartIndex, Action<int>? onAckedBytes, CancellationToken ct)
    {
        if (partIndex < 0 || partIndex >= TotalParts)
            throw new ArgumentOutOfRangeException(nameof(partIndex));
        if (ackPartIndex.HasValue)
        {
            if (ackPartIndex.Value < 0 || ackPartIndex.Value >= TotalParts)
                throw new ArgumentOutOfRangeException(nameof(ackPartIndex));
            AckParts([ackPartIndex.Value], onAckedBytes);
        }

        while (true)
        {
            Task waitPart;
            lock (sync)
            {
                if (disposed) throw new OperationCanceledException(ct);
                if (slots.TryGetValue(partIndex, out var slot))
                {
                    slot.ActiveReads++;
                    return new PartLease(this, slot);
                }
                if (acked[partIndex])
                    throw new InvalidOperationException("PART_ALREADY_ACKED");
                var waiter = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                if (!partWaiters.TryGetValue(partIndex, out var waiters))
                {
                    waiters = [];
                    partWaiters[partIndex] = waiters;
                }
                waiters.Add(waiter);
                waitPart = waiter.Task;
            }
            try { await waitPart.WaitAsync(ct); }
            catch
            {
                lock (sync)
                {
                    if (partWaiters.TryGetValue(partIndex, out var waiters))
                    {
                        waiters.RemoveAll(item => ReferenceEquals(item.Task, waitPart));
                        if (waiters.Count == 0) partWaiters.Remove(partIndex);
                    }
                }
                throw;
            }
        }
    }

    public void AckParts(IEnumerable<int> partIndices, Action<int>? onAckedBytes = null)
    {
        lock (sync)
        {
            if (disposed) return;
            foreach (var partIndex in partIndices)
            {
                if (partIndex < 0 || partIndex >= TotalParts || acked[partIndex]) continue;
                if (!slots.Remove(partIndex, out var slot)) continue;
                acked[partIndex] = true;
                ackedCount++;
                onAckedBytes?.Invoke(slot.Length);
                slot.Released = true;
                if (slot.ActiveReads == 0)
                {
                    ArrayPool<byte>.Shared.Return(slot.Buffer);
                    globalSlots.Release();
                }
            }
            while (windowBase < TotalParts && acked[windowBase]) windowBase++;
            WakeWindowWaitersLocked();
            if (ackedCount == TotalParts) allAcked.TrySetResult();
        }
    }

    public void Dispose()
    {
        lock (sync)
        {
            if (disposed) return;
            disposed = true;
            foreach (var slot in slots.Values)
            {
                slot.Released = true;
                if (slot.ActiveReads == 0)
                {
                    ArrayPool<byte>.Shared.Return(slot.Buffer);
                    globalSlots.Release();
                }
            }
            slots.Clear();
            foreach (var waiters in partWaiters.Values)
                foreach (var waiter in waiters) waiter.TrySetCanceled();
            partWaiters.Clear();
            WakeWindowWaitersLocked(cancel: true);
            allAcked.TrySetCanceled();
        }
    }

    private void ReleaseLease(PartSlot slot)
    {
        lock (sync)
        {
            slot.ActiveReads--;
            if ((slot.Released || disposed) && slot.ActiveReads == 0)
            {
                ArrayPool<byte>.Shared.Return(slot.Buffer);
                globalSlots.Release();
            }
        }
    }

    private void WakeWindowWaitersLocked(bool cancel = false)
    {
        if (windowWaiters.Count == 0) return;
        foreach (var waiter in windowWaiters)
        {
            if (cancel) waiter.TrySetCanceled();
            else waiter.TrySetResult();
        }
        windowWaiters.Clear();
    }

    private static byte[] ParseSha256(string value)
    {
        if (string.IsNullOrEmpty(value) || value.Length != 64 || !value.All(Uri.IsHexDigit))
            throw new FormatException("SHA-256 phải gồm 64 ký tự hex.");
        return Convert.FromHexString(value);
    }

    internal sealed class PartSlot(byte[] buffer, int length, string sha256Hex)
    {
        public byte[] Buffer { get; } = buffer;
        public int Length { get; } = length;
        public string Sha256Hex { get; } = sha256Hex;
        public int ActiveReads { get; set; }
        public bool Released { get; set; }
    }

    public sealed class PartLease : IDisposable
    {
        private readonly FileRelayPartStore store;
        private readonly PartSlot slot;
        private int disposedFlag;

        internal PartLease(FileRelayPartStore store, PartSlot slot)
        {
            this.store = store;
            this.slot = slot;
        }

        public ReadOnlyMemory<byte> Payload => slot.Buffer.AsMemory(0, slot.Length);
        public string Sha256Hex => slot.Sha256Hex;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposedFlag, 1) != 0) return;
            store.ReleaseLease(slot);
        }
    }
}

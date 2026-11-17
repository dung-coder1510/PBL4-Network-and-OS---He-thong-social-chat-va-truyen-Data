using System.Threading.Channels;

namespace PBL4.Services;

internal sealed class FileRelayPipe
{
    public const int MaximumBufferBytes = 4_000_000;
    public const int BlockBytes = 64_000;
    private const int SlotCount = MaximumBufferBytes / BlockBytes;
    private readonly byte[] buffer = new byte[SlotCount * BlockBytes];
    private readonly Channel<int> free = Channel.CreateBounded<int>(SlotCount);
    private readonly Channel<(int Slot, int Length)> ready = Channel.CreateBounded<(int, int)>(SlotCount);

    public FileRelayPipe()
    {
        for (var slot = 0; slot < SlotCount; slot++) free.Writer.TryWrite(slot);
    }

    // Mỗi slot đi từ danh sách trống qua luồng đọc, hàng đợi và luồng ghi rồi mới được tái sử dụng.
    public async Task ReadAsync(Stream source, long total, CancellationToken ct)
    {
        try
        {
            while (total > 0)
            {
                var slot = await free.Reader.ReadAsync(ct);
                var block = buffer.AsMemory(slot * BlockBytes, (int)Math.Min(total, BlockBytes));
                var count = await source.ReadAsync(block, ct);
                if (count == 0) throw new EndOfStreamException("Tệp nguồn thiếu dữ liệu.");
                total -= count;
                await ready.Writer.WriteAsync((slot, count), ct);
            }
            ready.Writer.TryComplete();
        }
        catch (Exception error)
        {
            ready.Writer.TryComplete(error);
            throw;
        }
    }

    public async Task WriteAsync(Stream destination, Action<int> forwarded, CancellationToken ct)
    {
        await foreach (var block in ready.Reader.ReadAllAsync(ct))
        {
            await destination.WriteAsync(buffer.AsMemory(block.Slot * BlockBytes, block.Length), ct);
            await destination.FlushAsync(ct);
            forwarded(block.Length);
            free.Writer.TryWrite(block.Slot);
        }
    }
}

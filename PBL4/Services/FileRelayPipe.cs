using System.Threading.Channels;

namespace PBL4.Services;

internal sealed class FileRelayPipe
{
    public const int MaximumBufferBytes = 4_000_000;
    public const int BlockBytes = 64_000;
    private readonly byte[] buffer;
    private readonly Channel<int>[] free;
    private readonly Channel<(int Slot, int Length)>[] ready;

    public FileRelayPipe(int channelCount = 1)
    {
        if (channelCount is not (1 or 2 or 4)) throw new ArgumentOutOfRangeException(nameof(channelCount));
        var slotsPerChannel = MaximumBufferBytes / BlockBytes / channelCount;
        buffer = new byte[slotsPerChannel * channelCount * BlockBytes];
        free = new Channel<int>[channelCount];
        ready = new Channel<(int, int)>[channelCount];
        for (var channel = 0; channel < channelCount; channel++)
        {
            free[channel] = Channel.CreateBounded<int>(slotsPerChannel);
            ready[channel] = Channel.CreateBounded<(int, int)>(slotsPerChannel);
            for (var slot = 0; slot < slotsPerChannel; slot++)
                free[channel].Writer.TryWrite(channel * slotsPerChannel + slot);
        }
    }

    // Mỗi kết nối tải các khối 64 KB xen kẽ. Chừa sẵn ô cho từng kết nối để tránh chờ vòng.
    public static long ChannelLength(long size, int channels, int channel)
    {
        var blocks = size / BlockBytes;
        var length = (blocks / channels + (channel < blocks % channels ? 1 : 0)) * BlockBytes;
        return length + (channel == blocks % channels ? size % BlockBytes : 0);
    }

    // Mỗi slot đi từ danh sách trống qua luồng đọc, hàng đợi và luồng ghi rồi mới được tái sử dụng.
    public async Task ReadAsync(Stream source, long total, CancellationToken ct, int channel = 0)
    {
        try
        {
            while (total > 0)
            {
                var slot = await free[channel].Reader.ReadAsync(ct);
                var block = buffer.AsMemory(slot * BlockBytes, (int)Math.Min(total, BlockBytes));
                var count = block.Length;
                if (ready.Length == 1) count = await source.ReadAsync(block, ct);
                else await source.ReadExactlyAsync(block, ct);
                if (count == 0) throw new EndOfStreamException("Tệp nguồn thiếu dữ liệu.");
                total -= count;
                await ready[channel].Writer.WriteAsync((slot, count), ct);
            }
            ready[channel].Writer.TryComplete();
        }
        catch (Exception error)
        {
            ready[channel].Writer.TryComplete(error);
            throw;
        }
    }

    public async Task WriteAsync(Stream destination, Action<int> forwarded, CancellationToken ct)
    {
        var completed = new bool[ready.Length];
        var remaining = ready.Length;
        while (remaining > 0)
        {
            for (var channel = 0; channel < ready.Length; channel++)
            {
                if (completed[channel]) continue;
                if (!await ready[channel].Reader.WaitToReadAsync(ct))
                {
                    completed[channel] = true;
                    remaining--;
                    continue;
                }
                var block = await ready[channel].Reader.ReadAsync(ct);
                await destination.WriteAsync(buffer.AsMemory(block.Slot * BlockBytes, block.Length), ct);
                forwarded(block.Length);
                free[channel].Writer.TryWrite(block.Slot);
            }
        }
    }
}

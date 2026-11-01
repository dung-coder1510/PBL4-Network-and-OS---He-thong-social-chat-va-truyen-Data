namespace PBL4.Services;

// Đếm byte thực sự đọc/ghi qua stream ứng dụng, không sao chép hay lưu payload.
// Đây không phải băng thông trên dây (không tính TLS/header); không đóng stream gốc.
public sealed class MeasuredStream(Stream inner) : Stream
{
    public long Bytes;
    public override bool CanRead => inner.CanRead;
    public override bool CanSeek => inner.CanSeek;
    public override bool CanWrite => inner.CanWrite;
    public override long Length => inner.Length;
    public override long Position { get => inner.Position; set => inner.Position = value; }
    public override void Flush() => inner.Flush();
    public override Task FlushAsync(CancellationToken ct) => inner.FlushAsync(ct);
    public override long Seek(long offset, SeekOrigin origin) => inner.Seek(offset, origin);
    public override void SetLength(long value) => inner.SetLength(value);
    public override int Read(byte[] buffer, int offset, int count)
    { var read = inner.Read(buffer, offset, count); Interlocked.Add(ref Bytes, read); return read; }
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
    { var read = await inner.ReadAsync(buffer, ct); Interlocked.Add(ref Bytes, read); return read; }
    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct) =>
        ReadAsync(buffer.AsMemory(offset, count), ct).AsTask();
    public override void Write(byte[] buffer, int offset, int count)
    { inner.Write(buffer, offset, count); Interlocked.Add(ref Bytes, count); }
    public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default)
    { await inner.WriteAsync(buffer, ct); Interlocked.Add(ref Bytes, buffer.Length); }
    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct) =>
        WriteAsync(buffer.AsMemory(offset, count), ct).AsTask();
}

using System.Diagnostics;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace PBL4.Controllers;

[ApiController, Authorize, EnableRateLimiting("relay-diagnostics")]
[Route("api/v1/files/relay/diagnostics")]
public sealed class FileRelayDiagnosticsController : ControllerBase
{
    public const int SampleBytes = 110_000_000;
    private static readonly SemaphoreSlim Capacity = new(2, 2);

    // Đọc rồi bỏ từng khối, đo riêng chặng tải lên mà không phụ thuộc tốc độ của người nhận.
    [HttpPut, RequestSizeLimit(SampleBytes)]
    public async Task<IActionResult> Upload(CancellationToken ct)
    {
        if (Request.ContentLength is not > 0 or > SampleBytes) return BadRequest();
        if (!await Capacity.WaitAsync(0, ct)) return StatusCode(429);
        try
        {
            var watch = Stopwatch.StartNew();
            var buffer = new byte[64_000];
            long received = 0;
            int count;
            while ((count = await Request.Body.ReadAsync(buffer, ct)) > 0) received += count;
            if (received != Request.ContentLength) return BadRequest();
            return Ok(new { receivedBytes = received, elapsedMs = watch.Elapsed.TotalMilliseconds });
        }
        finally { Capacity.Release(); }
    }

    // Sinh dữ liệu có độ dài và SHA-256 xác định, chuyển ngay từng khối để đo chặng tải xuống và ghi đĩa.
    [HttpGet]
    public async Task<IActionResult> Download([FromQuery] int bytes = SampleBytes, CancellationToken ct = default)
    {
        if (bytes <= 0 || bytes > SampleBytes) return BadRequest();
        if (!await Capacity.WaitAsync(0, ct)) return StatusCode(429);
        try
        {
            var buffer = new byte[64_000];
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            for (var remaining = bytes; remaining > 0; remaining -= Math.Min(remaining, buffer.Length))
                hash.AppendData(buffer, 0, Math.Min(remaining, buffer.Length));
            Response.Headers["X-File-SHA256"] = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
            Response.Headers["X-Accel-Buffering"] = "no";
            Response.Headers.CacheControl = "no-store";
            Response.ContentType = "application/octet-stream";
            Response.ContentLength = bytes;
            HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
            for (var remaining = bytes; remaining > 0; remaining -= Math.Min(remaining, buffer.Length))
            {
                await Response.Body.WriteAsync(buffer.AsMemory(0, Math.Min(remaining, buffer.Length)), ct);
                await Response.Body.FlushAsync(ct);
            }
            return new EmptyResult();
        }
        finally { Capacity.Release(); }
    }
}

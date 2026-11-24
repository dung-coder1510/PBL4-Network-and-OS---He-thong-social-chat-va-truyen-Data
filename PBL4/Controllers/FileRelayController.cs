using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using PBL4.Contracts;
using PBL4.Services;

namespace PBL4.Controllers;

[ApiController, Authorize]
[Route("api/v1/files")]
public sealed class FileRelayController(FileTransferService files) : ControllerBase
{
    private int UserId => int.Parse(User.FindFirstValue("sub")!);
    private string SessionId => User.FindFirstValue("sid")!;
    private string ReceiverKey => Request.Headers["X-File-Relay-Key"].FirstOrDefault()
        ?? Request.Query["key"].ToString();
    private string SenderKey => Request.Headers["X-File-Relay-Sender-Key"].FirstOrDefault()
        ?? Request.Query["key"].ToString();

    [HttpGet("{id:long}")]
    public Task<IActionResult> Get(long id) => ReplyAsync(() => files.GetFileAsync(id, UserId));

    [HttpPost("relay"), RequestSizeLimit(8192)]
    public Task<IActionResult> Create(OfferFileDto request) => ReplyAsync(async () =>
    {
        var (transfer, senderKey) = await files.OfferRelayWithKeyAsync(UserId, SessionId, request);
        if (senderKey is not null) Response.Headers["X-File-Relay-Sender-Key"] = senderKey;
        return transfer;
    });

    [HttpPost("{id:long}/relay")]
    public Task<IActionResult> Switch(long id, [FromQuery] string? mode = null, [FromQuery] int connections = 4) =>
        ReplyAsync(async () =>
        {
            var (transfer, senderKey) = await files.SwitchRelayAsync(id, UserId, SessionId, mode, connections);
            if (senderKey is not null) Response.Headers["X-File-Relay-Sender-Key"] = senderKey;
            return transfer;
        });

    [HttpPost("{id:long}/relay/session")]
    public Task<IActionResult> ClaimSenderSession(long id) =>
        ReplyAsync(() => files.ClaimRelaySenderSessionAsync(id, UserId, SessionId));

    [HttpPost("{id:long}/relay/accept"), RequestSizeLimit(8192)]
    public Task<IActionResult> Accept(long id, FileActionDto request) =>
        ReplyAsync(() => files.AcceptRelayAsync(id, UserId, SessionId, request));

    [HttpGet("{id:long}/relay/content")]
    public Task<IActionResult> Download(long id) => StreamAsync(() =>
        files.DownloadRelayAsync(id, UserId, SessionId, ReceiverKey, content =>
        {
            HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
            Response.Headers.CacheControl = "no-store";
            Response.Headers["X-Accel-Buffering"] = "no";
            Response.Headers["X-File-SHA256"] = content.Sha256Hex;
            Response.ContentType = "application/octet-stream";
            Response.ContentLength = content.Size;
            return Response.Body;
        }, HttpContext.RequestAborted));

    [HttpPut("{id:long}/relay/content"), RequestSizeLimit(FileTransferService.MaximumFileBytes)]
    public Task<IActionResult> Upload(long id, [FromQuery] int? channel = null) => ReplyAsync(() =>
        files.UploadRelayAsync(id, UserId, SessionId, Request.Headers["X-File-SHA256"].ToString(),
            Request.ContentLength, Request.Body, HttpContext.RequestAborted, channel));

    [HttpPost("{id:long}/relay/upload"), RequestSizeLimit(8192)]
    public Task<IActionResult> Prepare(long id, PrepareFileRelayDto request) => ReplyAsync(() =>
        files.PrepareRelayAsync(id, UserId, SessionId, request, HttpContext.RequestAborted));

    [HttpPut("{id:long}/relay/parts/{partIndex:int}"), HttpPost("{id:long}/relay/parts/{partIndex:int}"), AllowAnonymous, RequestSizeLimit(FileRelayPartStore.MaxPartBytes)]
    public Task<IActionResult> PutPart(long id, int partIndex, [FromQuery] string? sha256 = null) => ReplyAsync(async () =>
    {
        var partHash = Request.Headers["X-Part-SHA256"].FirstOrDefault() ?? sha256 ?? "";
        var relayedBytes = await files.PutRelayPartAsync(id, partIndex, SenderKey,
            partHash, Request.ContentLength, Request.Body, HttpContext.RequestAborted);
        return new { partIndex, relayedBytes };
    });

    [HttpGet("{id:long}/relay/parts/{partIndex:int}"), AllowAnonymous]
    public Task<IActionResult> GetPart(long id, int partIndex, [FromQuery] int? ack = null) => StreamAsync(() =>
        files.GetRelayPartAsync(id, partIndex, ack, ReceiverKey, (length, partSha256Hex) =>
        {
            HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
            Response.Headers.CacheControl = "no-store";
            Response.Headers["X-Accel-Buffering"] = "no";
            Response.Headers["X-Part-SHA256"] = partSha256Hex;
            Response.ContentType = "application/octet-stream";
            Response.ContentLength = length;
            return Response.Body;
        }, HttpContext.RequestAborted));

    [HttpPost("{id:long}/relay/parts/ack"), AllowAnonymous, RequestSizeLimit(4096)]
    public Task<IActionResult> AckParts(long id, AckRelayPartsDto request) => ReplyAsync(async () =>
    {
        var (relayedBytes, sha256Hex) = await files.AckRelayPartsAsync(id, ReceiverKey, request.PartIndices,
            HttpContext.RequestAborted);
        return new { relayedBytes, sha256Hex };
    });

    [HttpGet("{id:long}/relay/hash"), AllowAnonymous]
    public Task<IActionResult> GetHash(long id) => ReplyAsync(async () =>
        new { sha256Hex = await files.GetRelayHashAsync(id, ReceiverKey, HttpContext.RequestAborted) });

    [HttpPost("{id:long}/relay/hash"), AllowAnonymous, RequestSizeLimit(1024)]
    public Task<IActionResult> FinalizeHash(long id, RelayHashDto request) =>
        ReplyAsync(() => files.FinalizeRelayHashAsync(id, SenderKey, request.Sha256Hex, HttpContext.RequestAborted));

    [HttpPost("{id:long}/relay/complete"), AllowAnonymous, RequestSizeLimit(8192)]
    public Task<IActionResult> Complete(long id, CompleteFileDto receipt) =>
        ReplyAsync(() => files.CompleteRelayAsync(id, ReceiverKey, receipt, HttpContext.RequestAborted));

    [HttpDelete("{id:long}/relay")]
    public Task<IActionResult> End(long id, [FromQuery] string action = "cancel") =>
        ReplyAsync(() => files.EndRelayAsync(id, UserId, SessionId, action));

    private async Task<IActionResult> ReplyAsync<T>(Func<Task<T>> action)
    {
        try { return Ok(await action()); }
        catch (FileRelayException error) { return Problem(statusCode: error.StatusCode, title: error.Message); }
        catch (HubException error) { return Problem(statusCode: 400, title: error.Message); }
        catch (OperationCanceledException) { return Problem(statusCode: 409, title: "Phiên chuyển tiếp đã dừng."); }
        catch (IOException) { return Problem(statusCode: 409, title: "Luồng chuyển tiếp đã dừng. Hãy gửi lại tệp."); }
    }

    private async Task<IActionResult> StreamAsync(Func<Task> action)
    {
        try
        {
            await action();
            return new EmptyResult();
        }
        catch (FileRelayException error) { return Problem(statusCode: error.StatusCode, title: error.Message); }
        catch (HubException error) { return Problem(statusCode: 400, title: error.Message); }
        catch (Exception error) when (error is IOException or OperationCanceledException)
        {
            if (!Response.HasStarted && !HttpContext.RequestAborted.IsCancellationRequested)
                return Problem(statusCode: 409, title: "Luồng chuyển tiếp đã dừng. Hãy gửi lại tệp.");
            HttpContext.Abort();
            return new EmptyResult();
        }
    }
}

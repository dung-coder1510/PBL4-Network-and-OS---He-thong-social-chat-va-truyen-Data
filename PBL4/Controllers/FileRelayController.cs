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
    private string ReceiverKey => Request.Headers["X-File-Relay-Key"].ToString();

    [HttpGet("{id:long}")]
    public Task<IActionResult> Get(long id) => ReplyAsync(() => files.GetFileAsync(id, UserId));

    [HttpPost("relay"), RequestSizeLimit(8192)]
    public Task<IActionResult> Create(OfferFileDto request) =>
        ReplyAsync(() => files.OfferRelayAsync(UserId, SessionId, request));

    [HttpPost("{id:long}/relay")]
    public Task<IActionResult> Switch(long id) =>
        ReplyAsync(() => files.SwitchRelayAsync(id, UserId, SessionId));

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
    public Task<IActionResult> Upload(long id) => ReplyAsync(() =>
        files.UploadRelayAsync(id, UserId, SessionId, Request.Headers["X-File-SHA256"].ToString(),
            Request.ContentLength, Request.Body, HttpContext.RequestAborted));

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

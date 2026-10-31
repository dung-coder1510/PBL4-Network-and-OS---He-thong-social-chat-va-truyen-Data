using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using PBL4.Contracts;
using PBL4.Data;
using PBL4.Services;

namespace PBL4.Controllers;

[ApiController, Authorize]
[Route("api/v1/files")]
public sealed class FilesController(FileTransferService files, IConfiguration configuration,
    AppDbContext db) : ControllerBase
{
    [HttpGet]
    public async Task<ActionResult<FilePageDto>> List([FromQuery] long? beforeId)
    {
        if (beforeId <= 0) return BadRequest();
        return Ok(await files.ListAsync(int.Parse(User.FindFirstValue("sub")!), beforeId));
    }

    [HttpGet("configuration")]
    public IActionResult Configuration() => Ok(new
    {
        maximumFileBytes = FileTransferService.MaximumFileBytes,
        iceServers = configuration.GetSection("WebRtc:IceServers").Get<IceServer[]>() ?? []
    });

    public sealed record IceServer(string[] Urls, string? Username, string? Credential);

    // Tra lich su the file trong dung chat; nguoi ngoai nhan 404, khong tiet lo metadata.
    [HttpGet("/api/v1/conversations/{conversationId:long}/files")]
    public async Task<ActionResult<FilePageDto>> ConversationFiles(long conversationId,
        [FromQuery] long? beforeId, CancellationToken ct)
    {
        if (beforeId <= 0) return BadRequest();
        var userId = int.Parse(User.FindFirstValue("sub")!);
        if (!await db.DirectConversations.AsNoTracking().AnyAsync(c => c.Id == conversationId &&
                (c.UserAID == userId || c.UserBID == userId), ct)) return NotFound();
        return Ok(await files.ListAsync(userId, beforeId, conversationId));
    }
}

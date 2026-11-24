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
    public async Task<IActionResult> Configuration(CancellationToken ct)
    {
        var supportsDeferred = await FileTransferService.SupportsDeferredHashAsync(db, ct);
        return Ok(new
        {
            maximumFileBytes = FileTransferService.MaximumFileBytes,
            legacyMaximumFileBytes = FileTransferService.LegacyMaximumFileBytes,
            maximumFileChannels = FileTransferService.MaximumFileChannels,
            supportsParallelFileConnections = true,
            supportsWebRtcV7 = true,
            maximumParallelFileConnections = FileTransferService.MaximumParallelFileConnections,
            defaultParallelFileConnections = 2,
            v7MaxChunkBytes = 65536,
            v7BlockBytes = 1048576,
            supportsHttpFileRelay = true,
            supportsMultipartHttpRelay = true,
            relayPartBytes = FileRelayPartStore.DefaultPartBytes,
            defaultRelayConnections = 4,
            supportsDeferredRelayHash = supportsDeferred,
            maximumRelayBufferBytes = FileRelayPipe.MaximumBufferBytes,
            maximumRelayConnections = 4,
            supportsDeferredHash = supportsDeferred,
            iceServers = configuration.GetSection("WebRtc:IceServers").Get<IceServer[]>() ?? []
        });
    }

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

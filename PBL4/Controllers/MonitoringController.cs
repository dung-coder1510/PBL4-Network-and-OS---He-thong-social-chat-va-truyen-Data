using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using PBL4.Data;
using PBL4.Services;

namespace PBL4.Controllers;

// Quyền được kiểm tra ở server. Không trả hash, nội dung tin nhắn, token hoặc SDP.
[ApiController, Authorize(Policy = "Admin"), Microsoft.AspNetCore.RateLimiting.EnableRateLimiting("monitoring")]
[Route("api/v1/admin/monitoring")]
public sealed class MonitoringController(MonitoringService monitoring, AppDbContext db) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get([FromQuery] int afterUserId = 0,
        [FromQuery] long? beforeFileId = null, CancellationToken ct = default)
    {
        if (afterUserId < 0 || beforeFileId <= 0) return BadRequest();
        // Keyset pagination giới hạn 50 bản ghi; không lấy toàn bộ bảng ở mỗi lần poll.
        var users = await db.Users.AsNoTracking().Where(x => x.Id > afterUserId)
            .OrderBy(x => x.Id).Take(51)
            .Select(x => new { x.Id, x.Username, x.DisplayName, x.Role, x.IsDisabled, x.LastSeenAt }).ToListAsync(ct);
        var files = await db.FileTransfers.AsNoTracking()
            .Where(x => !beforeFileId.HasValue || x.Id < beforeFileId.Value)
            .OrderByDescending(x => x.Id).Take(51)
            .Select(x => new { Id = x.Id.ToString(), x.SenderId,
                ReceiverId = x.Conversation.UserAID == x.SenderId ? x.Conversation.UserBID : x.Conversation.UserAID,
                x.FileSizeBytes, x.Status, x.CreatedAt, x.AcceptedAt, x.FinishedAt }).ToListAsync(ct);
        return Ok(new { metrics = monitoring.Snapshot(users.Take(50).Select(x => x.Id), files.Take(50).Select(x => x.Id)), users = users.Take(50), files = files.Take(50),
            nextUserId = users.Count > 50 ? users[49].Id : (int?)null,
            nextFileId = files.Count > 50 ? files[49].Id : null });
    }
}

using System.ComponentModel.DataAnnotations;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using PBL4.Contracts;
using PBL4.Data;
using PBL4.Realtime;
using PBL4.Services;

namespace PBL4.Controllers;

[ApiController, Authorize(Policy = "Admin"), EnableRateLimiting("admin")]
[Route("api/v1/admin")]
public sealed class AdminController(AppDbContext db, AdminService admin, PresenceTracker presence,
    MonitoringService monitoring) : ControllerBase
{
    [HttpGet("overview")]
    public async Task<IActionResult> Overview(CancellationToken ct)
    {
        var counts = await db.Users.GroupBy(_ => 1).Select(g => new { Total = g.Count(), Disabled = g.Count(x => x.IsDisabled) })
            .SingleOrDefaultAsync(ct);
        var online = presence.GetOnlineUserIds();
        return Ok(new AdminOverviewDto(counts?.Total ?? 0, (counts?.Total ?? 0) - (counts?.Disabled ?? 0),
            counts?.Disabled ?? 0, await db.Users.CountAsync(x => !x.IsDisabled && online.Contains(x.Id), ct), DateTime.UtcNow));
    }

    [HttpGet("users")]
    public async Task<IActionResult> Users([FromQuery, StringLength(100)] string? search,
        [FromQuery] string? role, [FromQuery] string? state, [FromQuery] string? online,
        [FromQuery, Range(0, int.MaxValue)] int afterId = 0,
        [FromQuery, Range(1, 100)] int limit = 25, CancellationToken ct = default)
    {
        if (role is not (null or "" or "User" or "Admin") || state is not (null or "" or "enabled" or "disabled") ||
            online is not (null or "" or "online" or "offline")) return BadRequest();
        var query = db.Users.AsNoTracking();
        var term = search?.Trim();
        if (!string.IsNullOrEmpty(term)) query = query.Where(x => x.Username.Contains(term) || x.DisplayName.Contains(term));
        if (!string.IsNullOrEmpty(role)) query = query.Where(x => x.Role == role);
        if (!string.IsNullOrEmpty(state)) query = query.Where(x => x.IsDisabled == (state == "disabled"));
        if (!string.IsNullOrEmpty(online))
        {
            var ids = presence.GetOnlineUserIds();
            query = online == "online" ? query.Where(x => !x.IsDisabled && ids.Contains(x.Id))
                : query.Where(x => x.IsDisabled || !ids.Contains(x.Id));
        }
        var total = await query.CountAsync(ct);
        var rows = await query.Where(x => x.Id > afterId).OrderBy(x => x.Id).Take(limit + 1).ToListAsync(ct);
        return Ok(new AdminUserPageDto(rows.Take(limit).Select(admin.ToUser).ToArray(), rows.Count > limit ? rows[limit - 1].Id : null, total));
    }

    [HttpGet("users/{id:int}")]
    public async Task<IActionResult> UserDetail(int id, CancellationToken ct)
    {
        try
        {
            var user = await admin.GetUserAsync(id, ct);
            var logs = await AdminService.ProjectLogs(db.AdminAuditLogs.AsNoTracking().Where(x => x.TargetUserId == id)
                .OrderByDescending(x => x.CreatedAt).ThenByDescending(x => x.Id).Take(5)).ToListAsync(ct);
            return Ok(new AdminUserDetailDto(user, logs));
        }
        catch (AdminException ex) { return Failure(ex); }
    }

    [HttpGet("users/{id:int}/connections")]
    public async Task<IActionResult> UserConnections(int id, CancellationToken ct)
    {
        if (!await db.Users.AnyAsync(user => user.Id == id, ct)) return NotFound();
        return Ok(monitoring.ConnectionsFor(id));
    }

    [HttpPost("users/{id:int}/disable"), RequestSizeLimit(8192)]
    public Task<IActionResult> Disable(int id, AdminChangeRequest request, CancellationToken ct) => Change(id, request, true, ct);
    [HttpPost("users/{id:int}/enable"), RequestSizeLimit(8192)]
    public Task<IActionResult> Enable(int id, AdminChangeRequest request, CancellationToken ct) => Change(id, request, false, ct);
    private async Task<IActionResult> Change(int id, AdminChangeRequest request, bool disabled, CancellationToken ct)
    {
        try { return Ok(await admin.ChangeAsync(int.Parse(User.FindFirstValue("sub")!), User.FindFirstValue("sid")!, id, disabled, request, ct)); }
        catch (AdminException ex) { return Failure(ex); }
    }
    private ObjectResult Failure(AdminException ex) => Problem(statusCode: ex.Status, title: ex.Message,
        extensions: new Dictionary<string, object?> { ["code"] = ex.Code });

    [HttpGet("audit-logs")]
    public async Task<IActionResult> Logs([FromQuery] int? userId, [FromQuery, StringLength(100)] string? actor,
        [FromQuery, StringLength(100)] string? target,
        [FromQuery] string? action, [FromQuery] DateTimeOffset? from, [FromQuery] DateTimeOffset? to,
        [FromQuery, Range(1, long.MaxValue)] long? beforeId,
        [FromQuery, Range(1, 100)] int limit = 25, CancellationToken ct = default)
    {
        if (userId <= 0 || action is not (null or "" or "DisableUser" or "EnableUser") || from > to) return BadRequest();
        var query = db.AdminAuditLogs.AsNoTracking();
        if (userId.HasValue) query = query.Where(x => x.TargetUserId == userId.Value);
        var targetTerm = target?.Trim();
        if (!string.IsNullOrEmpty(targetTerm)) query = query.Where(x => x.TargetUser.Username.Contains(targetTerm) || x.TargetUser.DisplayName.Contains(targetTerm));
        var term = actor?.Trim();
        if (!string.IsNullOrEmpty(term)) query = query.Where(x => x.AdminUser.Username.Contains(term) || x.AdminUser.DisplayName.Contains(term));
        if (!string.IsNullOrEmpty(action)) query = query.Where(x => x.Action == action);
        if (from.HasValue) query = query.Where(x => x.CreatedAt >= from.Value.UtcDateTime);
        if (to.HasValue) query = query.Where(x => x.CreatedAt < to.Value.UtcDateTime);
        if (beforeId.HasValue)
        {
            var boundary = await query.Where(x => x.Id == beforeId).Select(x => (DateTime?)x.CreatedAt).SingleOrDefaultAsync(ct);
            if (!boundary.HasValue) return BadRequest();
            query = query.Where(x => x.CreatedAt < boundary.Value || x.CreatedAt == boundary.Value && x.Id < beforeId.Value);
        }
        var rows = await AdminService.ProjectLogs(query.OrderByDescending(x => x.CreatedAt).ThenByDescending(x => x.Id).Take(limit + 1)).ToListAsync(ct);
        return Ok(new AdminAuditPageDto(rows.Take(limit).ToArray(), rows.Count > limit ? rows[limit - 1].Id : null));
    }
}

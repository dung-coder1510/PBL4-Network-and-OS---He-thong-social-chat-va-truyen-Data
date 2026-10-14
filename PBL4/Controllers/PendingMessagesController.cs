using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using PBL4.Contracts;
using PBL4.Data;
using PBL4.Services;

namespace PBL4.Controllers;

[ApiController, Authorize]
[Route("api/v1/users/me/pending-messages")]
public sealed class PendingMessagesController(AppDbContext db) : ControllerBase
{
    [HttpGet]
    public async Task<ActionResult<MessagePageDto>> List(
        [FromQuery, Range(1, 100)] int limit = 100,
        [FromQuery] long? afterId = null,
        CancellationToken ct = default)
    {
        if (afterId <= 0)
            return Problem(statusCode: 400, title: "Con trỏ phân trang không hợp lệ.");

        var userId = int.Parse(User.FindFirstValue("sub")!, CultureInfo.InvariantCulture);
        var query = db.Messages.AsNoTracking().Where(message =>
            message.DeliveredAt == null && message.SenderId != userId &&
            (message.Conversation.UserAID == userId || message.Conversation.UserBID == userId));
        if (afterId.HasValue) query = query.Where(message => message.Id > afterId.Value);

        var rows = await query.OrderBy(message => message.Id).Take(limit + 1).ToListAsync(ct);
        var hasMore = rows.Count > limit;
        if (hasMore) rows.RemoveAt(rows.Count - 1);
        var nextCursor = hasMore
            ? rows[^1].Id.ToString(CultureInfo.InvariantCulture) : null;
        return Ok(new MessagePageDto(rows.Select(MessageService.ToDto).ToList(), nextCursor));
    }
}

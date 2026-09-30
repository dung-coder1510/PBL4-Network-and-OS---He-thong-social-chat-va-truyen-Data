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
[Route("api/v1/conversations/{conversationId:long}/messages")]
public sealed class MessagesController(AppDbContext db) : ControllerBase
{
    private int CurrentUserId => int.Parse(User.FindFirstValue("sub")!,
        CultureInfo.InvariantCulture);

    /// <summary>Lấy lịch sử mới nhất; trang trả theo thứ tự cũ đến mới để hiển thị.</summary>
    [HttpGet]
    public async Task<ActionResult<MessagePageDto>> List(long conversationId,
        [FromQuery, Range(1, 100)] int limit = 50,
        [FromQuery] long? beforeId = null, CancellationToken ct = default)
    {
        if (beforeId <= 0)
            return Problem(statusCode: 400, title: "Con trỏ phân trang không hợp lệ.");

        var userId = CurrentUserId;
        var belongs = await db.DirectConversations.AsNoTracking().AnyAsync(c =>
            c.Id == conversationId && (c.UserAID == userId || c.UserBID == userId), ct);
        if (!belongs)
            return Problem(statusCode: 404, title: "Không tìm thấy cuộc trò chuyện.");

        var query = db.Messages.AsNoTracking().Where(m => m.ConversationId == conversationId);
        if (beforeId.HasValue) query = query.Where(m => m.Id < beforeId.Value);
        var rows = await query.OrderByDescending(m => m.Id).Take(limit + 1).ToListAsync(ct);
        var hasMore = rows.Count > limit;
        if (hasMore) rows.RemoveAt(rows.Count - 1);
        var nextCursor = hasMore ? rows[^1].Id.ToString(CultureInfo.InvariantCulture) : null;
        rows.Reverse();
        return Ok(new MessagePageDto(rows.Select(MessageService.ToDto).ToList(), nextCursor));
    }
}

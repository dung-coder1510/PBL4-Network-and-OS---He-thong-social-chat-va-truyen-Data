using System.ComponentModel.DataAnnotations;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using PBL4.Contracts;
using PBL4.Data;
using PBL4.Models;
using PBL4.Realtime;

namespace PBL4.Controllers;

[ApiController, Authorize]
[Route("api/v1/conversations")]
public sealed class ConversationsController(AppDbContext db, PresenceTracker presence) : ControllerBase
{
    private int CurrentUserId => int.Parse(User.FindFirstValue("sub")!);

    // Tất cả truy vấn đọc đi qua điều kiện thành viên, kể cả tài khoản Admin.
    private IQueryable<DirectConversation> OwnConversations(int userId) =>
        db.DirectConversations.AsNoTracking().Where(c => c.UserAID == userId || c.UserBID == userId);

    private static IQueryable<ConversationDto> Project(IQueryable<DirectConversation> query, int userId) =>
        query.Select(c => new ConversationDto(c.Id.ToString(),
            new ConversationUserDto(
                c.UserAID == userId ? c.UserBID : c.UserAID,
                c.UserAID == userId ? c.UserB.Username : c.UserA.Username,
                c.UserAID == userId ? c.UserB.DisplayName : c.UserA.DisplayName,
                c.UserAID == userId ? c.UserB.AvatarPath : c.UserA.AvatarPath,
                c.UserAID == userId ? c.UserB.IsDisabled : c.UserA.IsDisabled,
                false,
                c.UserAID == userId ? c.UserB.LastSeenAt : c.UserA.LastSeenAt),
            DateTime.SpecifyKind(c.CreatedAt, DateTimeKind.Utc), c.Messages.Any(),
            c.Messages.OrderByDescending(m => m.Id)
                .Select(m => new MessageDto(
                    m.Id.ToString(), m.ClientMessageId, m.ConversationId.ToString(),
                    m.SenderId, m.Content,
                    DateTime.SpecifyKind(m.CreatedAt, DateTimeKind.Utc),
                    m.DeliveredAt.HasValue
                        ? DateTime.SpecifyKind(m.DeliveredAt.Value, DateTimeKind.Utc) : null,
                    m.ReadAt.HasValue
                        ? DateTime.SpecifyKind(m.ReadAt.Value, DateTimeKind.Utc) : null))
                .FirstOrDefault(),
            c.Messages.Count(m => m.SenderId != userId && m.ReadAt == null)));

    private ConversationDto WithPresence(ConversationDto conversation) => conversation with
    {
        Peer = conversation.Peer with
        {
            IsOnline = presence.IsOnline(conversation.Peer.Id),
            LastSeenAt = conversation.Peer.LastSeenAt.HasValue
                ? DateTime.SpecifyKind(conversation.Peer.LastSeenAt.Value, DateTimeKind.Utc) : null
        }
    };

    /// <summary>Danh sách của mình, mới tạo trước. Cursor theo BIGINT Id, tối đa 100 dòng/lần.</summary>
    [HttpGet]
    public async Task<ActionResult<ConversationPageDto>> List(
        [FromQuery, Range(1, 100)] int limit = 30,
        [FromQuery] long? beforeId = null,
        [FromQuery, StringLength(100)] string? search = null,
        CancellationToken ct = default)
    {
        if (beforeId <= 0) return Problem(statusCode: 400, title: "Con trỏ phân trang không hợp lệ.");
        var userId = CurrentUserId;
        var query = OwnConversations(userId);
        var term = search?.Trim() ?? "";
        if (term.Length > 0)
            query = query.Where(c => c.UserAID == userId
                ? c.UserB.Username.Contains(term) || c.UserB.DisplayName.Contains(term)
                : c.UserA.Username.Contains(term) || c.UserA.DisplayName.Contains(term));
        if (beforeId.HasValue) query = query.Where(c => c.Id < beforeId.Value);
        var items = await Project(query.OrderByDescending(c => c.Id).Take(limit + 1), userId).ToListAsync(ct);
        var hasMore = items.Count > limit;
        if (hasMore) items.RemoveAt(items.Count - 1);
        items = items.Select(WithPresence).ToList();
        return Ok(new ConversationPageDto(items, hasMore ? items[^1].Id : null));
    }

    /// <summary>404 cho cả ID không tồn tại và cuộc trò chuyện của người khác để không lộ dữ liệu.</summary>
    [HttpGet("{id:long}")]
    public async Task<ActionResult<ConversationDto>> Get(long id, CancellationToken ct)
    {
        var userId = CurrentUserId;
        var conversation = await Project(OwnConversations(userId).Where(c => c.Id == id), userId).SingleOrDefaultAsync(ct);
        return conversation is null ? MissingConversation() : Ok(WithPresence(conversation));
    }

    /// <summary>Tạo một cặp duy nhất. POST lặp lại hoặc hai phía tạo đồng thời đều trả cùng cuộc trò chuyện.</summary>
    [HttpPost]
    [RequestSizeLimit(1024)]
    public async Task<ActionResult<ConversationDto>> Create(CreateConversationDto request, CancellationToken ct)
    {
        var userId = CurrentUserId;
        if (request.PeerUserId == userId)
            return Problem(statusCode: 400, title: "Không thể tạo cuộc trò chuyện với chính mình.");
        // Chỉ nhận peer ID; ID người gửi luôn lấy từ JWT đã xác thực.
        if (!await db.Users.AnyAsync(u => u.Id == request.PeerUserId && !u.IsDisabled, ct))
            return Problem(statusCode: 404, title: "Người dùng không tồn tại hoặc không còn khả dụng.");
        var userA = Math.Min(userId, request.PeerUserId);
        var userB = Math.Max(userId, request.PeerUserId);
        var pair = OwnConversations(userId).Where(c => c.UserAID == userA && c.UserBID == userB);
        var existing = await Project(pair, userId).SingleOrDefaultAsync(ct);
        if (existing is not null) return Ok(WithPresence(existing));

        var conversation = new DirectConversation { UserAID = userA, UserBID = userB, CreatedAt = DateTime.UtcNow };
        db.DirectConversations.Add(conversation);
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException ex) when (ex.InnerException is SqlException { Number: 2601 or 2627 })
        {
            // Request khác đã tạo cùng cặp sau bước kiểm tra; đọc bản ghi thắng unique constraint.
            db.Entry(conversation).State = EntityState.Detached;
            var winner = await Project(pair, userId).SingleOrDefaultAsync(ct);
            if (winner is null) throw;
            return Ok(WithPresence(winner));
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqlException { Number: 547 })
        {
            // Người được chọn có thể bị xóa trong khoảng kiểm tra và INSERT.
            return Problem(statusCode: 409, title: "Thông tin người dùng đã thay đổi. Vui lòng tìm lại.");
        }
        var result = await Project(OwnConversations(userId).Where(c => c.Id == conversation.Id), userId).SingleAsync(ct);
        return CreatedAtAction(nameof(Get), new { id = conversation.Id }, WithPresence(result));
    }

    private ObjectResult MissingConversation() => Problem(statusCode: 404, title: "Không tìm thấy cuộc trò chuyện.");
}

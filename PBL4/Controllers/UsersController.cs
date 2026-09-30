using Microsoft.AspNetCore.Authorization;
using System.ComponentModel.DataAnnotations;
using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using PBL4.Auth;
using PBL4.Contracts;
using PBL4.Data;
using PBL4.Models;
using PBL4.Realtime;

namespace PBL4.Controllers;

[ApiController]
[Route("api/v1/users")]
public sealed class UsersController(AppDbContext db, PasswordService passwords,
    PresenceTracker presence) : ControllerBase
{
    /// <summary>Tìm tối đa 20 người đang hoạt động; bỏ qua chính mình. Không trả toàn bộ danh bạ khi query rỗng.</summary>
    [HttpGet, Authorize]
    public async Task<ActionResult<IReadOnlyList<ConversationUserDto>>> Search(
        [FromQuery, StringLength(100)] string? search, CancellationToken ct)
    {
        var term = search?.Trim() ?? "";
        if (term.Length < 2) return Ok(Array.Empty<ConversationUserDto>());
        var userId = int.Parse(User.FindFirstValue("sub")!);
        var users = await db.Users.AsNoTracking()
            .Where(u => u.Id != userId && !u.IsDisabled &&
                (u.Username.Contains(term) || u.DisplayName.Contains(term)))
            .OrderBy(u => u.Username).ThenBy(u => u.Id).Take(20)
            .Select(u => new ConversationUserDto(u.Id, u.Username, u.DisplayName,
                u.AvatarPath, u.IsDisabled, false, u.LastSeenAt))
            .ToListAsync(ct);
        return Ok(users.Select(user => user with
        {
            IsOnline = presence.IsOnline(user.Id),
            LastSeenAt = user.LastSeenAt.HasValue
                ? DateTime.SpecifyKind(user.LastSeenAt.Value, DateTimeKind.Utc) : null
        }).ToList());
    }

    /// <summary>Tạo tài khoản User; không nhận Role/IsDisabled/AvatarPath từ request.</summary>
    [HttpPost, AllowAnonymous, EnableRateLimiting("auth")]
    [RequestSizeLimit(8192)]
    public async Task<ActionResult<CurrentUserDto>> Register(RegisterUserDto request, CancellationToken ct)
    {
        var username = request.Username.ToLowerInvariant();
        if (await db.Users.AnyAsync(u => u.Username == username, ct)) return DuplicateUsername();

        var user = new User
        {
            Username = username,
            DisplayName = request.DisplayName.Trim(),
            Role = "User",
            IsDisabled = false,
            AvatarPath = null,
            CreatedAt = DateTime.UtcNow
        };
        user.PasswordHash = passwords.Hash(user, request.Password);
        db.Users.Add(user);
        try { await db.SaveChangesAsync(ct); }
        catch (DbUpdateException ex) when (ex.InnerException is SqlException { Number: 2601 or 2627 })
        {
            // Unique index xử lý cả hai đăng ký đồng thời dùng cùng username.
            return DuplicateUsername();
        }
        // Không tự đăng nhập sau đăng ký. Client chuyển sang form login.
        return StatusCode(StatusCodes.Status201Created, CurrentUserDto.From(user));
    }

    /// <summary>Thông tin user đã được xác thực trong SessionValidationEvents.</summary>
    [HttpGet("me"), Authorize]
    public ActionResult<CurrentUserDto> Me() =>
        Ok(CurrentUserDto.From((User)HttpContext.Items["CurrentUser"]!));

    private ObjectResult DuplicateUsername() => Problem(statusCode: 409,
        title: "Tên đăng nhập đã được sử dụng.", extensions:
        new Dictionary<string, object?> { ["code"] = "USERNAME_TAKEN" });
}


using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using PBL4.Auth;
using PBL4.Contracts;
using PBL4.Data;
using PBL4.Models;

namespace PBL4.Controllers;

[ApiController]
[Route("api/v1/users")]
public sealed class UsersController(AppDbContext db, PasswordService passwords) : ControllerBase
{
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


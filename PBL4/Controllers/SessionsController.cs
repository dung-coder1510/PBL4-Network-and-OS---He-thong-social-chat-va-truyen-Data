using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using PBL4.Auth;
using PBL4.Contracts;
using PBL4.Data;

namespace PBL4.Controllers;

[ApiController]
[Route("api/v1/sessions")]
public sealed class SessionsController(AppDbContext db, PasswordService passwords,
    TokenService tokens, SessionRegistry sessions) : ControllerBase
{
    /// <summary>Kiểm tra mật khẩu, cấp JWT 30 phút; không phân biệt user sai/password sai.</summary>
    [HttpPost, AllowAnonymous, EnableRateLimiting("auth")]
    [RequestSizeLimit(8192)]
    public async Task<ActionResult<AuthSessionDto>> Create(CreateSessionDto request, CancellationToken ct)
    {
        var username = request.Username.Trim().ToLowerInvariant();
        var user = await db.Users.SingleOrDefaultAsync(u => u.Username == username, ct);
        var verified = passwords.Verify(user, request.Password);
        if (user is null || verified == PasswordVerificationResult.Failed)
            return Problem(statusCode: 401, title: "Tên đăng nhập hoặc mật khẩu không đúng.",
                extensions: new Dictionary<string, object?> { ["code"] = "INVALID_CREDENTIALS" });
        if (user.IsDisabled)
            return Problem(statusCode: 403, title: "Tài khoản đã bị khóa.",
                extensions: new Dictionary<string, object?> { ["code"] = "ACCOUNT_DISABLED" });

        if (verified == PasswordVerificationResult.SuccessRehashNeeded)
        {
            user.PasswordHash = passwords.Hash(user, request.Password);
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateConcurrencyException)
            {
                // Không ghi đè trạng thái account nếu admin sửa trong lúc rehash.
                await db.Entry(user).ReloadAsync(ct);
                if (db.Entry(user).State == EntityState.Detached || user.IsDisabled)
                    return Unauthorized();
                if (passwords.Verify(user, request.Password) == PasswordVerificationResult.Failed)
                    return Unauthorized();
            }
        }
        return StatusCode(StatusCodes.Status201Created, tokens.Create(user, sessions));
    }

    /// <summary>Thu hồi đúng sid đang gọi; những phiên khác của user vẫn hoạt động.</summary>
    [HttpDelete("current"), Authorize]
    public IActionResult DeleteCurrent()
    {
        sessions.Revoke(User.FindFirstValue("sid")!);
        return NoContent();
    }
}


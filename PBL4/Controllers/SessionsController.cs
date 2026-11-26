using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using PBL4.Auth;
using PBL4.Contracts;
using PBL4.Data;
using PBL4.Realtime;
using PBL4.Services;

namespace PBL4.Controllers;

[ApiController]
[Route("api/v1/sessions")]
public sealed class SessionsController(AppDbContext db, PasswordService passwords,
    TokenService tokens, SessionRegistry sessions, PresenceService presence, UserAccessLock access,
    FileTransferService files, IHostEnvironment environment) : ControllerBase
{
    public const string RefreshCookieName = "pbl4_refresh";

    private CookieOptions RefreshCookieOptions(DateTimeOffset? expires = null) => new()
    {
        HttpOnly = true,
        Secure = !environment.IsDevelopment(),
        SameSite = SameSiteMode.Lax,
        Path = "/api/v1/sessions",
        IsEssential = true,
        Expires = expires,
    };

    private void AppendRefreshCookie(string refreshToken, DateTimeOffset expiresAt) =>
        Response.Cookies.Append(RefreshCookieName, refreshToken, RefreshCookieOptions(expiresAt));

    private void ClearRefreshCookie() =>
        Response.Cookies.Delete(RefreshCookieName, RefreshCookieOptions());

    /// <summary>Kiểm tra mật khẩu, cấp JWT 30 phút và cookie refresh HttpOnly; không phân biệt user sai/password sai.</summary>
    [HttpPost, AllowAnonymous, EnableRateLimiting("auth")]
    [RequestSizeLimit(8192)]
    public async Task<ActionResult<AuthSessionDto>> Create(CreateSessionDto request, CancellationToken ct)
    {
        var username = request.Username.Trim().ToLowerInvariant();
        var candidate = await db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Username == username, ct);
        using var lease = candidate is null ? null : await access.AcquireAsync(candidate.Id, ct);
        var user = candidate is null ? null : await db.Users.SingleOrDefaultAsync(u => u.Id == candidate.Id, ct);
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
        var (session, refreshToken, refreshExpiresAt) = tokens.CreateWithRefresh(user, sessions);
        AppendRefreshCookie(refreshToken, refreshExpiresAt);
        return StatusCode(StatusCodes.Status201Created, session);
    }

    /// <summary>Đổi refresh cookie HttpOnly lấy JWT mới để giữ đăng nhập khi F5 hoặc quá 30 phút.</summary>
    [HttpPost("refresh"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<ActionResult<AuthSessionDto>> Refresh(CancellationToken ct)
    {
        if (!string.Equals(Request.Headers["X-PBL4-Refresh"], "1", StringComparison.Ordinal) ||
            !Request.Cookies.TryGetValue(RefreshCookieName, out var refreshToken) ||
            string.IsNullOrWhiteSpace(refreshToken))
        {
            return Problem(statusCode: 401, title: "Cần đăng nhập",
                detail: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.",
                extensions: new Dictionary<string, object?> { ["code"] = "UNAUTHENTICATED" });
        }

        var peek = sessions.PeekRefresh(refreshToken);
        if (peek is null)
        {
            ClearRefreshCookie();
            return Problem(statusCode: 401, title: "Cần đăng nhập",
                detail: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.",
                extensions: new Dictionary<string, object?> { ["code"] = "UNAUTHENTICATED" });
        }

        var user = await db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Id == peek.UserId, ct);
        if (user is null || user.IsDisabled || user.SessionVersion != peek.SessionVersion)
        {
            sessions.Revoke(peek.SessionId);
            ClearRefreshCookie();
            return Problem(statusCode: 401, title: "Cần đăng nhập",
                detail: "Phiên đăng nhập không còn hiệu lực.",
                extensions: new Dictionary<string, object?> { ["code"] = "UNAUTHENTICATED" });
        }

        var now = DateTimeOffset.UtcNow;
        var accessExpires = now.Add(TokenService.AccessTokenLifetime);
        var refreshExpires = now.Add(TokenService.RefreshTokenLifetime);
        var refreshed = sessions.TryRefresh(refreshToken, accessExpires, refreshExpires);
        if (refreshed is null)
        {
            ClearRefreshCookie();
            return Problem(statusCode: 401, title: "Cần đăng nhập",
                detail: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.",
                extensions: new Dictionary<string, object?> { ["code"] = "UNAUTHENTICATED" });
        }

        if (refreshed.NewRefreshToken is not null)
            AppendRefreshCookie(refreshed.NewRefreshToken, refreshExpires);

        return Ok(tokens.CreateAccessToken(user, refreshed.SessionId, now, accessExpires));
    }

    /// <summary>Thu hồi đúng sid đang gọi (qua JWT hợp lệ hoặc refresh cookie khi JWT vừa hết hạn).</summary>
    [HttpDelete("current"), AllowAnonymous]
    public async Task<IActionResult> DeleteCurrent(CancellationToken ct)
    {
        string? sessionId = null;
        int? userId = null;
        var hasRefreshHeader = string.Equals(Request.Headers["X-PBL4-Refresh"], "1", StringComparison.Ordinal);

        if (User.Identity?.IsAuthenticated == true)
        {
            sessionId = User.FindFirstValue("sid");
            if (int.TryParse(User.FindFirstValue("sub"), out var parsedUserId))
                userId = parsedUserId;
        }
        else if (hasRefreshHeader)
        {
            if (Request.Cookies.TryGetValue(RefreshCookieName, out var refreshToken) &&
                !string.IsNullOrWhiteSpace(refreshToken))
            {
                var peek = sessions.PeekRefresh(refreshToken);
                if (peek is not null)
                {
                    sessionId = peek.SessionId;
                    userId = peek.UserId;
                }
            }
        }
        else
        {
            return Problem(statusCode: 401, title: "Cần đăng nhập",
                detail: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.",
                extensions: new Dictionary<string, object?> { ["code"] = "UNAUTHENTICATED" });
        }

        if (!string.IsNullOrEmpty(sessionId) && userId.HasValue)
        {
            sessions.Revoke(sessionId);
            await files.RevokeRelaySessionAsync(sessionId);
            await presence.RevokeSessionAsync(userId.Value, sessionId, ct);
        }

        ClearRefreshCookie();
        return NoContent();
    }
}


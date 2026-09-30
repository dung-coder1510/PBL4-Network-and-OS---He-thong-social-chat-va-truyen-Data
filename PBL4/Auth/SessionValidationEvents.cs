using System.Security.Claims;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using PBL4.Data;

namespace PBL4.Auth;

// Chạy sau khi kiểm tra chữ ký/issuer/audience/expiry để kiểm tra thu hồi và account.
public sealed class SessionValidationEvents(AppDbContext db, SessionRegistry sessions) : JwtBearerEvents
{
    public override Task MessageReceived(MessageReceivedContext context)
    {
        // Trình duyệt truyền token SignalR bằng query string khi WebSocket không đặt được header.
        var token = context.Request.Query["access_token"];
        if (!string.IsNullOrEmpty(token) && context.HttpContext.Request.Path.StartsWithSegments("/hubs"))
            context.Token = token;
        return Task.CompletedTask;
    }

    public override async Task TokenValidated(TokenValidatedContext context)
    {
        var sub = context.Principal?.FindFirstValue("sub");
        var sid = context.Principal?.FindFirstValue("sid");
        if (!int.TryParse(sub, out var userId) || sid is null || !sessions.IsValid(sid, userId))
        {
            context.Fail("Session is no longer valid.");
            return;
        }

        var user = await db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Id == userId,
            context.HttpContext.RequestAborted);
        if (user is null || user.IsDisabled)
        {
            sessions.Revoke(sid);
            context.Fail("Account is unavailable.");
            return;
        }

        // Dùng role hiện tại từ DB, không giữ role cũ trong JWT sau khi quyền thay đổi.
        var identity = (ClaimsIdentity)context.Principal!.Identity!;
        foreach (var claim in identity.FindAll("role").ToArray()) identity.RemoveClaim(claim);
        identity.AddClaim(new Claim("role", user.Role));
        context.HttpContext.Items["CurrentUser"] = user;
    }

    public override async Task Challenge(JwtBearerChallengeContext context)
    {
        context.HandleResponse();
        await Results.Problem(statusCode: 401, title: "Cần đăng nhập",
            detail: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.",
            extensions: new Dictionary<string, object?> { ["code"] = "UNAUTHENTICATED" })
            .ExecuteAsync(context.HttpContext);
    }

    public override Task Forbidden(ForbiddenContext context) =>
        Results.Problem(statusCode: 403, title: "Không có quyền truy cập",
            extensions: new Dictionary<string, object?> { ["code"] = "FORBIDDEN" })
            .ExecuteAsync(context.HttpContext);
}


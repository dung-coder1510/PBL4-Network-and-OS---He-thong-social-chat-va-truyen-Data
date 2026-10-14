using System.Security.Claims;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using PBL4.Auth;
using PBL4.Data;

namespace PBL4.Realtime;

public sealed class RealtimeSessionFilter(SessionRegistry sessions, AppDbContext db) : IHubFilter
{
    public async ValueTask<object?> InvokeMethodAsync(HubInvocationContext invocationContext,
        Func<HubInvocationContext, ValueTask<object?>> next)
    {
        var principal = invocationContext.Context.User;
        var sid = principal?.FindFirstValue("sid");
        var sub = principal?.FindFirstValue("sub");
        if (!int.TryParse(sub, out var userId) || sid is null ||
            !sessions.IsValid(sid, userId) ||
            !await db.Users.AsNoTracking().AnyAsync(u => u.Id == userId && !u.IsDisabled,
                invocationContext.Context.ConnectionAborted))
        {
            invocationContext.Context.Abort();
            throw new HubException("Phiên đăng nhập không còn hợp lệ.");
        }
        return await next(invocationContext);
    }
}

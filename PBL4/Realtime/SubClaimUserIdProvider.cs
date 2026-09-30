using Microsoft.AspNetCore.SignalR;

namespace PBL4.Realtime;

// JWT giữ claim "sub" nguyên tên; SignalR cần provider này để Clients.User(s) tìm đúng tài khoản.
public sealed class SubClaimUserIdProvider : IUserIdProvider
{
    public string? GetUserId(HubConnectionContext connection) =>
        connection.User?.FindFirst("sub")?.Value;
}

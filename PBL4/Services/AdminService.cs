using Microsoft.AspNetCore.SignalR;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using PBL4.Auth;
using PBL4.Contracts;
using PBL4.Data;
using PBL4.Models;
using PBL4.Realtime;

namespace PBL4.Services;

public sealed class AdminException(int status, string code, string message) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}

public sealed class AdminService(AppDbContext db, PresenceTracker presence, PresenceService presenceService,
    SessionRegistry sessions, UserAccessLock access, IHubContext<ChatHub, IChatClient> hub,
    TextPeerSessionService text, FileTransferService files, ILogger<AdminService> logger)
{
    public static IQueryable<AdminAuditDto> ProjectLogs(IQueryable<AdminAuditLog> query) => query.Select(x =>
        new AdminAuditDto(x.Id.ToString(), x.RequestId, x.AdminUserId, x.AdminUser.Username,
            x.AdminUser.DisplayName, x.TargetUserId, x.TargetUser.Username, x.TargetUser.DisplayName,
            x.Action, x.OldIsDisabled, x.NewIsDisabled, x.Reason, DateTime.SpecifyKind(x.CreatedAt, DateTimeKind.Utc)));

    public AdminUserDto ToUser(User user) => new(user.Id, user.Username, user.DisplayName, user.Role,
        user.IsDisabled, !user.IsDisabled && presence.IsOnline(user.Id), DateTime.SpecifyKind(user.CreatedAt, DateTimeKind.Utc),
        user.LastSeenAt.HasValue ? DateTime.SpecifyKind(user.LastSeenAt.Value, DateTimeKind.Utc) : null,
        Convert.ToBase64String(user.RowVersion));

    public async Task<AdminUserDto> GetUserAsync(int id, CancellationToken ct)
    {
        var user = await db.Users.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id, ct)
            ?? throw new AdminException(404, "USER_NOT_FOUND", "Không tìm thấy tài khoản.");
        return ToUser(user);
    }

    public async Task<AdminChangeResult> ChangeAsync(int actorId, string actorSession, int userId,
        bool disabled, AdminChangeRequest request, CancellationToken ct)
    {
        var reason = request.Reason.Trim();
        byte[] version;
        try { version = Convert.FromBase64String(request.ExpectedVersion); }
        catch (FormatException) { throw new AdminException(400, "INVALID_VERSION", "Phiên bản tài khoản không hợp lệ."); }
        if (request.RequestId == Guid.Empty || version.Length != 8 || reason.Length is < 1 or > 500)
            throw new AdminException(400, "INVALID_REQUEST", "Vui lòng nhập lý do hợp lệ và tải lại thông tin tài khoản.");
        var action = disabled ? "DisableUser" : "EnableUser";
        using var lease = await access.AcquireAsync(userId, ct);
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        if (!sessions.IsValid(actorSession, actorId) || !await db.Users.AsNoTracking()
                .AnyAsync(x => x.Id == actorId && x.Role == "Admin" && !x.IsDisabled, ct))
            throw new AdminException(403, "FORBIDDEN", "Bạn không còn quyền quản trị.");

        var previous = await db.AdminAuditLogs.AsNoTracking().SingleOrDefaultAsync(x =>
            x.AdminUserId == actorId && x.RequestId == request.RequestId, ct);
        if (previous is not null)
        {
            if (previous.TargetUserId != userId || previous.Action != action || previous.Reason != reason)
                throw new AdminException(400, "REQUEST_ID_REUSED", "Mã thao tác đã được dùng cho nội dung khác.");
            await transaction.RollbackAsync(CancellationToken.None);
            return await ResultAsync(previous.Id, userId, true, false, ct);
        }
        var target = await db.Users.SingleOrDefaultAsync(x => x.Id == userId, ct)
            ?? throw new AdminException(404, "USER_NOT_FOUND", "Không tìm thấy tài khoản.");
        if (target.Id == actorId || target.Role != "User")
            throw new AdminException(409, "TARGET_NOT_MANAGEABLE", "Phiên bản này chỉ xử lý tài khoản User. Vui lòng tải lại.");
        if (target.IsDisabled == disabled)
            throw new AdminException(409, "STATE_CHANGED", "Tài khoản đã ở trạng thái được yêu cầu. Vui lòng tải lại.");
        if (!target.RowVersion.SequenceEqual(version))
            throw new AdminException(409, "VERSION_CONFLICT", "Thông tin tài khoản đã thay đổi. Vui lòng tải lại trước khi xác nhận.");
        var log = new AdminAuditLog { AdminUserId = actorId, TargetUserId = userId, RequestId = request.RequestId,
            Action = action, OldIsDisabled = target.IsDisabled, NewIsDisabled = disabled, Reason = reason,
            CreatedAt = DateTime.UtcNow };
        target.IsDisabled = disabled;
        if (disabled) target.SessionVersion = checked(target.SessionVersion + 1);
        db.AdminAuditLogs.Add(log);
        try
        {
            await db.SaveChangesAsync(ct);
            // Once committing, finish the revocation even when the caller disconnects.
            try { await transaction.CommitAsync(CancellationToken.None); }
            catch
            {
                // A connection failure can make commit outcome unknown. Invalidate the
                // local sessions conservatively; the DB version protects other instances.
                if (disabled) sessions.RevokeAll(userId);
                throw;
            }
        }
        catch (DbUpdateConcurrencyException)
        {
            throw new AdminException(409, "VERSION_CONFLICT", "Thông tin tài khoản đã thay đổi. Vui lòng tải lại.");
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqlException { Number: 2601 or 2627 })
        {
            throw new AdminException(409, "REQUEST_ID_REUSED", "Mã thao tác đang được xử lý. Hãy kiểm tra lại cùng yêu cầu.");
        }

        IReadOnlyList<string> oldConnections = disabled ? presence.GetValidConnectionIds([userId]) : [];
        if (disabled) sessions.RevokeAll(userId);
        var pending = false;
        async Task Attempt(Func<Task> operation)
        {
            try { await operation(); }
            catch (Exception error) { pending = true; logger.LogWarning(error, "Account runtime cleanup pending for user {UserId}", userId); }
        }
        if (disabled)
        {
            if (oldConnections.Count > 0) await Attempt(() => hub.Clients.Clients(oldConnections).AccountUnavailable());
            await Attempt(() => presenceService.RevokeUserAsync(userId, CancellationToken.None));
            await Attempt(() => text.SweepAsync());
            await Attempt(() => files.SweepAsync());
        }
        await Attempt(async () =>
        {
            var peers = await db.DirectConversations.AsNoTracking().Where(c => c.UserAID == userId || c.UserBID == userId)
                .Select(c => c.UserAID == userId ? c.UserBID : c.UserAID)
                .Concat(db.Contacts.Where(c => c.UserId == userId).Select(c => c.ContactUserId))
                .Concat(db.Contacts.Where(c => c.ContactUserId == userId).Select(c => c.UserId)).Distinct().ToListAsync();
            var ids = presence.GetValidConnectionIds(peers);
            if (ids.Count > 0) await hub.Clients.Clients(ids).AccountAvailabilityChanged();
        });
        return await ResultAsync(log.Id, userId, false, pending, CancellationToken.None);
    }

    private async Task<AdminChangeResult> ResultAsync(long logId, int userId, bool replayed, bool pending, CancellationToken ct) =>
        new(await GetUserAsync(userId, ct), await ProjectLogs(db.AdminAuditLogs.AsNoTracking().Where(x => x.Id == logId))
            .SingleAsync(ct), replayed, pending);
}

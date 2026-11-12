using System.ComponentModel.DataAnnotations;

namespace PBL4.Contracts;

public sealed record AdminUserDto(int Id, string Username, string DisplayName, string Role,
    bool IsDisabled, bool IsOnline, DateTime CreatedAt, DateTime? LastSeenAt, string Version);
public sealed record AdminUserPageDto(IReadOnlyList<AdminUserDto> Items, int? NextCursor, int Total);
public sealed record AdminOverviewDto(int Total, int Enabled, int Disabled, int Online, DateTime UpdatedAt);
public sealed record AdminAuditDto(string Id, Guid RequestId, int AdminUserId, string AdminUsername,
    string AdminName, int TargetUserId, string TargetUsername, string TargetName, string Action,
    bool OldIsDisabled, bool NewIsDisabled, string Reason, DateTime CreatedAt);
public sealed record AdminAuditPageDto(IReadOnlyList<AdminAuditDto> Items, string? NextCursor);
public sealed record AdminUserDetailDto(AdminUserDto User, IReadOnlyList<AdminAuditDto> RecentLogs);
public sealed record AdminChangeResult(AdminUserDto User, AdminAuditDto Operation, bool Replayed,
    bool RuntimeCleanupPending);

public sealed class AdminChangeRequest
{
    public Guid RequestId { get; set; }
    [Required, StringLength(32)] public string ExpectedVersion { get; set; } = "";
    [Required, StringLength(500)] public string Reason { get; set; } = "";
}

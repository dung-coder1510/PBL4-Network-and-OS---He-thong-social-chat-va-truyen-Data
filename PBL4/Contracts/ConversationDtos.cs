using System.ComponentModel.DataAnnotations;

namespace PBL4.Contracts;

public sealed class CreateConversationDto
{
    [Range(1, int.MaxValue, ErrorMessage = "Vui lòng chọn người muốn trò chuyện.")]
    public int PeerUserId { get; set; }
}

// Chỉ công khai thông tin hiển thị, không trả entity User hoặc quyền quản trị.
public sealed record ConversationUserDto(int Id, string Username, string DisplayName,
    string? AvatarPath, bool IsDisabled, bool IsOnline, DateTime? LastSeenAt);

// BIGINT trả bằng chuỗi để JavaScript không làm tròn ID lớn hơn Number.MAX_SAFE_INTEGER.
public sealed record ConversationDto(string Id, ConversationUserDto Peer,
    DateTime CreatedAt, bool HasMessages, MessageDto? LastMessage, int UnreadCount, bool IsContact,
    ConversationFileDto? LastFile);

public sealed record ConversationFileDto(string Id, int SenderId, string FileName, DateTime CreatedAt);

public sealed record ConversationPageDto(IReadOnlyList<ConversationDto> Items, string? NextCursor);

// Sự kiện nhẹ để client tải lại DTO phù hợp với chính người đang đăng nhập.
public sealed record ConversationSubscriptionDto(string ConversationId);

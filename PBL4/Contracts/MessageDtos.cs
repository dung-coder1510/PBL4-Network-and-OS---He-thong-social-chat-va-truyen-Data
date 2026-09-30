using System.ComponentModel.DataAnnotations;

namespace PBL4.Contracts;

public sealed class SendMessageDto
{
    [Required]
    public string ConversationId { get; set; } = "";

    public Guid ClientMessageId { get; set; }

    [Required, StringLength(4000)]
    public string Content { get; set; } = "";
}

// BIGINT dùng chuỗi để JavaScript không làm tròn ID lớn hơn Number.MAX_SAFE_INTEGER.
public sealed record MessageDto(string Id, Guid ClientMessageId, string ConversationId,
    int SenderId, string Content, DateTime CreatedAt,
    DateTime? DeliveredAt, DateTime? ReadAt);

public sealed record MessagePageDto(IReadOnlyList<MessageDto> Items, string? NextCursor);

public sealed class MessageReceiptRequestDto
{
    [Required]
    public string ConversationId { get; set; } = "";

    [Required]
    public string UpToMessageId { get; set; } = "";
}

public sealed record MessageStatusDto(string ConversationId, string UpToMessageId,
    int RecipientUserId, DateTime DeliveredAt, DateTime? ReadAt);

public sealed class TypingRequestDto
{
    [Required]
    public string ConversationId { get; set; } = "";
}

public sealed record TypingStateDto(string ConversationId, int UserId, bool IsTyping);

public sealed record PresenceDto(int UserId, bool IsOnline, DateTime? LastSeenAt);

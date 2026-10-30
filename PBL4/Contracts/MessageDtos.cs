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

// BIGINT dung chuoi de JavaScript khong lam tron ID lon hon Number.MAX_SAFE_INTEGER.
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

// MessageId co gia tri: chi cap nhat dung tin do; null: receipt cong don den UpToMessageId.
// UnreadCount la so chua doc server dem lai sau exact read, khong phai so tin vua doc.
public sealed record MessageStatusDto(string ConversationId, string UpToMessageId,
    int RecipientUserId, DateTime DeliveredAt, DateTime? ReadAt, string? MessageId = null,
    int? UnreadCount = null);

public sealed class TypingRequestDto
{
    [Required]
    public string ConversationId { get; set; } = "";
}

public sealed record TypingStateDto(string ConversationId, int UserId, bool IsTyping);

public sealed record PresenceDto(int UserId, bool IsOnline, DateTime? LastSeenAt);

public sealed record HeartbeatAckDto(int IntervalSeconds);


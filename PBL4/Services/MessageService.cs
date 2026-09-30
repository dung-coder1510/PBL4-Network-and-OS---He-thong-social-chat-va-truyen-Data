using System.Globalization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using PBL4.Contracts;
using PBL4.Data;
using PBL4.Models;

namespace PBL4.Services;

public sealed record SavedMessage(MessageDto Message, int PeerUserId);

public sealed class MessageService(AppDbContext db)
{
    public async Task<SavedMessage> SaveAsync(int senderId, SendMessageDto request,
        CancellationToken ct)
    {
        if (!long.TryParse(request.ConversationId, NumberStyles.None,
                CultureInfo.InvariantCulture, out var conversationId) || conversationId <= 0)
            throw new HubException("Cuộc trò chuyện không hợp lệ.");
        if (request.ClientMessageId == Guid.Empty)
            throw new HubException("Mã tin nhắn không hợp lệ.");

        var content = request.Content?.Trim() ?? "";
        if (content.Length is < 1 or > 4000)
            throw new HubException("Tin nhắn cần từ 1 đến 4000 ký tự.");

        var conversation = await db.DirectConversations.AsNoTracking()
            .Where(c => c.Id == conversationId &&
                (c.UserAID == senderId || c.UserBID == senderId))
            .Select(c => new { c.Id, c.UserAID, c.UserBID })
            .SingleOrDefaultAsync(ct);
        if (conversation is null)
            throw new HubException("Không tìm thấy cuộc trò chuyện.");

        var existing = await db.Messages.AsNoTracking()
            .SingleOrDefaultAsync(m => m.SenderId == senderId &&
                m.ClientMessageId == request.ClientMessageId, ct);
        if (existing is not null)
            return Existing(existing, conversationId, content,
                conversation.UserAID == senderId ? conversation.UserBID : conversation.UserAID);

        var message = new Message
        {
            ClientMessageId = request.ClientMessageId,
            ConversationId = conversationId,
            SenderId = senderId,
            Content = content,
            CreatedAt = DateTime.UtcNow
        };
        db.Messages.Add(message);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqlException { Number: 2601 or 2627 })
        {
            db.Entry(message).State = EntityState.Detached;
            existing = await db.Messages.AsNoTracking().SingleOrDefaultAsync(m =>
                m.SenderId == senderId && m.ClientMessageId == request.ClientMessageId, ct);
            if (existing is null) throw;
            return Existing(existing, conversationId, content,
                conversation.UserAID == senderId ? conversation.UserBID : conversation.UserAID);
        }

        return new SavedMessage(ToDto(message),
            conversation.UserAID == senderId ? conversation.UserBID : conversation.UserAID);
    }

    private static SavedMessage Existing(Message message, long conversationId,
        string content, int peerUserId)
    {
        if (message.ConversationId != conversationId || message.Content != content)
            throw new HubException("ClientMessageId đã được dùng cho một tin nhắn khác.");
        return new SavedMessage(ToDto(message), peerUserId);
    }

    public static MessageDto ToDto(Message message) => new(
        message.Id.ToString(CultureInfo.InvariantCulture), message.ClientMessageId,
        message.ConversationId.ToString(CultureInfo.InvariantCulture), message.SenderId,
        message.Content, DateTime.SpecifyKind(message.CreatedAt, DateTimeKind.Utc),
        message.DeliveredAt.HasValue
            ? DateTime.SpecifyKind(message.DeliveredAt.Value, DateTimeKind.Utc) : null,
        message.ReadAt.HasValue
            ? DateTime.SpecifyKind(message.ReadAt.Value, DateTimeKind.Utc) : null);
}
